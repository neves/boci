"""Compile a wrapper's `if ...: raise click.UsageError(msg)` tests to JSON predicates (ticket 13).

The Engine never evaluates Python. A test compiles only when it is built from option
reads (`kwargs['x']`, `kwargs.get('x')`, a parameter name, or a local alias of one)
with this predicate set; anything else returns None and the check stays uncompiled:

    {"truthy": "x"}           Python truthiness of option x
    {"none": "x"}             x is None
    {"eq": ["x", c]}          x == c (c a constant)
    {"lowerEq": ["x", c]}     str(x).lower() == c
    {"not": p} / {"and": [p...]} / {"or": [p...]}
    {"same": [p, q]}          bool(p) == bool(q)
    true / false              constants (`'x' in kwargs` for a declared option)
"""

import ast


def aliases(fn, params):
    """Locals bound once to an option read at the top of `fn`: `x = kwargs.get('y')` -> {"x": "y"}."""
    counts = {}
    found = {}
    for node in ast.walk(fn):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            counts[node.id] = counts.get(node.id, 0) + 1
    for st in fn.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            name = option_read(st.value, params, {}, allow_pop=True)
            if name is not None:
                found[st.targets[0].id] = name
    for arg in fn.args.args + fn.args.kwonlyargs:
        if arg.arg in params and counts.get(arg.arg, 0) == 0:
            found[arg.arg] = arg.arg
    return {k: v for k, v in found.items() if counts.get(k, 0) <= 1}


def raise_tree(stmts, conds, params, local, out):
    """Collect `{"test", "message"}` for ifs that only raise click.UsageError(<constant>).

    False when any statement is something else or a test does not compile.
    """
    for st in stmts:
        if isinstance(st, ast.If):
            if not (
                raise_tree(st.body, conds + [(st.test, False)], params, local, out)
                and raise_tree(st.orelse, conds + [(st.test, True)], params, local, out)
            ):
                return False
        elif (
            isinstance(st, ast.Raise) and isinstance(st.exc, ast.Call)
            and ast.unparse(st.exc.func) == "click.UsageError"
            and len(st.exc.args) == 1 and isinstance(st.exc.args[0], ast.Constant)
            and isinstance(st.exc.args[0].value, str) and conds
        ):
            test = conjunction(conds, params, local)
            if test is None:
                return False
            out.append({"test": test, "message": st.exc.args[0].value})
        else:
            return False
    return True


def option_read(node, params, local, allow_pop=False):
    """The option `node` reads, or None."""
    if (
        isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
        and node.value.id == "kwargs" and isinstance(node.slice, ast.Constant)
        and node.slice.value in params
    ):
        return node.slice.value
    if (
        isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id == "kwargs"
        and node.func.attr in (("get", "pop") if allow_pop else ("get",))
        and not node.keywords and node.args and isinstance(node.args[0], ast.Constant)
        and node.args[0].value in params
        and (
            len(node.args) == 1
            # kwargs.get('x', None) / kwargs.pop('x', None): the same read.
            or (len(node.args) == 2 and isinstance(node.args[1], ast.Constant) and node.args[1].value is None)
        )
    ):
        return node.args[0].value
    if isinstance(node, ast.Name):
        if node.id in local:
            return local[node.id]
    return None


def compile_test(node, params, local):
    """JSON predicate for the Python test `node`, or None when it is outside the set."""
    if isinstance(node, ast.BoolOp):
        parts = [compile_test(v, params, local) for v in node.values]
        if any(p is None for p in parts):
            return None
        return {"and" if isinstance(node.op, ast.And) else "or": parts}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        inner = compile_test(node.operand, params, local)
        return None if inner is None else {"not": inner}
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        left, op, right = node.left, node.ops[0], node.comparators[0]
        if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(right, ast.Constant) and right.value is None:
            name = option_read(left, params, local)
            if name is None:
                return None
            return {"none": name} if isinstance(op, ast.Is) else {"not": {"none": name}}
        if isinstance(op, ast.In) and isinstance(left, ast.Constant) and isinstance(right, ast.Name) and right.id == "kwargs":
            return left.value in params
        if isinstance(op, ast.Eq) and isinstance(right, ast.Constant) and isinstance(right.value, str):
            name = option_read(left, params, local)
            if name is not None:
                return {"eq": [name, right.value]}
            # str(kwargs['x']).lower() == 'c'
            if (
                isinstance(left, ast.Call) and isinstance(left.func, ast.Attribute)
                and left.func.attr == "lower" and not left.args
                and isinstance(left.func.value, ast.Call)
                and isinstance(left.func.value.func, ast.Name) and left.func.value.func.id == "str"
                and len(left.func.value.args) == 1
            ):
                name = option_read(left.func.value.args[0], params, local)
                if name is not None:
                    return {"lowerEq": [name, right.value]}
            return None
        if isinstance(op, ast.Eq) and all(isinstance(s, ast.Compare) for s in (left, right)):
            a, b = compile_test(left, params, local), compile_test(right, params, local)
            return None if a is None or b is None else {"same": [a, b]}
        return None
    name = option_read(node, params, local)
    return None if name is None else {"truthy": name}


def conjunction(tests, params, local):
    """One predicate for the conjunction of the enclosing `if` tests (ast nodes)."""
    parts = []
    for test, negate in tests:
        p = compile_test(test, params, local)
        if p is None:
            return None
        parts.append({"not": p} if negate else p)
    return parts[0] if len(parts) == 1 else {"and": parts}

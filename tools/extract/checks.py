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
    {"countGt": [[x...], n]}  more than n of the options x... are not None
    true / false              constants (`'x' in kwargs` for a declared option)
"""

import ast


class FileOption(str):
    """An alias of a click.File option: the wrapper sees an open file, the Engine its path."""


def aliases(fn, params, files=()):
    """Locals bound once to an option read at the top of `fn`: `x = kwargs.get('y')` -> {"x": "y"}.

    Aliases of the click.File options in `files` are FileOption.
    """
    counts = {}
    found = {}
    for node in ast.walk(fn):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            counts[node.id] = counts.get(node.id, 0) + 1
    for st in fn.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            name = option_read(st.value, params, {}, allow_pop=True)
            if name is not None:
                found[st.targets[0].id] = FileOption(name) if name in files else name
    for arg in fn.args.args + fn.args.kwonlyargs:
        if arg.arg in params and counts.get(arg.arg, 0) == 0:
            found[arg.arg] = arg.arg
    found = {k: v for k, v in found.items() if counts.get(k, 0) <= 1}
    found.update(provided_sets(fn, params, counts))
    return found


def provided_sets(fn, params, counts):
    """Locals holding the options given, keyed by name: `{"k": "option"}` per local.

    `d = {'k': kwargs.get('x'), ...}` then `s = {k: v for k, v in six.iteritems(d) if v is not None}`,
    or `s = dict([(k, v) for k, v in kwargs.items() if v is not None])`, each optionally
    followed right away by `s.pop('k', None)`.
    """
    literals = {}
    sets = {}
    body = fn.body
    for i, st in enumerate(body):
        if not (isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name)):
            continue
        name = st.targets[0].id
        if counts.get(name, 0) != 1:
            continue
        v = st.value
        if isinstance(v, ast.Dict) and v.keys and all(
            isinstance(k, ast.Constant) and isinstance(k.value, str) for k in v.keys
        ):
            reads = [option_read(x, params, {}) for x in v.values]
            if all(r is not None for r in reads):
                literals[name] = {k.value: r for k, r in zip(v.keys, reads)}
            continue
        source = _not_none_filter(v)
        if source is None:
            continue
        if source == "kwargs":
            chosen = {p: p for p in sorted(params)}
        elif source in literals:
            chosen = dict(literals[source])
        else:
            continue
        for nxt in body[i + 1:]:
            if not (
                isinstance(nxt, ast.Expr) and isinstance(nxt.value, ast.Call)
                and isinstance(nxt.value.func, ast.Attribute) and nxt.value.func.attr == "pop"
                and isinstance(nxt.value.func.value, ast.Name) and nxt.value.func.value.id == name
                and nxt.value.args and isinstance(nxt.value.args[0], ast.Constant)
            ):
                break
            chosen.pop(nxt.value.args[0].value, None)
        sets[name] = chosen
    return sets


def _not_none_filter(node):
    """The dict a `{k: v for k, v in <src> if v is not None}` (or `dict([(k, v) ...])`) filters."""
    if (
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict"
        and len(node.args) == 1 and not node.keywords and isinstance(node.args[0], ast.ListComp)
    ):
        comp = node.args[0]
        elt = comp.elt
        if not (isinstance(elt, ast.Tuple) and len(elt.elts) == 2):
            return None
        key, value = elt.elts
    elif isinstance(node, ast.DictComp):
        comp, key, value = node, node.key, node.value
    else:
        return None
    if not (isinstance(key, ast.Name) and isinstance(value, ast.Name) and len(comp.generators) == 1):
        return None
    gen = comp.generators[0]
    if not (
        isinstance(gen.target, ast.Tuple) and [ast.unparse(e) for e in gen.target.elts] == [key.id, value.id]
        and len(gen.ifs) == 1 and ast.unparse(gen.ifs[0]) == f"{value.id} is not None"
    ):
        return None
    it = gen.iter
    if isinstance(it, ast.Call) and ast.unparse(it.func) == "six.iteritems" and len(it.args) == 1:
        src = it.args[0]
    elif isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and it.func.attr == "items" and not it.args:
        src = it.func.value
    else:
        return None
    return src.id if isinstance(src, ast.Name) else None


def _count(options, op, n):
    """`len(<options given>) <op> n` as countGt predicates."""
    gt = lambda k: {"countGt": [options, k]}  # noqa: E731
    if isinstance(op, ast.Gt):
        return gt(n)
    if isinstance(op, ast.GtE):
        return gt(n - 1)
    if isinstance(op, ast.Lt):
        return {"not": gt(n - 1)}
    if isinstance(op, ast.LtE):
        return {"not": gt(n)}
    if isinstance(op, ast.Eq):
        return {"not": gt(0)} if n == 0 else {"and": [gt(n - 1), {"not": gt(n)}]}
    if isinstance(op, ast.NotEq):
        return gt(0) if n == 0 else {"or": [{"not": gt(n - 1)}, gt(n)]}
    return None


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
        if isinstance(local.get(node.id), str):
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
    # hasattr(f, 'name'): an open file has one, so the option was given.
    if (
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "hasattr"
        and len(node.args) == 2 and isinstance(node.args[0], ast.Name)
        and isinstance(local.get(node.args[0].id), FileOption)
        and isinstance(node.args[1], ast.Constant) and node.args[1].value == "name"
    ):
        return {"not": {"none": local[node.args[0].id]}}
    if isinstance(node, ast.Name) and isinstance(local.get(node.id), dict):
        return {"countGt": [list(local[node.id].values()), 0]}
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        left, op, right = node.left, node.ops[0], node.comparators[0]
        if (
            isinstance(left, ast.Call) and isinstance(left.func, ast.Name) and left.func.id == "len"
            and len(left.args) == 1 and isinstance(left.args[0], ast.Name)
            and isinstance(local.get(left.args[0].id), dict)
            and isinstance(right, ast.Constant) and type(right.value) is int
        ):
            return _count(list(local[left.args[0].id].values()), op, right.value)
        if (
            isinstance(op, (ast.In, ast.NotIn)) and isinstance(left, ast.Constant)
            and isinstance(right, ast.Name) and isinstance(local.get(right.id), dict)
        ):
            option = local[right.id].get(left.value)
            given = False if option is None else {"not": {"none": option}}
            return given if isinstance(op, ast.In) else (True if option is None else {"none": option})
        if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(right, ast.Constant) and right.value is None:
            name = option_read(left, params, local)
            if name is None:
                return None
            return {"none": name} if isinstance(op, ast.Is) else {"not": {"none": name}}
        if isinstance(op, ast.In) and isinstance(left, ast.Constant) and isinstance(right, ast.Name) and right.id == "kwargs":
            return left.value in params
        # f.name == '<stdin>': Click opened `-`.
        if (
            isinstance(op, ast.Eq) and isinstance(left, ast.Attribute) and left.attr == "name"
            and isinstance(left.value, ast.Name) and isinstance(local.get(left.value.id), FileOption)
            and isinstance(right, ast.Constant) and right.value == "<stdin>"
        ):
            return {"eq": [str(local[left.value.id]), "-"]}
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

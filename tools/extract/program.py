"""Compile a Tier B wrapper's body to a small JSON program the Engine interprets (ticket 11).

The wrappers that fold flat options into a complex param are short, straight-line
Python over `kwargs`: dict building, `if` tests, `pop`/`del`, `json.dumps`,
`cli_util.parse_json_parameter`, `raise click.UsageError(...)`, one `ctx.invoke`.
Rather than hand-code each one, the extractor translates that subset of Python
(never executed) to JSON; anything outside it returns None and the command stays
Tier B. Module helpers called with plain names as arguments are inlined.

Statements (lists):
    ["let", name, e]              name = e
    ["set", obj, key, e]          obj[key] = e
    ["del", obj, key]             del obj[key]
    ["do", e]                     an expression statement (pop, append, ...)
    ["if", test, then, else]
    ["usage", message]            raise click.UsageError(message)
    ["raise", source, cls, e]     raise cls(e), cls one of RAISABLE (ticket 18)
    ["raise", source]             any other raise (the Engine stops)
    ["invoke", [[name, e]...], e, i?] ctx.invoke(<generated command i>, name=e..., **e);
                                  i is an expression when the command is picked at run time
    ["unpack", [name...], e]      a, b = e
    ["abort"]                     ctx.abort()
    ["for", name, e, body]        for name in e: body (no break/continue/else)

Expressions: JSON scalars are constants; lists are operations:
    ["var", name] ["item", obj, key] ["call", method, obj, args...]
    ["fn", name, args...]  (dumps, parse, str, len, bool, dict, b64encode, removeSkeleton)
    ["dict", [k, v]...] ["list", e...] ["not", e] ["and", e...] ["or", e...]
    ["cmp", op, a, b]  (== != < <= > >= is isnot in notin) ["ifexp", t, a, b]
    ["map", e, t, elt, conds?]  [elt for t in e if cond...]; t a name or a list of names
    ["dictcomp", e, t, k, v, conds]  {k: v for t in e if cond...}
    ["target", i]  a generated command (a dict value `ctx.invoke` picks: ticket 20)
    ["bin", op, a, b]  (+ -)

A wrapper may invoke several generated commands, one per variant (ticket 14): `i`
indexes the targets compile_wrapper returns, and is left out for the first.

Options typed `click.File` reach the program as open files (ticket 12): `read()`,
iterating their lines. Module-level constants (dicts, lists, strings) inline as values,
and named callback parameters are popped from kwargs first, as Click binds them.
"""

import ast
import importlib
import inspect
import textwrap

METHODS = {
    "get", "pop", "append", "setdefault", "split", "upper", "lower", "strip", "update",
    "read", "rstrip", "decode", "keys", "join", "format", "items",
}
FUNCTIONS = {
    "json.dumps": "dumps",
    "cli_util.parse_json_parameter": "parse",
    "str": "str",
    "len": "len",
    "dict": "dict",
    "bool": "bool",
    "b64encode": "b64encode",
    "base64.b64encode": "b64encode",
    "json_skeleton_utils.remove_json_skeleton_params_from_dict": "removeSkeleton",
    "six.iteritems": "items",
    "next": "next",
    "list": "list",
    "click.confirm": "confirm",
}
# Module helpers outside the subset (re.split, enumerate, return), hand-coded in the
# Engine as named functions (src/core/program.ts, ticket 20).
HAND_CODED = {
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertArgumentStringToJson": "dataflowArguments",
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertParameterStringToJson": "dataflowParameters",
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertConfigurationStringToJson": "dataflowConfiguration",
}
BINOP = {ast.Add: "+", ast.Sub: "-"}
# Exceptions a wrapper raises that cli_util.wrap_exceptions renders (ticket 18).
RAISABLE = {"ValueError", "KeyError", "Exception", "RequiredValueNotInDefaultOrUserInputError"}
CMP = {
    ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
    ast.Is: "is", ast.IsNot: "isnot", ast.In: "in", ast.NotIn: "notin",
}


class Unsupported(Exception):
    pass


def _fn_ast(fn):
    try:
        src = textwrap.dedent(inspect.getsource(inspect.unwrap(fn)))
    except (OSError, TypeError):
        return None
    tree = ast.parse(src).body
    return tree[0] if tree and isinstance(tree[0], ast.FunctionDef) else None


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.insert(0, node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.insert(0, node.id)
        return ".".join(parts)
    return None


class Compiler:
    def __init__(self, module_globals, local_names=()):
        self.globals = module_globals
        self.locals = set(local_names)  # names the callback binds; never module constants
        self.targets = []  # the generated command objects ctx.invoke targets, in order

    def stmts(self, body, scope):
        out = []
        for st in body:
            out.extend(self.stmt(st, scope))
        return out

    def name(self, ident, scope):
        return scope.get(ident, ident)

    def stmt(self, st, scope):
        if isinstance(st, ast.Pass):
            return []
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant):
            return []  # docstring / string comment
        if isinstance(st, ast.Assign) and len(st.targets) == 1:
            if isinstance(st.targets[0], ast.Attribute):
                # `some_dict.attr = x`: an AttributeError in the Reference CLI.
                return [["raise", ast.unparse(st)]]
            return [self.assign(st.targets[0], self.expr(st.value, scope), scope)]
        if isinstance(st, ast.For):
            if st.orelse or not isinstance(st.target, ast.Name):
                raise Unsupported("for")
            if any(isinstance(n, (ast.Break, ast.Continue)) for b in st.body for n in ast.walk(b)):
                raise Unsupported("for break")
            return [["for", self.name(st.target.id, scope), self.expr(st.iter, scope), self.stmts(st.body, scope)]]
        if isinstance(st, ast.Delete):
            out = []
            for t in st.targets:
                if not isinstance(t, ast.Subscript):
                    raise Unsupported("del")
                out.append(["del", self.expr(t.value, scope), self.expr(t.slice, scope)])
            return out
        if isinstance(st, ast.If):
            return [["if", self.expr(st.test, scope), self.stmts(st.body, scope), self.stmts(st.orelse, scope)]]
        if isinstance(st, ast.Raise):
            exc = st.exc
            if (
                isinstance(exc, ast.Call) and (_dotted(exc.func) or "").endswith("UsageError")
                and len(exc.args) == 1 and isinstance(exc.args[0], ast.Constant)
                and isinstance(exc.args[0].value, str)
            ):
                return [["usage", exc.args[0].value]]
            cls = (_dotted(exc.func) or "").rsplit(".", 1)[-1] if isinstance(exc, ast.Call) else ""
            if cls in RAISABLE and len(exc.args) == 1 and not exc.keywords:
                try:
                    return [["raise", ast.unparse(st), cls, self.expr(exc.args[0], scope)]]
                except Unsupported:
                    pass
            return [["raise", ast.unparse(st)]]
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call):
            call = st.value
            if isinstance(call.func, ast.Attribute) and call.func.attr == "invoke" and _dotted(call.func.value) == "ctx":
                return [self.invoke(call, scope)]
            if _dotted(call.func) == "ctx.abort" and not call.args:
                return [["abort"]]
            if isinstance(call.func, ast.Name) and call.func.id in self.globals:
                return self.inline(call, scope)
            return [["do", self.expr(call, scope)]]
        raise Unsupported(type(st).__name__)

    def assign(self, target, value, scope):
        if isinstance(target, ast.Name):
            return ["let", self.name(target.id, scope), value]
        if isinstance(target, ast.Tuple) and all(isinstance(e, ast.Name) for e in target.elts):
            return ["unpack", [self.name(e.id, scope) for e in target.elts], value]
        if isinstance(target, ast.Subscript):
            return ["set", self.expr(target.value, scope), self.expr(target.slice, scope), value]
        raise Unsupported("assign target")

    def inline(self, call, scope):
        """A module helper called with names, e.g. `process_health_checker_kwargs(kwargs)`."""
        helper = self.globals[call.func.id]
        fn = _fn_ast(helper) if inspect.isfunction(helper) else None
        if fn is None or call.keywords or fn.args.vararg or fn.args.kwarg:
            raise Unsupported("helper")
        if len(call.args) != len(fn.args.args) or not all(isinstance(a, ast.Name) for a in call.args):
            raise Unsupported("helper args")
        if any(isinstance(n, (ast.Return, ast.FunctionDef, ast.Lambda)) for st in fn.body for n in ast.walk(st)):
            raise Unsupported("helper return")
        inner = {}
        for n in ast.walk(fn):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                inner[n.id] = f"{fn.name}.{n.id}"
        for param, arg in zip(fn.args.args, call.args):
            inner[param.arg] = self.name(arg.id, scope)
        return self.stmts(fn.body, inner)

    def invoke(self, call, scope):
        if len(call.args) != 1:
            raise Unsupported("invoke args")
        target = self.resolve(call.args[0])
        index = self.expr(call.args[0], scope) if target is None else self.target_index(target)
        keywords = []
        star = None
        for kw in call.keywords:
            if kw.arg is None:
                if star is not None:
                    raise Unsupported("two **")
                star = self.expr(kw.value, scope)
            else:
                keywords.append([kw.arg, self.expr(kw.value, scope)])
        return ["invoke", keywords, star] + ([index] if index else [])

    def target_index(self, target):
        index = next((i for i, t in enumerate(self.targets) if t is target), None)
        if index is None:
            index = len(self.targets)
            self.targets.append(target)
        return index

    def comprehension(self, generators, scope):
        if len(generators) != 1:
            raise Unsupported("comprehension")
        gen = generators[0]
        if gen.is_async:
            raise Unsupported("comprehension")
        if isinstance(gen.target, ast.Name):
            target = self.name(gen.target.id, scope)
        elif isinstance(gen.target, ast.Tuple) and all(isinstance(e, ast.Name) for e in gen.target.elts):
            target = [self.name(e.id, scope) for e in gen.target.elts]
        else:
            raise Unsupported("comprehension target")
        return self.expr(gen.iter, scope), target, [self.expr(c, scope) for c in gen.ifs]

    def constant(self, value):
        """A module-level constant as an expression; anything else (a module, a function)
        is out of the subset."""
        if value is None or isinstance(value, (str, bool, int, float)):
            return value
        if isinstance(value, dict) and all(isinstance(k, str) for k in value):
            return ["dict", *([k, self.constant(v)] for k, v in value.items())]
        if isinstance(value, (list, tuple)):
            return ["list", *(self.constant(v) for v in value)]
        raise Unsupported("global")

    def hand_coded(self, func):
        """The Engine's name for a module helper it hand-codes, else None."""
        if not isinstance(func, ast.Name) or func.id in self.locals:
            return None
        fn = self.globals.get(func.id)
        if not inspect.isfunction(fn):
            return None
        return HAND_CODED.get(f"{fn.__module__}.{fn.__qualname__}")

    def resolve(self, expr):
        attrs = []
        while isinstance(expr, ast.Attribute):
            attrs.insert(0, expr.attr)
            expr = expr.value
        if not isinstance(expr, ast.Name):
            return None
        obj = self.globals.get(expr.id)
        for attr in attrs:
            obj = getattr(obj, attr, None)
        return obj if getattr(obj, "callback", None) is not None else None

    def value(self, node, scope):
        """A dict value: a generated command (`{'k': generated_cli.get_x}`) or an expression."""
        if isinstance(node, ast.Attribute):
            target = self.resolve(node)
            if target is not None:
                return ["target", self.target_index(target)]
        return self.expr(node, scope)

    def expr(self, node, scope):
        if isinstance(node, ast.Constant):
            if node.value is None or isinstance(node.value, (str, bool, int, float)):
                return node.value
            raise Unsupported("constant")
        if isinstance(node, ast.Name):
            if node.id in ("True", "False", "None"):
                return {"True": True, "False": False, "None": None}[node.id]
            if node.id not in scope and node.id not in self.locals and node.id in self.globals:
                try:
                    return self.constant(self.globals[node.id])
                except Unsupported:
                    pass  # a module or function: a NameError if the program reads it
            return ["var", self.name(node.id, scope)]
        if isinstance(node, ast.Subscript):
            return ["item", self.expr(node.value, scope), self.expr(node.slice, scope)]
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.Not):
                return ["not", self.expr(node.operand, scope)]
            if isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
                return -node.operand.value
            raise Unsupported("unary")
        if isinstance(node, ast.BoolOp):
            op = "and" if isinstance(node.op, ast.And) else "or"
            return [op, *(self.expr(v, scope) for v in node.values)]
        if isinstance(node, ast.Compare):
            if len(node.ops) != 1 or type(node.ops[0]) not in CMP:
                raise Unsupported("compare")
            return ["cmp", CMP[type(node.ops[0])], self.expr(node.left, scope), self.expr(node.comparators[0], scope)]
        if isinstance(node, ast.BinOp):
            if type(node.op) not in BINOP:
                raise Unsupported("binop")
            return ["bin", BINOP[type(node.op)], self.expr(node.left, scope), self.expr(node.right, scope)]
        if isinstance(node, ast.IfExp):
            return ["ifexp", self.expr(node.test, scope), self.expr(node.body, scope), self.expr(node.orelse, scope)]
        if isinstance(node, ast.Dict):
            if any(k is None for k in node.keys):
                raise Unsupported("dict **")
            return ["dict", *([self.expr(k, scope), self.value(v, scope)] for k, v in zip(node.keys, node.values))]
        if isinstance(node, (ast.List, ast.Tuple)):
            # A tuple only builds dict() pairs here; a list stands in for it.
            return ["list", *(self.expr(e, scope) for e in node.elts)]
        if isinstance(node, ast.ListComp):
            # Comprehension variables don't leak (Python 3), but names are unique enough.
            it, target, conds = self.comprehension(node.generators, scope)
            return ["map", it, target, self.expr(node.elt, scope)] + ([conds] if conds else [])
        if isinstance(node, ast.DictComp):
            it, target, conds = self.comprehension(node.generators, scope)
            return ["dictcomp", it, target, self.expr(node.key, scope), self.expr(node.value, scope), conds]
        if isinstance(node, ast.Call):
            if node.keywords and not (
                _dotted(node.func) == "json.dumps"
                and all(k.arg == "sort_keys" for k in node.keywords)
            ):
                raise Unsupported("call keywords")
            dotted = _dotted(node.func)
            hand = self.hand_coded(node.func)
            if hand:
                return ["fn", hand, *(self.expr(a, scope) for a in node.args)]
            if dotted in FUNCTIONS:
                args = [self.expr(a, scope) for a in node.args]
                if dotted == "json.dumps" and node.keywords:
                    sort = node.keywords[0].value
                    if not (isinstance(sort, ast.Constant) and sort.value is True):
                        raise Unsupported("sort_keys")
                    return ["fn", "dumpsSorted", *args]
                return ["fn", FUNCTIONS[dotted], *args]
            if isinstance(node.func, ast.Attribute) and node.func.attr in METHODS:
                return ["call", node.func.attr, self.expr(node.func.value, scope), *(self.expr(a, scope) for a in node.args)]
            raise Unsupported(f"call {dotted}")
        raise Unsupported(type(node).__name__)


def compile_wrapper(callback):
    """(program, the generated commands it invokes) for a Tier B wrapper, or (None, None)."""
    fn = _fn_ast(callback)
    if fn is None:
        return None, None
    module_globals = vars(importlib.import_module(callback.__module__))
    args = fn.args
    # Either **kwargs, or every option named (the body may then build its own kwargs).
    if args.vararg or (args.kwarg is not None and args.kwarg.arg != "kwargs"):
        return None, None
    named = [a.arg for a in args.args]
    if named[:1] != ["ctx"] or args.kwonlyargs or args.defaults:
        return None, None
    local_names = set(named) | {"kwargs"} | {
        n.id for n in ast.walk(fn) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
    }
    compiler = Compiler(module_globals, local_names)
    # Click binds named parameters by name; the rest stay in **kwargs.
    prelude = [["let", a, ["call", "pop", ["var", "kwargs"], a]] for a in named[1:]]
    try:
        program = prelude + compiler.stmts(fn.body, {})
    except Unsupported:
        return None, None
    if not compiler.targets:
        return None, None
    return program, compiler.targets

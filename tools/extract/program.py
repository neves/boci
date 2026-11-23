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
    ["raise", source]             any other raise (the Engine stops: ticket 18)
    ["invoke", [[name, e]...], e] ctx.invoke(<the generated command>, name=e..., **e)

Expressions: JSON scalars are constants; lists are operations:
    ["var", name] ["item", obj, key] ["call", method, obj, args...]
    ["fn", name, args...]  (dumps, parse, str, len, bool)
    ["dict", [k, v]...] ["list", e...] ["not", e] ["and", e...] ["or", e...]
    ["cmp", op, a, b]  (== != < <= > >= is isnot in notin) ["ifexp", t, a, b]
"""

import ast
import importlib
import inspect
import textwrap

METHODS = {"get", "pop", "append", "setdefault", "split", "upper", "lower", "strip", "update"}
FUNCTIONS = {
    "json.dumps": "dumps",
    "cli_util.parse_json_parameter": "parse",
    "str": "str",
    "len": "len",
    "bool": "bool",
}
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
    def __init__(self, module_globals):
        self.globals = module_globals
        self.invoked = None  # the generated command object ctx.invoke targets

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
            return [self.assign(st.targets[0], self.expr(st.value, scope), scope)]
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
            return [["raise", ast.unparse(st)]]
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call):
            call = st.value
            if isinstance(call.func, ast.Attribute) and call.func.attr == "invoke" and _dotted(call.func.value) == "ctx":
                return [self.invoke(call, scope)]
            if isinstance(call.func, ast.Name) and call.func.id in self.globals:
                return self.inline(call, scope)
            return [["do", self.expr(call, scope)]]
        raise Unsupported(type(st).__name__)

    def assign(self, target, value, scope):
        if isinstance(target, ast.Name):
            return ["let", self.name(target.id, scope), value]
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
        if target is None or (self.invoked is not None and target is not self.invoked):
            raise Unsupported("invoke target")
        self.invoked = target
        keywords = []
        star = None
        for kw in call.keywords:
            if kw.arg is None:
                if star is not None:
                    raise Unsupported("two **")
                star = self.expr(kw.value, scope)
            else:
                keywords.append([kw.arg, self.expr(kw.value, scope)])
        return ["invoke", keywords, star]

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

    def expr(self, node, scope):
        if isinstance(node, ast.Constant):
            if node.value is None or isinstance(node.value, (str, bool, int, float)):
                return node.value
            raise Unsupported("constant")
        if isinstance(node, ast.Name):
            if node.id in ("True", "False", "None"):
                return {"True": True, "False": False, "None": None}[node.id]
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
        if isinstance(node, ast.IfExp):
            return ["ifexp", self.expr(node.test, scope), self.expr(node.body, scope), self.expr(node.orelse, scope)]
        if isinstance(node, ast.Dict):
            if any(k is None for k in node.keys):
                raise Unsupported("dict **")
            return ["dict", *([self.expr(k, scope), self.expr(v, scope)] for k, v in zip(node.keys, node.values))]
        if isinstance(node, ast.List):
            return ["list", *(self.expr(e, scope) for e in node.elts)]
        if isinstance(node, ast.Call):
            if node.keywords and not (
                _dotted(node.func) == "json.dumps"
                and all(k.arg == "sort_keys" for k in node.keywords)
            ):
                raise Unsupported("call keywords")
            dotted = _dotted(node.func)
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
    """(program, invoked generated command) for a Tier B wrapper, or (None, None)."""
    fn = _fn_ast(callback)
    if fn is None:
        return None, None
    module_globals = vars(importlib.import_module(callback.__module__))
    args = fn.args
    if args.vararg or not args.kwarg or args.kwarg.arg != "kwargs":
        return None, None
    if [a.arg for a in args.args] != ["ctx"] or args.kwonlyargs:
        return None, None
    compiler = Compiler(module_globals)
    try:
        program = compiler.stmts(fn.body, {})
    except Unsupported:
        return None, None
    if compiler.invoked is None:
        return None, None
    return program, compiler.invoked

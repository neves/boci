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
    ["render", e]                 cli_util.render_response(e, ctx)
    ["unpack", [name...], e]      a, b = e
    ["abort"]                     ctx.abort()
    ["for", name, e, body]        for name in e: body (no break/continue/else)
    ["try", body, name, handler]  try: body / except Exception as name: handler (ticket 23)

`with open(path, mode) as name: body` compiles to `["let", name, ["fn", "open", path, mode]]`
then body (ticket 21): the file stays open for the invoke, which may send it as its body.

Expressions: JSON scalars are constants; lists are operations:
    ["var", name] ["item", obj, key] ["call", method, obj, args...]
    ["attr", name, e]             e.<name> (currently `.data` on an SDK response)
    ["sdk", i, client, pos, [[k, e]...], star]  client.<method>(*pos, k=e..., **star)
    ["fn", name, args...]  (dumps, parse, str, len, bool, dict, b64encode, removeSkeleton,
                            open, exists, isfile, isstr, client, namespace, ctxObj,
                            requestId)
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
import functools
import importlib
import inspect
import textwrap

METHODS = {
    "get", "pop", "append", "insert", "setdefault", "split", "upper", "lower", "strip", "update",
    "read", "rstrip", "decode", "keys", "join", "format", "items",
    "startswith", "endswith", "replace",
}
FUNCTIONS = {
    "json.dumps": "dumps",
    "cli_util.parse_json_parameter": "parse",
    "cli_util.use_or_generate_request_id": "requestId",
    "use_or_generate_request_id": "requestId",
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
    "open": "open",
    "os.path.exists": "exists",
    "os.path.isfile": "isfile",
    "os.path.expanduser": "expanduser",
    "os.path.expandvars": "expandvars",
    "time.sleep": "sleep",
    "cli_util.to_dict": "toDict",
    "cli_util.formatted_flat_dict": "formattedFlatDict",
}
# Exception types accepted in `except <type>:` handlers.
CATCHABLE = {
    "Exception": "Exception",
    "oci.exceptions.MaximumWaitTimeExceeded": "MaximumWaitTimeExceeded",
    "exceptions.MaximumWaitTimeExceeded": "MaximumWaitTimeExceeded",
    "MaximumWaitTimeExceeded": "MaximumWaitTimeExceeded",
    "oci.exceptions.ServiceError": "ServiceError",
    "exceptions.ServiceError": "ServiceError",
    "ServiceError": "ServiceError",
    "ValueError": "ValueError",
    "KeyError": "KeyError",
    "AttributeError": "AttributeError",
    "TypeError": "TypeError",
    "FileNotFoundError": "FileNotFoundError",
    "PermissionError": "PermissionError",
    "OSError": "OSError",
}


@functools.lru_cache(maxsize=None)
def _client_has_method(spec_name: str, service_name: str, attr: str) -> bool:
    """Whether the SDK client class defines callable `attr` (for `hasattr(client, ...)`)."""
    from oci_cli import dynamic_loader
    from oci_cli.cli_clients import CLIENT_MAP

    if spec_name not in CLIENT_MAP:
        dynamic_loader.load_service_dir(spec_name)
    cls = CLIENT_MAP.get(spec_name, {}).get(service_name)
    return cls is not None and hasattr(cls, attr) and callable(getattr(cls, attr, None))
# Module helpers outside the subset (re.split, enumerate, return), hand-coded in the
# Engine as named functions (src/core/program.ts, ticket 20).
HAND_CODED = {
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertArgumentStringToJson": "dataflowArguments",
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertParameterStringToJson": "dataflowParameters",
    "services.data_flow.src.oci_cli_data_flow.dataflow_cli_extended.convertConfigurationStringToJson": "dataflowConfiguration",
    # SSE-C key files: base64 key + its SHA-256, as headers or a body (ticket 23).
    "services.object_storage.src.oci_cli_object_storage.objectstorage_cli_extended._get_encryption_key_params": "sseParams",
    "services.object_storage.src.oci_cli_object_storage.objectstorage_cli_extended._get_source_encryption_key_params": "sourceSseParams",
    "services.object_storage.src.oci_cli_object_storage.objectstorage_cli_extended._get_sse_customer_key_details": "sseCustomerKey",
    # click.prompt(hide_input=True, confirmation_prompt=True) for a Rover secret (ticket 25).
    "services.rover.src.oci_cli_rover.rover_utils.prompt_for_secrets": "roverSecret",
}
BINOP = {
    ast.Add: "+",
    ast.Sub: "-",
    ast.Mult: "*",
    ast.Div: "/",
    ast.FloorDiv: "//",
    ast.Mod: "%",
}
# Exceptions a wrapper raises that cli_util.wrap_exceptions renders (ticket 18).
RAISABLE = {
    "ValueError", "KeyError", "Exception", "RequiredValueNotInDefaultOrUserInputError",
    "ClickException",
}
CMP = {
    ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
    ast.Is: "is", ast.IsNot: "isnot", ast.In: "in", ast.NotIn: "notin",
}


MAX_INLINE_DEPTH = 12
ISINSTANCE_TYPES = {
    "str": "str",
    "six.string_types": "str",
    "tuple": "tuple",
    "list": "list",
    "dict": "dict",
    "int": "int",
    "bool": "bool",
    "float": "float",
    "bytes": "bytes",
}


class Unsupported(Exception):
    """Why a wrapper is outside the subset; `source` is the innermost offending node."""

    source = None
    line = None
    node = None
    helper_fn = None


def _fn_locals(fn):
    args = fn.args
    names = (
        {a.arg for a in args.posonlyargs}
        | {a.arg for a in args.args}
        | {a.arg for a in args.kwonlyargs}
    )
    if args.vararg is not None:
        names.add(args.vararg.arg)
    if args.kwarg is not None:
        names.add(args.kwarg.arg)
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            names.add(n.id)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.add(n.name)
    return names


def _service_package(module_name):
    if module_name and module_name.startswith("services."):
        parts = module_name.split(".")
        if len(parts) >= 2:
            return ".".join(parts[:2])
    return None


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


def _blame(compile_node, node, scope):
    """Attach the innermost node that left the subset to its Unsupported (bun run triage)."""
    try:
        return compile_node(node, scope)
    except Unsupported as e:
        if e.source is None:
            e.source = ast.unparse(node)
            e.line = getattr(node, "lineno", None)
            e.node = node
        raise


class Compiler:
    def __init__(self, module_globals, local_names=(), module_name=None):
        self.globals = module_globals
        self.locals = set(local_names)  # names the callback binds; never module constants
        self.module_name = module_name or module_globals.get("__name__")
        self.service_pkg = _service_package(self.module_name)
        self.targets = []  # the generated command objects ctx.invoke targets, in order
        self.clients = {}  # scoped variable name -> (spec_name, service_name)
        self.sdk_calls = []  # (spec_name, service_name, method) called directly, in order
        self._inlining = set()
        self._inline_counts = {}
        self._temp_counter = 0

    def _fresh_temp(self, prefix="$tmp"):
        self._temp_counter += 1
        return f"{prefix}{self._temp_counter}"

    def _is_cli_util_fn(self, func, name):
        dotted = _dotted(func)
        if dotted == f"cli_util.{name}":
            return True
        if isinstance(func, ast.Name) and func.id == name and func.id not in self.locals:
            fn = self.globals.get(func.id)
            return (
                getattr(fn, "__module__", None) == "oci_cli.cli_util"
                and getattr(fn, "__name__", None) == name
            )
        return False

    def _compile_open(self, call, scope):
        if any(isinstance(a, ast.Starred) for a in call.args) or len(call.args) > 2:
            raise Unsupported("call open")
        path_node = None
        mode_node = None
        if len(call.args) >= 1:
            path_node = call.args[0]
        if len(call.args) >= 2:
            mode_node = call.args[1]
        for kw in call.keywords:
            if kw.arg == "file" and path_node is None:
                path_node = kw.value
            elif kw.arg == "mode" and mode_node is None:
                mode_node = kw.value
            else:
                raise Unsupported("call open")
        if path_node is None:
            raise Unsupported("call open")
        path_expr = self.expr(path_node, scope)
        mode_expr = self.expr(mode_node, scope) if mode_node is not None else "r"
        return ["fn", "open", path_expr, mode_expr]

    def _resolve_helper(self, func, scope):
        """Return a same-module or same-service-package Python function to inline, else None."""
        if self.hand_coded(func, scope):
            return None
        helper = None
        if isinstance(func, ast.Name):
            if func.id in scope or func.id in self.locals:
                return None
            helper = self.globals.get(func.id)
        elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id in scope or func.value.id in self.locals:
                return None
            mod = self.globals.get(func.value.id)
            if inspect.ismodule(mod):
                helper = getattr(mod, func.attr, None)
        if not inspect.isfunction(helper):
            return None
        if f"{helper.__module__}.{helper.__qualname__}" in HAND_CODED:
            return None
        helper_mod = getattr(helper, "__module__", None) or ""
        if helper_mod == self.module_name:
            return helper
        if self.service_pkg is not None and (
            helper_mod == self.service_pkg or helper_mod.startswith(self.service_pkg + ".")
        ):
            return helper
        return None

    def stmts(self, body, scope):
        out = []
        for st in body:
            out.extend(self.stmt(st, scope))
        return out

    def name(self, ident, scope):
        return scope.get(ident, ident)

    def stmt(self, st, scope):
        return _blame(self._stmt, st, scope)

    def _stmt(self, st, scope):
        if isinstance(st, ast.Pass):
            return []
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant):
            return []  # docstring / string comment
        if isinstance(st, ast.Assign):
            if len(st.targets) == 1:
                if isinstance(st.targets[0], ast.Attribute):
                    # Setting an attribute on an object (e.g. `result.data = data`); on a plain
                    # dict the Engine stops like Python's AttributeError.
                    try:
                        target_obj = self.expr(st.targets[0].value, scope)
                        value = self.expr(st.value, scope)
                        return [["setAttr", target_obj, st.targets[0].attr, value, ast.unparse(st)]]
                    except Unsupported:
                        return [["raise", ast.unparse(st)]]
                value = self.expr(st.value, scope)
                if (
                    isinstance(st.targets[0], ast.Name)
                    and isinstance(value, list) and len(value) == 4
                    and value[0] == "fn" and value[1] == "client"
                ):
                    self.clients[self.name(st.targets[0].id, scope)] = (value[2], value[3])
                return [self.assign(st.targets[0], value, scope)]
            value = self.expr(st.value, scope)
            if not isinstance(value, list):
                return [self.assign(t, value, scope) for t in st.targets]
            tmp = self._fresh_temp("$assign")
            out = [["let", tmp, value]]
            for t in st.targets:
                out.append(self.assign(t, ["var", tmp], scope))
            return out
        if isinstance(st, ast.AugAssign):
            if type(st.op) not in BINOP:
                raise Unsupported("augassign")
            op = BINOP[type(st.op)]
            val = self.expr(st.value, scope)
            if isinstance(st.target, ast.Name):
                return [["aug", op, self.name(st.target.id, scope), val]]
            if isinstance(st.target, ast.Subscript):
                return [["augItem", op, self.expr(st.target.value, scope), self.expr(st.target.slice, scope), val]]
            raise Unsupported("augassign target")
        if isinstance(st, ast.Return):
            return [["return", self.expr(st.value, scope) if st.value is not None else None]]
        if isinstance(st, ast.Break):
            return [["break"]]
        if isinstance(st, ast.Continue):
            return [["continue"]]
        if isinstance(st, ast.For):
            if st.orelse:
                raise Unsupported("for")
            if isinstance(st.target, ast.Name):
                target = self.name(st.target.id, scope)
            elif isinstance(st.target, ast.Tuple) and all(isinstance(e, ast.Name) for e in st.target.elts):
                target = [self.name(e.id, scope) for e in st.target.elts]
            else:
                raise Unsupported("for")
            return [["for", target, self.expr(st.iter, scope), self.stmts(st.body, scope)]]
        if isinstance(st, ast.Delete):
            out = []
            for t in st.targets:
                if not isinstance(t, ast.Subscript):
                    raise Unsupported("del")
                out.append(["del", self.expr(t.value, scope), self.expr(t.slice, scope)])
            return out
        if isinstance(st, ast.With):
            # `with open(path, mode=...) as f:` only; closing the file after is invisible here.
            if len(st.items) != 1:
                raise Unsupported("with")
            item = st.items[0]
            call = item.context_expr
            if not (
                isinstance(call, ast.Call) and _dotted(call.func) == "open"
                and isinstance(item.optional_vars, ast.Name)
            ):
                raise Unsupported("with")
            try:
                open_expr = self._compile_open(call, scope)
            except Unsupported:
                raise Unsupported("with")
            return [["let", self.name(item.optional_vars.id, scope), open_expr]] + self.stmts(st.body, scope)
        if isinstance(st, ast.Try):
            if st.orelse or st.finalbody or not st.handlers:
                raise Unsupported("try")
            compiled_handlers = []
            for handler in st.handlers:
                if handler.type is None:
                    exc_type = "Exception"
                else:
                    dotted = _dotted(handler.type)
                    exc_type = CATCHABLE.get(dotted)
                    if exc_type is None:
                        raise Unsupported("except")
                hname = self.name(handler.name, scope) if handler.name else None
                compiled_handlers.append([exc_type, hname, self.stmts(handler.body, scope)])
            body = self.stmts(st.body, scope)
            if len(compiled_handlers) == 1 and compiled_handlers[0][0] == "Exception":
                return [["try", body, compiled_handlers[0][1], compiled_handlers[0][2]]]
            return [["tryMulti", body, compiled_handlers]]
        if isinstance(st, ast.If):
            test = self.expr(st.test, scope)
            if test is False:
                return self.stmts(st.orelse, scope)
            if test is True:
                return self.stmts(st.body, scope)
            return [["if", test, self.stmts(st.body, scope), self.stmts(st.orelse, scope)]]
        if isinstance(st, ast.Raise):
            exc = st.exc
            if exc is None:
                return [["reraise"]]
            if (
                isinstance(exc, ast.Call) and (_dotted(exc.func) or "").endswith("UsageError")
                and len(exc.args) == 1 and not exc.keywords
            ):
                try:
                    return [["usage", self.expr(exc.args[0], scope)]]
                except Unsupported:
                    pass
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
            if (
                self._is_cli_util_fn(call.func, "render_response")
                and len(call.args) == 2
                and isinstance(call.args[1], ast.Name) and self.name(call.args[1].id, scope) == "ctx"
                and not call.keywords
            ):
                return [["render", self.expr(call.args[0], scope)]]
            if self._is_cli_util_fn(call.func, "render"):
                if any(isinstance(a, ast.Starred) for a in call.args) or len(call.args) > 5:
                    raise Unsupported("call cli_util.render")
                # render(data, headers, ctx, display_all_headers=False, nest_data_in_data_attribute=True)
                slots = [None, None, None, False, True]
                provided = set()
                ctx_node = None
                for idx, a in enumerate(call.args):
                    if idx == 2:
                        ctx_node = a
                    else:
                        slots[idx] = self.expr(a, scope)
                    provided.add(idx)
                slot_of = {
                    "data": 0,
                    "headers": 1,
                    "ctx": 2,
                    "display_all_headers": 3,
                    "nest_data_in_data_attribute": 4,
                }
                for kw in call.keywords:
                    if kw.arg not in slot_of or slot_of[kw.arg] in provided:
                        raise Unsupported("call keywords")
                    idx = slot_of[kw.arg]
                    if idx == 2:
                        ctx_node = kw.value
                    else:
                        slots[idx] = self.expr(kw.value, scope)
                    provided.add(idx)
                if not ({0, 1, 2} <= provided) or not (
                    isinstance(ctx_node, ast.Name) and self.name(ctx_node.id, scope) == "ctx"
                ):
                    raise Unsupported("call cli_util.render")
                return [["renderData", slots[0], slots[1], slots[3], slots[4]]]
            if (
                self._is_cli_util_fn(call.func, "load_context_obj_values_from_defaults")
                and len(call.args) == 1
                and isinstance(call.args[0], ast.Name) and self.name(call.args[0].id, scope) == "ctx"
                and not call.keywords
            ):
                return [["loadContextDefaults"]]
            if _dotted(call.func) == "ctx.abort" and not call.args:
                return [["abort"]]
            if _dotted(call.func) == "sys.exit":
                if len(call.args) > 1 or any(k.arg != "status" for k in call.keywords):
                    raise Unsupported("call sys.exit")
                if call.args and call.keywords:
                    raise Unsupported("call sys.exit")
                arg = self.expr(call.args[0], scope) if call.args else (
                    self.expr(call.keywords[0].value, scope) if call.keywords else None
                )
                return [["exit", arg]]
            if self.hand_coded(call.func, scope):
                return [["do", self.expr(call, scope)]]
            helper = self._resolve_helper(call.func, scope)
            if helper is not None:
                return self.inline(call, scope, as_expr=False, helper=helper)
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

    def _compile_arg(self, arg_node, scope):
        """Compile a helper call argument in the caller's scope.
        Returns (kind, value, client_pair) where kind is 'ctx' or 'expr'."""
        if isinstance(arg_node, ast.Name) and self.name(arg_node.id, scope) == "ctx":
            return ("ctx", None, None)
        target = self.resolve(arg_node)
        if target is not None:
            return ("expr", ["target", self.target_index(target)], None)
        client_pair = None
        if isinstance(arg_node, ast.Name):
            client_pair = self.clients.get(self.name(arg_node.id, scope))
        return ("expr", self.expr(arg_node, scope), client_pair)

    def _compile_default(self, default_node, helper_globals, helper_module):
        """Compile a helper parameter default expression in the helper's module scope."""
        saved = (self.globals, self.locals, self.module_name)
        self.globals = helper_globals
        self.locals = set()
        self.module_name = helper_module
        try:
            target = self.resolve(default_node)
            if target is not None:
                return ["target", self.target_index(target)]
            return self.expr(default_node, {})
        finally:
            self.globals, self.locals, self.module_name = saved

    def inline(self, call, scope, as_expr=False, helper=None):
        """Inline a same-module or same-service-package Python helper function."""
        if helper is None:
            helper = self._resolve_helper(call.func, scope)
        if helper is None:
            raise Unsupported("helper")
        label = _dotted(call.func) or getattr(helper, "__name__", "helper")
        if helper in self._inlining:
            raise Unsupported("helper recursion")
        if len(self._inlining) >= MAX_INLINE_DEPTH:
            raise Unsupported("helper depth")
        fn = _fn_ast(helper) if inspect.isfunction(helper) else None
        if fn is None or fn.args.vararg is not None:
            raise Unsupported("helper")
        if any(isinstance(a, ast.Starred) for a in call.args):
            raise Unsupported("helper args")
        if any(
            isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.Global, ast.Nonlocal))
            for st in fn.body for n in ast.walk(st)
        ):
            raise Unsupported("helper nested")

        posonly = list(fn.args.posonlyargs)
        pos_params = posonly + list(fn.args.args)
        kwonly = list(fn.args.kwonlyargs)
        posonly_names = {p.arg for p in posonly}
        kw_eligible = {p.arg for p in fn.args.args} | {p.arg for p in kwonly}
        all_params = pos_params + kwonly

        if len(call.args) > len(pos_params):
            raise Unsupported("helper args")

        # Build default AST map (defaults are evaluated in helper's module scope).
        defaults_map = {}
        if fn.args.defaults:
            offset = len(pos_params) - len(fn.args.defaults)
            for p, d in zip(pos_params[offset:], fn.args.defaults):
                defaults_map[p.arg] = d
        for p, d in zip(kwonly, fn.args.kw_defaults):
            if d is not None:
                defaults_map[p.arg] = d

        # Bind call arguments in the caller's scope before entering the helper.
        bound = {}  # param_name -> (kind, value, client_pair)
        for p, arg_node in zip(pos_params, call.args):
            bound[p.arg] = self._compile_arg(arg_node, scope)

        extra_kw_pairs = []
        star_expr = None
        for kw in call.keywords:
            if kw.arg is None:
                if star_expr is not None:
                    raise Unsupported("two **")
                star_expr = self.expr(kw.value, scope)
            elif kw.arg in bound:
                raise Unsupported("helper args")
            elif kw.arg in kw_eligible:
                bound[kw.arg] = self._compile_arg(kw.value, scope)
            elif fn.args.kwarg is not None:
                kind, val, _ = self._compile_arg(kw.value, scope)
                if kind == "ctx":
                    raise Unsupported("helper args")
                extra_kw_pairs.append([kw.arg, val])
            else:
                raise Unsupported("helper args")

        helper_globals = getattr(helper, "__globals__", self.globals)
        helper_module = getattr(helper, "__module__", self.module_name)
        helper_locals = _fn_locals(fn)

        seq = self._inline_counts.get(fn.name, 0)
        self._inline_counts[fn.name] = seq + 1
        prefix = fn.name if seq == 0 else f"{fn.name}${seq}"
        inner = {name: f"{prefix}.{name}" for name in helper_locals}

        prelude = []
        for p in all_params:
            if p.arg in bound:
                kind, val, client_pair = bound[p.arg]
                if kind == "ctx":
                    inner[p.arg] = "ctx"
                else:
                    local_p = inner[p.arg]
                    prelude.append(["let", local_p, val])
                    if client_pair is not None:
                        self.clients[local_p] = client_pair

        if star_expr is not None:
            star_var = inner[fn.args.kwarg.arg] if fn.args.kwarg is not None else f"{prefix}.$star"
            prelude.append(["let", star_var, ["fn", "dict", star_expr]])
            for k, v_expr in extra_kw_pairs:
                prelude.append(["set", ["var", star_var], k, v_expr])
            for p in all_params:
                if p.arg in bound:
                    continue
                if p.arg in posonly_names:
                    if p.arg not in defaults_map:
                        raise Unsupported("helper args")
                    d_expr = self._compile_default(defaults_map[p.arg], helper_globals, helper_module)
                    prelude.append(["let", inner[p.arg], d_expr])
                elif p.arg in defaults_map:
                    d_expr = self._compile_default(defaults_map[p.arg], helper_globals, helper_module)
                    prelude.append(["let", inner[p.arg], ["call", "pop", ["var", star_var], p.arg, d_expr]])
                else:
                    prelude.append(["let", inner[p.arg], ["call", "pop", ["var", star_var], p.arg]])
            if fn.args.kwarg is None:
                prelude.append(["checkNoExtraKwargs", fn.name, star_var])
        else:
            for p in all_params:
                if p.arg in bound:
                    continue
                if p.arg not in defaults_map:
                    raise Unsupported("helper args")
                d_expr = self._compile_default(defaults_map[p.arg], helper_globals, helper_module)
                prelude.append(["let", inner[p.arg], d_expr])
            if fn.args.kwarg is not None:
                prelude.append(["let", inner[fn.args.kwarg.arg], ["dict", *extra_kw_pairs]])

        has_return = any(isinstance(n, ast.Return) for st in fn.body for n in ast.walk(st))
        saved = (self.globals, self.locals, self.module_name)
        self.globals = helper_globals
        self.locals = helper_locals
        self.module_name = helper_module
        self._inlining.add(helper)
        try:
            body = prelude + self.stmts(fn.body, inner)
        except Unsupported as e:
            # Blame the call: the helper's own nodes aren't in the wrapper (bun run triage).
            err = Unsupported(f"helper {label}: {e}")
            err.helper_fn = helper
            raise err from e
        finally:
            self._inlining.discard(helper)
            self.globals, self.locals, self.module_name = saved
        if as_expr:
            return ["evalBlock", body]
        if has_return:
            return [["block", body]]
        return body

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

    def sdk_call_index(self, spec_name, service_name, method):
        key = (spec_name, service_name, method)
        index = next((i for i, k in enumerate(self.sdk_calls) if k == key), None)
        if index is None:
            index = len(self.sdk_calls)
            self.sdk_calls.append(key)
        return index

    def sdk_call(self, client_pair, call, scope):
        if any(isinstance(a, ast.Starred) for a in call.args):
            raise Unsupported("sdk *args")
        pos = [self.expr(a, scope) for a in call.args]
        keywords = []
        star = None
        for kw in call.keywords:
            if kw.arg is None:
                if star is not None:
                    raise Unsupported("two **")
                star = self.expr(kw.value, scope)
            else:
                keywords.append([kw.arg, self.expr(kw.value, scope)])
        op_index = self.sdk_call_index(*client_pair, call.func.attr)
        return ["sdk", op_index, self.expr(call.func.value, scope), pos, keywords, star]

    def _list_call_ref(self, node, scope):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and self.name(node.value.id, scope) in self.clients
        ):
            client_pair = self.clients[self.name(node.value.id, scope)]
            op_index = self.sdk_call_index(*client_pair, node.attr)
            return op_index, self.expr(node.value, scope)
        raise Unsupported("list_call func ref")

    def list_call_all(self, node, scope, multiple_keys):
        # list_call_get_all_results[_multiple_keys](list_func_ref, ctx=None, is_json=False, stream_output=False, **func_kwargs)
        if any(isinstance(a, ast.Starred) for a in node.args) or len(node.args) > 4:
            raise Unsupported("list_call_get_all_results args")
        ref_node = None
        ctx_node = None
        is_json = False
        stream_output = False
        provided = set()
        for idx, a in enumerate(node.args):
            provided.add(idx)
            if idx == 0:
                ref_node = a
            elif idx == 1:
                ctx_node = a
            elif idx == 2:
                is_json = self.expr(a, scope)
            elif idx == 3:
                stream_output = self.expr(a, scope)
        special = {"list_func_ref": 0, "ctx": 1, "is_json": 2, "stream_output": 3}
        keywords = []
        star = None
        for kw in node.keywords:
            if kw.arg is None:
                if star is not None:
                    raise Unsupported("two **")
                star = self.expr(kw.value, scope)
            elif kw.arg in special:
                idx = special[kw.arg]
                if idx in provided:
                    raise Unsupported("call keywords")
                provided.add(idx)
                if idx == 0:
                    ref_node = kw.value
                elif idx == 1:
                    ctx_node = kw.value
                elif idx == 2:
                    is_json = self.expr(kw.value, scope)
                elif idx == 3:
                    stream_output = self.expr(kw.value, scope)
            else:
                keywords.append([kw.arg, self.expr(kw.value, scope)])
        if ref_node is None:
            raise Unsupported("list_call_get_all_results args")
        if ctx_node is not None and not (
            (isinstance(ctx_node, ast.Constant) and ctx_node.value is None)
            or (isinstance(ctx_node, ast.Name) and self.name(ctx_node.id, scope) == "ctx")
        ):
            raise Unsupported("list_call_get_all_results ctx")
        op_index, client_expr = self._list_call_ref(ref_node, scope)
        return ["listCall", "all", multiple_keys, op_index, client_expr, [is_json, stream_output], keywords, star]

    def list_call_limit(self, node, scope, multiple_keys):
        # list_call_get_up_to_limit[_multiple_keys](list_func_ref, record_limit, page_size, **func_kwargs)
        if any(isinstance(a, ast.Starred) for a in node.args) or len(node.args) > 3:
            raise Unsupported("list_call_get_up_to_limit args")
        ref_node = None
        record_limit = None
        page_size = None
        provided = set()
        for idx, a in enumerate(node.args):
            provided.add(idx)
            if idx == 0:
                ref_node = a
            elif idx == 1:
                record_limit = self.expr(a, scope)
            elif idx == 2:
                page_size = self.expr(a, scope)
        special = {"list_func_ref": 0, "record_limit": 1, "page_size": 2}
        keywords = []
        star = None
        for kw in node.keywords:
            if kw.arg is None:
                if star is not None:
                    raise Unsupported("two **")
                star = self.expr(kw.value, scope)
            elif kw.arg in special:
                idx = special[kw.arg]
                if idx in provided:
                    raise Unsupported("call keywords")
                provided.add(idx)
                if idx == 0:
                    ref_node = kw.value
                elif idx == 1:
                    record_limit = self.expr(kw.value, scope)
                elif idx == 2:
                    page_size = self.expr(kw.value, scope)
            else:
                keywords.append([kw.arg, self.expr(kw.value, scope)])
        if not ({0, 1, 2} <= provided) or ref_node is None:
            raise Unsupported("list_call_get_up_to_limit args")
        op_index, client_expr = self._list_call_ref(ref_node, scope)
        return ["listCall", "limit", multiple_keys, op_index, client_expr, [record_limit, page_size], keywords, star]

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

    def hand_coded(self, func, scope=None):
        """The Engine's name for a module helper it hand-codes, else None."""
        scope = scope or {}
        fn = None
        if isinstance(func, ast.Name):
            if func.id in scope or func.id in self.locals:
                return None
            fn = self.globals.get(func.id)
        elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id in scope or func.value.id in self.locals:
                return None
            mod = self.globals.get(func.value.id)
            if inspect.ismodule(mod):
                fn = getattr(mod, func.attr, None)
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
        return _blame(self._expr, node, scope)

    def _expr(self, node, scope):
        if isinstance(node, ast.Constant):
            if node.value is None or isinstance(node.value, (str, bool, int, float)):
                return node.value
            raise Unsupported("constant")
        if isinstance(node, ast.Name):
            if node.id in ("True", "False", "None"):
                return {"True": True, "False": False, "None": None}[node.id]
            if node.id not in scope and node.id not in self.locals and node.id in self.globals:
                target = self.resolve(node)
                if target is not None:
                    return ["target", self.target_index(target)]
                try:
                    return self.constant(self.globals[node.id])
                except Unsupported:
                    pass  # a module or function: a NameError if the program reads it
            return ["var", self.name(node.id, scope)]
        if isinstance(node, ast.Subscript):
            if isinstance(node.slice, ast.Slice):
                lower = self.expr(node.slice.lower, scope) if node.slice.lower is not None else None
                upper = self.expr(node.slice.upper, scope) if node.slice.upper is not None else None
                step = self.expr(node.slice.step, scope) if node.slice.step is not None else None
                return ["slice", self.expr(node.value, scope), lower, upper, step]
            return ["item", self.expr(node.value, scope), self.expr(node.slice, scope)]
        if isinstance(node, ast.Attribute):
            # ctx.obj (its 'config' set by build_client) and `client.get_namespace().data`
            # (a request the Engine makes, then runs the program again): ticket 23.
            dotted = _dotted(node)
            if dotted == "sys.stderr":
                return ["fn", "stderr"]
            if dotted == "sys.stdout":
                return ["fn", "stdout"]
            if dotted == "file.name":
                return ["fn", "fileName", self.expr(node.value, scope)]
            if isinstance(node.value, ast.Name) and self.name(node.value.id, scope) == "ctx":
                if node.attr == "obj":
                    return ["fn", "ctxObj"]
                if node.attr == "default_map":
                    return ["fn", "ctxDefaultMap"]
                raise Unsupported("attribute")
            call = node.value
            if (
                node.attr == "data" and isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute) and call.func.attr == "get_namespace"
                and not call.args and not call.keywords
            ):
                return ["fn", "namespace", self.expr(call.func.value, scope)]
            # Reject SDK client method references (e.g. client.list_events) and module/global attrs.
            if isinstance(node.value, ast.Name) and self.name(node.value.id, scope) in self.clients:
                raise Unsupported("attribute")
            base = node.value
            while isinstance(base, ast.Attribute):
                base = base.value
            if isinstance(base, ast.Name) and base.id not in scope and base.id not in self.locals:
                target = self.resolve(node)
                if target is not None:
                    return ["target", self.target_index(target)]
                raise Unsupported("attribute")
            return ["attr", node.attr, self.expr(node.value, scope)]
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.Not):
                return ["not", self.expr(node.operand, scope)]
            if isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
                return -node.operand.value
            raise Unsupported("unary")
        if isinstance(node, ast.BoolOp):
            op = "and" if isinstance(node.op, ast.And) else "or"
            vals = [self.expr(v, scope) for v in node.values]
            if op == "and":
                if all(v is True for v in vals):
                    return True
                for v in vals:
                    if v is False:
                        return False
                    if v is not True:
                        break
            return [op, *vals]
        if isinstance(node, ast.Compare):
            if not node.ops or any(type(op) not in CMP for op in node.ops):
                raise Unsupported("compare")
            if len(node.ops) == 1:
                return ["cmp", CMP[type(node.ops[0])], self.expr(node.left, scope), self.expr(node.comparators[0], scope)]
            return [
                "cmpChain",
                self.expr(node.left, scope),
                [[CMP[type(op)], self.expr(comp, scope)] for op, comp in zip(node.ops, node.comparators)],
            ]
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
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                client_pair = self.clients.get(self.name(node.func.value.id, scope))
                if client_pair is not None:
                    return self.sdk_call(client_pair, node, scope)
            dotted = _dotted(node.func)
            if dotted == "cli_util.parse_json_parameter":
                # parse_json_parameter(name, value, default=None, camelize_keys=True)
                if len(node.args) < 2 or len(node.args) > 4:
                    raise Unsupported("parse_json_parameter args")
                args = [self.expr(a, scope) for a in node.args]
                if node.keywords:
                    kw_map = {}
                    for kw in node.keywords:
                        if kw.arg not in ("default", "camelize_keys") or kw.arg in kw_map:
                            raise Unsupported("call keywords")
                        kw_map[kw.arg] = self.expr(kw.value, scope)
                    if "default" in kw_map:
                        if len(args) >= 3:
                            raise Unsupported("call keywords")
                        args.append(kw_map["default"])
                    if "camelize_keys" in kw_map:
                        if len(args) >= 4:
                            raise Unsupported("call keywords")
                        while len(args) < 3:
                            args.append(None)
                        args.append(kw_map["camelize_keys"])
                return ["fn", "parse", *args]
            if dotted == "click.echo":
                # click.echo(message=None, file=None, nl=True, err=False, color=None)
                if any(isinstance(a, ast.Starred) for a in node.args) or len(node.args) > 4:
                    raise Unsupported("call click.echo")
                params = [None, None, True, False]
                set_slots = set()
                for idx, a in enumerate(node.args):
                    params[idx] = self.expr(a, scope)
                    set_slots.add(idx)
                slot_of = {"message": 0, "file": 1, "nl": 2, "err": 3}
                for kw in node.keywords:
                    if kw.arg == "color":
                        continue
                    if kw.arg not in slot_of or slot_of[kw.arg] in set_slots:
                        raise Unsupported("call keywords")
                    params[slot_of[kw.arg]] = self.expr(kw.value, scope)
                    set_slots.add(slot_of[kw.arg])
                return ["fn", "echo", *params]
            if dotted == "print":
                if any(isinstance(a, ast.Starred) for a in node.args):
                    raise Unsupported("call print")
                items = [self.expr(a, scope) for a in node.args]
                sep, end, file_arg = None, None, None
                seen = set()
                for kw in node.keywords:
                    if kw.arg == "flush":
                        continue
                    if kw.arg not in ("sep", "end", "file") or kw.arg in seen:
                        raise Unsupported("call keywords")
                    seen.add(kw.arg)
                    val = self.expr(kw.value, scope)
                    if kw.arg == "sep":
                        sep = val
                    elif kw.arg == "end":
                        end = val
                    elif kw.arg == "file":
                        file_arg = val
                return ["fn", "print", ["list", *items], sep, end, file_arg]
            if isinstance(node.func, ast.Attribute) and node.func.attr == "format":
                if any(isinstance(a, ast.Starred) for a in node.args):
                    raise Unsupported("call str.format")
                pos = [self.expr(a, scope) for a in node.args]
                if not node.keywords:
                    return ["call", "format", self.expr(node.func.value, scope), *pos]
                keywords = []
                star = None
                for kw in node.keywords:
                    if kw.arg is None:
                        if star is not None:
                            raise Unsupported("two **")
                        star = self.expr(kw.value, scope)
                    else:
                        keywords.append([kw.arg, self.expr(kw.value, scope)])
                return ["format", self.expr(node.func.value, scope), pos, keywords, star]
            if self._is_cli_util_fn(node.func, "list_call_get_all_results"):
                return self.list_call_all(node, scope, False)
            if self._is_cli_util_fn(node.func, "list_call_get_all_results_multiple_keys"):
                return self.list_call_all(node, scope, True)
            if self._is_cli_util_fn(node.func, "list_call_get_up_to_limit"):
                return self.list_call_limit(node, scope, False)
            if self._is_cli_util_fn(node.func, "list_call_get_up_to_limit_multiple_keys"):
                return self.list_call_limit(node, scope, True)
            if dotted == "oci.wait_until":
                if any(isinstance(a, ast.Starred) for a in node.args):
                    raise Unsupported("call oci.wait_until")
                pos = [self.expr(a, scope) for a in node.args]
                keywords = []
                star = None
                for kw in node.keywords:
                    if kw.arg is None:
                        if star is not None:
                            raise Unsupported("two **")
                        star = self.expr(kw.value, scope)
                    else:
                        keywords.append([kw.arg, self.expr(kw.value, scope)])
                return ["waitUntil", pos, keywords, star]
            if dotted == "open":
                return self._compile_open(node, scope)
            hand = self.hand_coded(node.func, scope)
            if hand and not node.keywords:
                return ["fn", hand, *(self.expr(a, scope) for a in node.args)]
            helper = self._resolve_helper(node.func, scope)
            if helper is not None:
                return self.inline(node, scope, as_expr=True, helper=helper)
            if node.keywords and not (
                dotted == "json.dumps"
                and all(k.arg == "sort_keys" for k in node.keywords)
            ):
                raise Unsupported("call keywords")
            if dotted == "isinstance" and len(node.args) == 2:
                type_arg = node.args[1]
                t_dotted = _dotted(type_arg)
                if t_dotted == "six.string_types" or t_dotted == "str":
                    return ["fn", "isstr", self.expr(node.args[0], scope)]
                if t_dotted in ISINSTANCE_TYPES:
                    return ["fn", "isinstance", self.expr(node.args[0], scope), ISINSTANCE_TYPES[t_dotted]]
                if isinstance(type_arg, ast.Tuple) and type_arg.elts:
                    mapped = [ISINSTANCE_TYPES.get(_dotted(elt)) for elt in type_arg.elts]
                    if all(m is not None for m in mapped):
                        return ["fn", "isinstance", self.expr(node.args[0], scope), ["list", *mapped]]
            if dotted == "hasattr" and len(node.args) == 2 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
                if isinstance(node.args[0], ast.Name):
                    client_pair = self.clients.get(self.name(node.args[0].id, scope))
                    if client_pair is not None:
                        return _client_has_method(*client_pair, node.args[1].value)
                if node.args[1].value == "name":
                    return ["fn", "hasName", self.expr(node.args[0], scope)]
            if (
                dotted == "callable" and len(node.args) == 1
                and isinstance(node.args[0], ast.Call)
                and _dotted(node.args[0].func) == "getattr"
                and len(node.args[0].args) == 2 and not node.args[0].keywords
                and isinstance(node.args[0].args[0], ast.Name)
                and isinstance(node.args[0].args[1], ast.Constant)
                and isinstance(node.args[0].args[1].value, str)
            ):
                client_pair = self.clients.get(self.name(node.args[0].args[0].id, scope))
                if client_pair is not None:
                    return _client_has_method(*client_pair, node.args[0].args[1].value)
            if dotted == "os.path.basename" and len(node.args) == 1:
                return ["fn", "basename", self.expr(node.args[0], scope)]
            if dotted in ("build_client", "cli_util.build_client"):
                # build_client(service, client, ctx): only which client it builds matters.
                if len(node.args) != 3 or not all(isinstance(a, ast.Constant) for a in node.args[:2]):
                    raise Unsupported("build_client")
                return ["fn", "client", node.args[0].value, node.args[1].value]
            if self._is_cli_util_fn(node.func, "to_dict") and len(node.args) == 1:
                return ["fn", "toDict", self.expr(node.args[0], scope)]
            if self._is_cli_util_fn(node.func, "formatted_flat_dict") and len(node.args) == 1:
                return ["fn", "formattedFlatDict", self.expr(node.args[0], scope)]
            if (
                self._is_cli_util_fn(node.func, "get_tenancy_from_config")
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Name)
                and self.name(node.args[0].id, scope) == "ctx"
            ):
                return ["fn", "tenancyFromConfig"]
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
    """(program, invoked generated commands, direct SDK calls) or (None, None, None)."""
    try:
        return _compile_wrapper(callback)
    except Unsupported:
        return None, None, None


def why_unsupported(callback):
    """The Unsupported that keeps a wrapper out of the subset, or None (bun run triage)."""
    try:
        _compile_wrapper(callback)
    except Unsupported as e:
        return e
    return None


def _compile_wrapper(callback):
    fn = _fn_ast(callback)
    if fn is None:
        raise Unsupported("no source")
    module_globals = vars(importlib.import_module(callback.__module__))
    args = fn.args
    # Either **kwargs, or every option named (the body may then build its own kwargs).
    if args.vararg or (args.kwarg is not None and args.kwarg.arg != "kwargs"):
        raise Unsupported("signature: *args or **<not kwargs>")
    named = [a.arg for a in args.args]
    if named[:1] != ["ctx"] or args.kwonlyargs or args.defaults:
        raise Unsupported("signature: no ctx, keyword-only args or defaults")
    local_names = _fn_locals(fn) | {"kwargs"}
    compiler = Compiler(module_globals, local_names, module_name=callback.__module__)
    # Click binds named parameters by name; the rest stay in **kwargs.
    prelude = [["let", a, ["call", "pop", ["var", "kwargs"], a]] for a in named[1:]]
    if args.kwarg is None:
        prelude.append(["checkNoExtraKwargs", fn.name])
    if (callback.__module__, fn.name) == (
        "services.generative_ai_sandbox.src.oci_cli_generative_ai_sandbox.generative_ai_sandbox_cli_extended",
        "write_sandbox_file_extended",
    ):
        # Click files in the Engine are already buffered and seekable, including stdin.
        # Replace the ExitStack's stream preparation; compile its actual delegate call.
        stack = fn.body[-1]
        if not isinstance(stack, ast.With) or not isinstance(stack.body[-1], ast.Expr):
            raise Unsupported("sandbox file wrapper")
        kwargs = ["var", "kwargs"]
        program = prelude + compiler.stmts(fn.body[:-1], {}) + [
            ["set", kwargs, "file", ["fn", "sandboxFile", ["var", "local_file"], ["item", kwargs, "file"]]],
            compiler.invoke(stack.body[-1].value, {}),
        ]
    else:
        program = prelude + compiler.stmts(fn.body, {})
    if not compiler.targets and not compiler.sdk_calls:
        raise Unsupported("no ctx.invoke (calls the SDK directly)")
    return program, compiler.targets, compiler.sdk_calls

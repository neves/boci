"""Tag Tier B wrapper callbacks with the logic patterns they use (ticket 10).

A Tier B callback calls `ctx.invoke` but does more than rename keyword arguments.
Its source is parsed with `ast` (never executed) and every statement, including
module-level helpers it calls with `kwargs`, is matched against a fixed set of
patterns. Besides the pattern names, what can be learned declaratively is kept:
the invoked generated commands, the usage checks (condition + message), the
options folded into a complex param, and the options read from a file.
"""

import ast
import importlib
import inspect
import textwrap

# Pattern names, in report order. See .scratch/remaining-commands/tier-b-report.md.
PATTERNS = (
    "kwargs-del",  # `del kwargs['x']`: a rename/drop Tier A does not accept yet
    "blank-check",  # 'Parameter --x cannot be whitespace or empty string'
    "usage-error",  # other click.UsageError raises
    "raise-other",  # raises something other than click.UsageError
    "fold-body",  # flat options assembled into a complex param (dict building)
    "parse-json",  # cli_util.parse_json_parameter
    "json-dumps",  # json.dumps re-serializing a complex param
    "file-read",  # open()/.read()/click.File: an option names a file
    "base64",  # base64-encodes a value
    "multi-invoke",  # several ctx.invoke calls (variants or several requests)
    "invoke-not-last",  # statements after ctx.invoke, or its result is used
    "direct-client",  # cli_util.build_client: SDK calls besides the invoked command
    "computed-value",  # a kwarg computed by an expression (not / comparisons / arithmetic)
    "output",  # prints or renders on its own (click.echo, cli_util.render*)
    "wait",  # its own waiter / polling
    "helper",  # delegates part of the logic to a module helper function
)


def _callback_ast(fn):
    try:
        src = textwrap.dedent(inspect.getsource(inspect.unwrap(fn)))
    except (OSError, TypeError):
        return None
    tree = ast.parse(src).body
    return tree[0] if tree and isinstance(tree[0], (ast.FunctionDef, ast.AsyncFunctionDef)) else None


def _chain(node):
    """kwargs['a']['b'] -> ("kwargs", ["a", "b"]); None unless constant keys on a Name."""
    keys = []
    while isinstance(node, ast.Subscript):
        if not isinstance(node.slice, ast.Constant):
            return None
        keys.insert(0, node.slice.value)
        node = node.value
    return (node.id, keys) if isinstance(node, ast.Name) and keys else None


def _kwarg_refs(node, params):
    """Options read in `node`: kwargs['x'], kwargs.get('x'), kwargs.pop('x') or a bare param name."""
    found = []
    for n in ast.walk(node):
        name = None
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == "kwargs":
            if isinstance(n.slice, ast.Constant) and isinstance(n.slice.value, str):
                name = n.slice.value
        elif (
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and isinstance(n.func.value, ast.Name) and n.func.value.id == "kwargs"
            and n.func.attr in ("get", "pop") and n.args
            and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str)
        ):
            name = n.args[0].value
        elif isinstance(n, ast.Name) and n.id in params:
            name = n.id
        if name and name in params and name not in found:
            found.append(name)
    return found


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.insert(0, node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.insert(0, node.id)
        return ".".join(parts)
    return None


def _calls(node, dotted):
    return any(isinstance(n, ast.Call) and _dotted(n.func) == dotted for n in ast.walk(node))


def survey(cmd):
    """Return (patterns, details) for one Tier B Click command."""
    import click

    callback = cmd.callback
    params = {p.name for p in cmd.params}
    fn = _callback_ast(callback)
    if fn is None:
        return [], {}
    module = importlib.import_module(callback.__module__)
    module_globals = vars(module)
    found = set()
    invokes = []
    checks = []
    folds = []
    # click.File options arrive already opened; the wrapper reads them.
    files = [p.name for p in cmd.params if isinstance(p.type, click.File)]
    if files:
        found.add("file-read")
    helpers = []

    def resolve(expr):
        """Dotted name of an invoked Click command, resolved to its callback when possible."""
        attrs = []
        node = expr
        while isinstance(node, ast.Attribute):
            attrs.insert(0, node.attr)
            node = node.value
        if not isinstance(node, ast.Name):
            return ast.unparse(expr)
        obj = module_globals.get(node.id)
        for attr in attrs:
            obj = getattr(obj, attr, None)
        cb = getattr(obj, "callback", None)
        return f"{cb.__module__}.{cb.__qualname__}" if cb else ast.unparse(expr)

    local_folds = {}  # local dict variable -> [(path, sources, json)]

    def add_fold(target, path, value):
        sources = _kwarg_refs(value, params)
        is_json = _calls(value, "cli_util.parse_json_parameter")
        fold = {"target": target, "path": path, "options": sources}
        if is_json:
            fold["json"] = True
        if not sources and isinstance(value, ast.Constant):
            fold["value"] = value.value
        if sources or "value" in fold:
            folds.append(fold)

    def collect_checks(stmts, conds):
        for st in stmts:
            if isinstance(st, ast.If):
                test = ast.unparse(st.test)
                collect_checks(st.body, conds + [test])
                collect_checks(st.orelse, conds + [f"not ({test})"])
            elif isinstance(st, (ast.With, ast.For, ast.Try)):
                collect_checks(st.body, conds)
            elif (
                isinstance(st, ast.Raise) and isinstance(st.exc, ast.Call)
                and (_dotted(st.exc.func) or "").endswith("UsageError") and st.exc.args
            ):
                a = st.exc.args[0]
                when = " and ".join(f"({c})" if len(conds) > 1 else c for c in conds)
                checks.append({
                    "when": when,
                    "options": list(dict.fromkeys(
                        o for c in conds for o in _kwarg_refs(ast.parse(c, mode="eval"), params)
                    )),
                    "message": a.value if isinstance(a, ast.Constant) else ast.unparse(a),
                })

    def visit(stmts, fn_node, seen):
        for st in stmts:
            for n in ast.walk(st):
                if isinstance(n, ast.Delete):
                    for t in n.targets:
                        c = _chain(t)
                        if c and c[0] == "kwargs":
                            found.add("kwargs-del")
                if isinstance(n, ast.Raise) and n.exc is not None:
                    exc = n.exc.func if isinstance(n.exc, ast.Call) else n.exc
                    name = _dotted(exc) or ""
                    msg = None
                    if isinstance(n.exc, ast.Call) and n.exc.args:
                        a = n.exc.args[0]
                        msg = a.value if isinstance(a, ast.Constant) else ast.unparse(a)
                    if name.endswith("UsageError"):
                        if isinstance(msg, str) and msg.endswith("cannot be whitespace or empty string"):
                            found.add("blank-check")
                        else:
                            found.add("usage-error")
                    else:
                        found.add("raise-other")
                if isinstance(n, ast.Call):
                    d = _dotted(n.func) or ""
                    if d == "cli_util.parse_json_parameter":
                        found.add("parse-json")
                    elif d == "json.dumps":
                        found.add("json-dumps")
                    elif d == "open" or (isinstance(n.func, ast.Attribute) and n.func.attr == "read"):
                        found.add("file-read")
                        for name in _kwarg_refs(n, params):
                            if name not in files:
                                files.append(name)
                    elif d.startswith("base64."):
                        found.add("base64")
                    elif d == "cli_util.build_client":
                        found.add("direct-client")
                    elif d == "click.echo" or d.startswith("cli_util.render"):
                        found.add("output")
                    elif "wait" in d.lower() or d.endswith("poll"):
                        found.add("wait")
                    elif isinstance(n.func, ast.Attribute) and n.func.attr == "invoke" and n.args:
                        invokes.append(resolve(n.args[0]))
                    elif isinstance(n.func, ast.Name) and n.func.id not in seen:
                        helper = module_globals.get(n.func.id)
                        if (
                            inspect.isfunction(helper)
                            and getattr(helper, "__module__", "").startswith("services.")
                        ):
                            h = _callback_ast(helper)
                            if h is not None:
                                found.add("helper")
                                helpers.append(n.func.id)
                                visit(h.body, h, seen | {n.func.id})
            # Usage checks: `raise click.UsageError(<msg>)` under the conjunction of its enclosing ifs.
            collect_checks([st], [])
            # Folding: kwargs['t'][...] = v; kwargs['t'] = {..} / json.dumps(local); local[...] = v.
            for n in ast.walk(st):
                if not (isinstance(n, ast.Assign) and len(n.targets) == 1):
                    continue
                c = _chain(n.targets[0])
                v = n.value
                if isinstance(v, (ast.UnaryOp, ast.BinOp, ast.BoolOp, ast.Compare, ast.IfExp)) and c and c[0] == "kwargs":
                    found.add("computed-value")
                if c and c[0] == "kwargs" and len(c[1]) >= 2:
                    found.add("fold-body")
                    add_fold(c[1][0], c[1][1:], v)
                elif c and c[0] == "kwargs" and len(c[1]) == 1:
                    target = c[1][0]
                    if isinstance(v, ast.Dict) and v.keys:
                        found.add("fold-body")
                        for k, val in zip(v.keys, v.values):
                            if isinstance(k, ast.Constant):
                                add_fold(target, [k.value], val)
                    for name in {x.id for x in ast.walk(v) if isinstance(x, ast.Name)} & local_folds.keys():
                        found.add("fold-body")
                        for path, val in local_folds.pop(name):
                            add_fold(target, path, val)
                elif c and c[0] != "kwargs" and c[0] not in params:
                    local_folds.setdefault(c[0], []).append((c[1], v))
                elif (
                    isinstance(n.targets[0], ast.Name) and isinstance(v, ast.Dict) and v.keys
                    and _kwarg_refs(v, params)
                ):
                    for k, val in zip(v.keys, v.values):
                        if isinstance(k, ast.Constant):
                            local_folds.setdefault(n.targets[0].id, []).append(([k.value], val))

    visit(fn.body, fn, {fn.name})
    if len(invokes) > 1:
        found.add("multi-invoke")
    final = fn.body[-1] if fn.body else None
    last_is_invoke = (
        isinstance(final, ast.Expr) and isinstance(final.value, ast.Call)
        and isinstance(final.value.func, ast.Attribute) and final.value.func.attr == "invoke"
    )
    if len(invokes) == 1 and not last_is_invoke:
        # The single invoke is nested (if/with) or followed by more work.
        tail = fn.body[-1] if fn.body else None
        if not (isinstance(tail, (ast.If, ast.With)) and _ends_in_invoke(tail)):
            found.add("invoke-not-last")
    if any(
        isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
        and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == "invoke"
        for n in ast.walk(fn)
    ):
        found.add("invoke-not-last")

    details = {}
    if invokes:
        details["invokes"] = list(dict.fromkeys(invokes))
    if checks:
        details["checks"] = checks
    if folds:
        details["folds"] = folds
    if files:
        details["files"] = files
    if helpers:
        details["helpers"] = list(dict.fromkeys(helpers))
    return [p for p in PATTERNS if p in found], details


def _ends_in_invoke(node):
    for branch in ([node.body] + ([node.orelse] if isinstance(node, ast.If) else [])):
        if not branch:
            continue
        last = branch[-1]
        if isinstance(last, (ast.If, ast.With)):
            if not _ends_in_invoke(last):
                return False
        elif not (
            isinstance(last, ast.Expr) and isinstance(last.value, ast.Call)
            and isinstance(last.value.func, ast.Attribute) and last.value.func.attr == "invoke"
        ):
            return False
    return True

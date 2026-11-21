"""Join generated CLI callbacks to the SDK operation they call (Extractor v3b).

Both the generated CLI callbacks and the SDK clients are machine-generated and
uniform, so their source is parsed with `ast` rather than executed.
"""

import ast
import functools
import inspect
import textwrap


def _fn_ast(fn) -> ast.FunctionDef:
    src = textwrap.dedent(inspect.getsource(inspect.unwrap(fn)))
    return ast.parse(src).body[0]


def _kwarg_name(node):
    """kwargs.get("x", missing) -> "x"; Name -> id; else None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
        if node.args and isinstance(node.args[0], ast.Constant):
            return node.args[0].value
    if isinstance(node, ast.Name):
        return node.id
    return None


def _param_value(node) -> dict:
    if isinstance(node, ast.Constant):
        return {"value": node.value}
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "generate_collection_format_param"
    ):
        out = {"arg": _kwarg_name(node.args[0])}
        if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
            out["collectionFormat"] = node.args[1].value
        return out
    name = _kwarg_name(node)
    return {"arg": name} if name else {"expr": ast.unparse(node)}


def _first_dict(fn: ast.FunctionDef, target: str):
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == target
            and isinstance(node.value, ast.Dict)
        ):
            return node.value
    return None


def _constant_assign(fn: ast.FunctionDef, target: str):
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == target
            and isinstance(node.value, ast.Constant)
        ):
            return node.value.value
    return None


@functools.lru_cache(maxsize=None)
def sdk_operation(client_cls, method: str) -> dict:
    fn = _fn_ast(getattr(client_cls, method))
    out = {
        "method": method,
        "http": _constant_assign(fn, "method"),
        "path": _constant_assign(fn, "resource_path"),
        "positionalArgs": [a.arg for a in fn.args.args if a.arg != "self"],
        "pathParams": {},
        "queryParams": {},
        "headerParams": {},
    }
    for target, key in (("path_params", "pathParams"), ("query_params", "queryParams"), ("header_params", "headerParams")):
        d = _first_dict(fn, target)
        if d is None:
            continue
        for k, v in zip(d.keys, d.values):
            if isinstance(k, ast.Constant):
                out[key][k.value] = _param_value(v)
    out["pathParams"] = {k: v.get("arg") for k, v in out["pathParams"].items()}
    # Constant keyword arguments to call_api (response_type, enforce_content_headers, ...) and body.
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "call_api":
            for kw in node.keywords:
                if kw.arg == "body":
                    out["body"] = _kwarg_name(kw.value) or ast.unparse(kw.value)
                elif isinstance(kw.value, ast.Constant) and kw.arg not in ("resource_path", "method"):
                    out[{"response_type": "responseType"}.get(kw.arg, kw.arg)] = kw.value.value
            break
    return out


@functools.lru_cache(maxsize=None)
def client_info(client_cls) -> dict:
    fn = _fn_ast(client_cls.__init__)
    d = _first_dict(fn, "base_client_init_kwargs")
    info = {"class": f"{client_cls.__module__}.{client_cls.__qualname__}"}
    names = {
        "base_path": "basePath",
        "service_endpoint_template": "endpointTemplate",
        "endpoint_service_name": "endpointServiceName",
        "service_endpoint_template_per_realm": "endpointTemplatePerRealm",
    }
    if d is not None:
        for k, v in zip(d.keys, d.values):
            if isinstance(k, ast.Constant) and k.value in names:
                try:
                    info[names[k.value]] = ast.literal_eval(v)
                except ValueError:
                    pass
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "BaseClient" and node.args:
            if isinstance(node.args[0], ast.Constant):
                info["serviceName"] = node.args[0].value
    return info


def command_operation(callback, client_map) -> tuple:
    """Return (client_key, operation, other_operations) for a generated callback."""
    fn = _fn_ast(callback)
    clients = {}  # variable name -> (spec_name, service_name), e.g. client, work_request_client
    client_attrs = []
    paginated = False
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and node.value.func.attr == "build_client"
        ):
            args = node.value.args
            pair = (args[0].value, args[1].value)
            name = node.targets[0].id
            if name in clients and clients[name] != pair:
                # `client` re-bound to a work-request client inside the waiter block.
                clients.setdefault("work_request_client", pair)
            clients.setdefault(name, pair)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "list_call_get_all_results":
                paginated = True
    spec_name, service_name = clients.get("client", (None, None))
    # Source order of client.<attr> references.
    for node in sorted(
        (n for n in ast.walk(fn) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "client"),
        key=lambda n: (n.lineno, n.col_offset),
    ):
        if node.attr not in client_attrs:
            client_attrs.append(node.attr)
    if spec_name is None:
        return None, None, []
    if spec_name not in client_map:
        # build_client lazily loads the service dir that owns this client; do the same.
        from oci_cli import dynamic_loader

        dynamic_loader.load_service_dir(spec_name)
    cls = client_map[spec_name][service_name]
    ops = [a for a in client_attrs if callable(getattr(cls, a, None))]
    if not ops:
        return None, None, []
    key = f"{spec_name}.{service_name}"  # spec names never contain dots
    op = dict(sdk_operation(cls, ops[0]))
    op = {"client": key, **op, "paginated": paginated}
    if "work_request_client" in clients:
        op["workRequestClient"] = ".".join(clients["work_request_client"])
    return key, op, ops[1:]


def _subscript_chain(node):
    """_details['a']['b'] -> ("_details", ["a", "b"]); None if not constant keys on a Name."""
    keys = []
    while isinstance(node, ast.Subscript):
        if not isinstance(node.slice, ast.Constant):
            return None
        keys.insert(0, node.slice.value)
        node = node.value
    return (node.id, keys) if isinstance(node, ast.Name) and keys else None


def _value_binding(value, params: set) -> dict:
    if isinstance(value, ast.Name) and value.id in params:
        return {"param": value.id}
    if isinstance(value, ast.Constant):
        return {"value": value.value}
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
        names = [a.id for a in value.args if isinstance(a, ast.Name) and a.id in params]
        if not names:  # e.g. ipxe_script_file.read()
            names = sorted({n.id for n in ast.walk(value) if isinstance(n, ast.Name) and n.id in params})
        out = {"transform": value.func.attr}
        if names:
            out["param"] = names[0]
        return out
    names = sorted({n.id for n in ast.walk(value) if isinstance(n, ast.Name) and n.id in params})
    out = {"expr": ast.unparse(value)}
    if names:
        out["param"] = names[0]
    return out


def command_bindings(callback, sdk_method: str, params: set) -> list:
    """Where each CLI param lands in the SDK call: an SDK kwarg or a body field.

    Body dicts are the local variables passed as SDK call arguments (usually `_details`).
    """
    fn = _fn_ast(callback)
    call = None
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == sdk_method
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "client"
        ):
            call = node
            break
    bindings = []
    body_vars = {}
    if call is not None:
        for kw in call.keywords:
            if kw.arg is None:  # **kwargs
                continue
            if isinstance(kw.value, ast.Name) and kw.value.id not in params:
                body_vars[kw.value.id] = kw.arg
            else:
                bindings.append({"target": "kwarg", "key": [kw.arg], **_value_binding(kw.value, params)})

    def visit(stmts, when):
        for st in stmts:
            if isinstance(st, ast.If):
                cond = ast.unparse(st.test)
                visit(st.body, when + [cond])
                visit(st.orelse, when + [f"not ({cond})"])
                continue
            for child in ("body", "orelse", "finalbody"):
                if isinstance(st, (ast.Try, ast.With, ast.For)) and hasattr(st, child):
                    visit(getattr(st, child), when)
            if not isinstance(st, ast.Assign) or len(st.targets) != 1:
                continue
            chain = _subscript_chain(st.targets[0])
            if chain is None:
                continue
            var, keys = chain
            if var == "kwargs":
                target = {"target": "kwarg", "key": keys}
            elif var in body_vars:
                target = {"target": "body", "bodyArg": body_vars[var], "key": keys}
            else:
                continue
            b = {**target, **_value_binding(st.value, params)}
            if when:
                b["when"] = " and ".join(when)
            bindings.append(b)

    visit(fn.body, [])
    # Params the response is streamed into (e.g. --file for binary downloads).
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "write"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in params
        ):
            bindings.append({"target": "output", "key": [], "param": node.func.value.id})
            break
    return bindings

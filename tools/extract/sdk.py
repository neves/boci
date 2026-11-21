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
            clients[node.targets[0].id] = (args[0].value, args[1].value)
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

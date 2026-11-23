"""Join generated CLI callbacks to the SDK operation they call (Extractor v3b).

Both the generated CLI callbacks and the SDK clients are machine-generated and
uniform, so their source is parsed with `ast` rather than executed.
"""

import ast
import copy
import functools
import importlib
import inspect
import re
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
        "regional_client": "regionalClient",
        "service_uses_dualstack_endpoints_by_default": "dualStackByDefault",
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


def lifecycle_getter(fn):
    """Generated resource waiters replace the write response with a GET by its model ID."""
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        call = node.value
        if not isinstance(call.func, ast.Attribute) or call.func.attr != "wait_until":
            continue
        if len(call.args) < 4 or ast.unparse(call.args[2]) != "'lifecycle_state'":
            continue
        getter = call.args[1]
        if isinstance(getter, ast.Call) and [ast.unparse(a) for a in getter.args] == ["result.data.id"]:
            return getter.func.attr
    return None


def add_lifecycle_waiter(op, getter, cls):
    op["lifecycleGetter"] = getter
    method = getattr(cls, getter, None)
    if method is None:
        return
    # The CLI always passes result.data.id, even for models without id and
    # SDK getters with more than one required argument. Preserve those errors.
    models = importlib.import_module(cls.__module__.rsplit(".", 1)[0] + ".models")
    model = getattr(models, op["responseType"])
    if not hasattr(model, "id"):
        op["lifecycleGetterError"] = f"AttributeError: '{model.__name__}' object has no attribute 'id'"
        return
    parameters = list(inspect.signature(method).parameters.values())
    missing = [repr(p.name) for p in parameters[2:] if p.kind == p.POSITIONAL_OR_KEYWORD and p.default == p.empty]
    if missing:
        count = len(missing)
        names = missing[0]
        if count > 1:
            conjunction = ", and " if count > 2 else " and "
            names = ", ".join(missing[:-1]) + conjunction + missing[-1]
        noun = "arguments" if count > 1 else "argument"
        op["lifecycleGetterError"] = f"TypeError: {method.__qualname__}() missing {count} required positional {noun}: {names}"


def hidden_lifecycle_getters(commands, clients, client_map):
    """Keep an SDK getter even when a custom command replaces its generated CLI leaf."""
    operations = [c["operation"] for c in commands.values() if "operation" in c]
    exposed = {(op["client"], op["method"]) for op in operations}
    needed = {(op["client"], op["lifecycleGetter"]) for op in operations if "lifecycleGetter" in op}
    for key, method in sorted(needed - exposed):
        directory, name = key.split(".", 1)
        cls = client_map[directory][name]
        if hasattr(cls, method):
            clients[key] = {**clients[key], "lifecycleGetters": {
                **clients[key].get("lifecycleGetters", {}),
                method: {"client": key, **sdk_operation(cls, method)},
            }}


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
    # Deep copy: sdk_operation is cached and Tier A delegates rename nested params in place.
    op = copy.deepcopy(sdk_operation(cls, ops[0]))
    op = {"client": key, **op, "paginated": paginated}
    if "work_request_client" in clients:
        op["workRequestClient"] = ".".join(clients["work_request_client"])
    getter = lifecycle_getter(fn)
    if getter:
        add_lifecycle_waiter(op, getter, cls)
    return key, op, ops[1:]


def custom_delegate(callback, client_map, custom_params):
    """Describe a Tier A wrapper and its generated command, when it is a pure delegate."""
    fn = _fn_ast(callback)
    module_globals = vars(importlib.import_module(callback.__module__))
    invokes = [
        n for n in ast.walk(fn)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        and n.func.attr == "invoke"
    ]
    if not invokes:
        return "C", None
    call = invokes[0]

    def rename_pairs(stmts, seen=None):
        seen = seen or set()
        pairs = {}
        local_pops = {}
        for st in stmts:
            if isinstance(st, ast.If):
                pairs.update(rename_pairs(st.body, seen))
                pairs.update(rename_pairs(st.orelse, seen))
            elif _kwargs_update(st) is not None:
                pairs.update(_kwargs_update(st))
            elif isinstance(st, ast.Assign) and len(st.targets) == 1:
                target = st.targets[0]
                value = st.value
                target_chain = _subscript_chain(target)
                value_chain = _subscript_chain(value)
                if target_chain and target_chain[0] == "kwargs":
                    if value_chain and value_chain[0] == "kwargs":
                        pairs[target_chain[1][0]] = value_chain[1][0]
                    elif (
                        isinstance(value, ast.Call)
                        and isinstance(value.func, ast.Attribute)
                        and value.func.attr == "pop"
                        and isinstance(value.func.value, ast.Name)
                        and value.func.value.id == "kwargs"
                        and value.args
                        and isinstance(value.args[0], ast.Constant)
                        and isinstance(value.args[0].value, str)
                    ):
                        pairs[target_chain[1][0]] = value.args[0].value
                    elif isinstance(value, ast.Name) and value.id in local_pops:
                        pairs[target_chain[1][0]] = local_pops[value.id]
                    elif isinstance(value, ast.Name) and value.id in custom_params:
                        pairs[target_chain[1][0]] = value.id
                elif (
                    isinstance(target, ast.Name)
                    and isinstance(value, ast.Call)
                    and isinstance(value.func, ast.Attribute)
                    and value.func.attr == "pop"
                    and isinstance(value.func.value, ast.Name)
                    and value.func.value.id == "kwargs"
                    and value.args
                    and isinstance(value.args[0], ast.Constant)
                    and isinstance(value.args[0].value, str)
                ):
                    local_pops[target.id] = value.args[0].value
                elif (
                    isinstance(value, ast.Call)
                    and isinstance(value.func, ast.Name)
                    and value.func.id not in seen
                ):
                    helper = module_globals.get(value.func.id)
                    helper_fn = _fn_ast(helper) if callable(helper) else None
                    if helper_fn is not None:
                        pairs.update(rename_pairs(helper_fn.body, seen | {value.func.id}))
        return pairs

    renames = rename_pairs(fn.body)
    # Unconditional `kwargs['x'] = <constant>`: the wrapper fixes that generated param.
    constants = {}
    for st in fn.body:
        if (
            isinstance(st, ast.Assign) and len(st.targets) == 1
            and isinstance(st.value, ast.Constant)
        ):
            chain = _subscript_chain(st.targets[0])
            if chain and chain[0] == "kwargs" and len(chain[1]) == 1:
                constants[chain[1][0]] = st.value.value
    # A valid Tier A wrapper ends in exactly one ctx.invoke and preceding statements
    # only rename or drop keyword arguments.
    final = fn.body[-1] if fn.body else None
    trailing = isinstance(final, ast.Expr) and final.value is call
    if not trailing or len(invokes) != 1:
        return "B", None
    for kw in call.keywords:
        if not kw.arg:
            continue
        if isinstance(kw.value, ast.Name) and kw.value.id in custom_params:
            if kw.arg != kw.value.id:
                renames[kw.arg] = kw.value.id
            continue
        chain = _subscript_chain(kw.value)
        if chain and chain[0] == "kwargs" and chain[1][0] in custom_params:
            if kw.arg != chain[1][0]:
                renames[kw.arg] = chain[1][0]
    computed = (ast.UnaryOp, ast.BinOp, ast.BoolOp, ast.Compare, ast.IfExp)
    for st in ast.walk(ast.Module(body=fn.body[:-1], type_ignores=[])):
        # A computed value (e.g. `not kwargs['no_hooks']`) is logic, not a rename.
        if isinstance(st, ast.Assign) and isinstance(st.value, computed):
            return "B", None
    blank_checks = []
    for st in fn.body[:-1]:
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str):
            continue
        check = _blank_check(st)
        if check is not None:
            blank_checks.append(check)
            continue
        if isinstance(st, ast.If):
            # The callback body is deliberately kept conservative: only recognized
            # kwargs renames, pop calls and `del kwargs[...]` are accepted.
            if not all(_rename_stmt(child) for child in st.body + st.orelse):
                return "B", None
            continue
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and _subscript_chain(st.targets[0]):
            continue
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute) and st.value.func.attr == "pop":
            continue
        if _kwargs_del(st) or _kwargs_update(st) is not None:
            continue
        return "B", None
    target = call.args[0] if call.args else None
    while isinstance(target, ast.Attribute):
        target = target.value
    if not isinstance(target, ast.Name):
        return "B", None
    expr = call.args[0]
    attrs = []
    while isinstance(expr, ast.Attribute):
        attrs.insert(0, expr.attr)
        expr = expr.value
    obj = module_globals.get(target.id)
    for attr in attrs:
        obj = getattr(obj, attr, None)
    delegated_callback = getattr(obj, "callback", None)
    if delegated_callback is None:
        return "B", None
    _, operation, _ = command_operation(delegated_callback, client_map)
    if operation is None:
        return "B", None
    for section in ("queryParams", "headerParams"):
        for binding in operation.get(section, {}).values():
            if binding.get("arg") in renames:
                binding["arg"] = renames[binding["arg"]]
    for key, value in operation.get("pathParams", {}).items():
        if value in renames:
            operation["pathParams"][key] = renames[value]
    generated_params = {p.name for p in getattr(obj, "params", [])}
    bindings = command_bindings(delegated_callback, operation["method"], generated_params)
    for binding in bindings:
        name = binding.get("param")
        if name in renames:
            binding["param"] = renames[name]
        if isinstance(binding.get("when"), str):
            # Conditions name the generated command's params; follow the wrapper's renames.
            binding["when"] = re.sub(
                r"[A-Za-z_][A-Za-z0-9_]*",
                lambda m: renames.get(m.group(0), m.group(0)),
                binding["when"],
            )
    for binding in bindings:
        name = binding.get("param")
        if name in constants and name not in custom_params:
            del binding["param"]
            binding["value"] = constants[name]
            if isinstance(binding.get("when"), str):
                kept = [
                    clause for clause in binding["when"].split(" and ")
                    if name not in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", clause)
                ]
                if kept:
                    binding["when"] = " and ".join(kept)
                else:
                    del binding["when"]
        elif (
            name is not None and name not in custom_params
            and binding.get("target") == "body" and "when" not in binding
        ):
            # The wrapper dropped this option; the generated command still sends None.
            del binding["param"]
            binding["value"] = None
    bindings = [b for b in bindings if "param" not in b or b["param"] in custom_params]
    # Constants for request args (path/query/header) the generated command passes straight through.
    bound = {b["key"][0] for b in bindings if b.get("target") == "kwarg" and b.get("key")}
    for name, value in constants.items():
        if name not in custom_params and name not in bound and value is not None:
            bindings.append({"target": "kwarg", "key": [name], "value": value})
    delegate = {
        "callback": f"{delegated_callback.__module__}.{delegated_callback.__qualname__}",
        "renames": renames,
        "operation": operation,
        "bindings": bindings,
    }
    if blank_checks:
        delegate["blankChecks"] = blank_checks
        delegate["wrapExceptions"] = any(
            ast.unparse(d) == "cli_util.wrap_exceptions" for d in fn.decorator_list
        )
    return "A", delegate


def _rename_stmt(st) -> bool:
    """A statement inside a wrapper's `if` that renames, drops or fixes kwargs.

    Reading a file (`.read()`) or parsing JSON (`parse_json_parameter`) is logic (tickets
    11/12), which `del kwargs[...]` alone used to keep out of Tier A.
    """
    if _kwargs_del(st):
        return True
    if not isinstance(st, (ast.Assign, ast.Expr)):
        return False
    for node in ast.walk(st):
        if (
            isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("read", "parse_json_parameter")
        ):
            return False
    return True


def _kwargs_del(st) -> bool:
    """`del kwargs['x']`: drops a keyword argument, like a bare `kwargs.pop('x')`."""
    if not isinstance(st, ast.Delete):
        return False
    for target in st.targets:
        chain = _subscript_chain(target)
        if not chain or chain[0] != "kwargs" or len(chain[1]) != 1:
            return False
    return True


def _kwargs_update(st):
    """`kwargs.update({'new': kwargs['old'], ...})` -> {"new": "old"}; None for anything else."""
    if not (
        isinstance(st, ast.Expr) and isinstance(st.value, ast.Call)
        and isinstance(st.value.func, ast.Attribute) and st.value.func.attr == "update"
        and isinstance(st.value.func.value, ast.Name) and st.value.func.value.id == "kwargs"
        and len(st.value.args) == 1 and not st.value.keywords
        and isinstance(st.value.args[0], ast.Dict)
    ):
        return None
    pairs = {}
    for key, value in zip(st.value.args[0].keys, st.value.args[0].values):
        chain = _subscript_chain(value) if value is not None else None
        if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
            return None
        if not chain or chain[0] != "kwargs" or len(chain[1]) != 1:
            return None
        pairs[key.value] = chain[1][0]
    return pairs


def _blank_check(st):
    """
    `if isinstance(kwargs['x'], six.string_types) and len(kwargs['x'].strip()) == 0:
         raise click.UsageError('Parameter --x cannot be whitespace or empty string')`
    -> {"param": "x", "message": ...}; None for anything else.
    """
    if not (isinstance(st, ast.If) and not st.orelse and len(st.body) == 1):
        return None
    raise_ = st.body[0]
    if not (
        isinstance(raise_, ast.Raise) and isinstance(raise_.exc, ast.Call)
        and ast.unparse(raise_.exc.func) == "click.UsageError"
        and len(raise_.exc.args) == 1 and isinstance(raise_.exc.args[0], ast.Constant)
    ):
        return None
    message = raise_.exc.args[0].value
    if not (isinstance(message, str) and message.endswith(" cannot be whitespace or empty string")):
        return None
    test = st.test
    if not (isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And) and len(test.values) == 2):
        return None
    chain = None
    for node in ast.walk(test):
        c = _subscript_chain(node) if isinstance(node, ast.Subscript) else None
        if c:
            if c[0] != "kwargs" or len(c[1]) != 1 or (chain and chain != c):
                return None
            chain = c
    if chain is None:
        return None
    param = chain[1][0]
    expected = (
        f"isinstance(kwargs['{param}'], six.string_types) and "
        f"len(kwargs['{param}'].strip()) == 0"
    )
    if ast.unparse(test) != expected:
        return None
    return {"param": param, "message": message}


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

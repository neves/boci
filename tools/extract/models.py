"""What cli_util.make_dict_keys_camel_case needs from the SDK (ticket 19).

parse_json_parameter camelizes a complex param's keys by its declared type: the
command's `@json_skeleton_generation_handler(input_params_to_complex_types=...)`
metadata names each param's {module, class}; a class in MODULE_TO_TYPE_MAPPINGS is an
SDK model whose attribute_map / swagger_types type its keys, and whose get_subtype picks
a subtype by a discriminator. This extracts, per command, that metadata (as
"module:class") and, per service, every model reachable from it.
"""

import ast
import importlib
import inspect
import re
import textwrap


def complex_types(callback) -> dict | None:
    """The input_params_to_complex_types closed over by a command's callback chain."""
    while callback is not None:
        closure = getattr(callback, "__closure__", None)
        if closure:
            values = dict(zip(callback.__code__.co_freevars, (c.cell_contents for c in closure)))
            if "input_params_to_complex_types" in values:
                return values["input_params_to_complex_types"]
        callback = getattr(callback, "__wrapped__", None)
    return None


def compact(metadata: dict | None) -> dict:
    return {name: f"{t['module']}:{t['class']}" for name, t in (metadata or {}).items()}


def callback_named(qualified: str):
    """A generated callback from its "module.qualname" (the module holds its click.Command)."""
    module, _, name = qualified.rpartition(".")
    obj = getattr(importlib.import_module(module), name, None)
    return getattr(obj, "callback", obj)


def _discriminator(cls) -> dict | str | None:
    get_subtype = getattr(cls, "get_subtype", None)
    if get_subtype is None:
        return None
    if "get_subtype" not in vars(cls):
        # A subtype inherits its base's get_subtype: name the class that defines it.
        return next(c.__name__ for c in cls.__mro__ if "get_subtype" in vars(c))
    tree = ast.parse(textwrap.dedent(inspect.getsource(get_subtype)))
    field, values = None, []
    for n in ast.walk(tree):
        if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant):
            field = n.slice.value
        if isinstance(n, ast.Compare) and isinstance(n.comparators[0], ast.Constant):
            values.append(n.comparators[0].value)
    if field is None:
        return None
    return {
        "field": field,
        "values": {v: get_subtype({field: v}) for v in values},
        "fallback": get_subtype({field: object()}),
    }


def _referenced(type_name: str) -> str:
    """The class a swagger type names, through list[...] and dict(K, V) as cli_util does."""
    while True:
        m = re.match(r"list\[(.*)\]", type_name)
        if m:
            type_name = m.group(1)
            continue
        m = re.match(r"dict\(([^,]*), (.*)\)", type_name)
        if m:
            type_name = m.group(2)
            continue
        return type_name


def collect(metadata: dict | None, pool: dict) -> None:
    """Add every model reachable from a command's metadata to pool[module][class]."""
    from oci_cli.cli_clients import MODULE_TO_TYPE_MAPPINGS

    pending = [(t["module"], _referenced(t["class"])) for t in (metadata or {}).values()]
    _collect(pending, pool, MODULE_TO_TYPE_MAPPINGS)


def _enum_info(cls, attr: str) -> tuple[str, list[str]] | None:
    """If attr's setter validates allowed_values, return ('unknown'|'strict', allowed_values)."""
    prop = getattr(cls, attr, None)
    if not isinstance(prop, property) or prop.fset is None:
        return None
    code = prop.fset.__code__
    if "allowed_values" not in code.co_varnames:
        return None
    if "UNKNOWN_ENUM_VALUE" in code.co_consts:
        mode = "unknown"
    elif "ValueError" in code.co_names:
        mode = "strict"
    else:
        return None
    tree = ast.parse(textwrap.dedent(inspect.getsource(prop.fset)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "allowed_values":
                    if isinstance(node.value, ast.List) and all(
                        isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                        for elt in node.value.elts
                    ):
                        return mode, [elt.value for elt in node.value.elts]
    return None


def _collect(pending, pool, mappings):
    while pending:
        module, name = pending.pop()
        mapping = mappings.get(module, {})
        if name not in mapping or name in pool.get(module, {}):
            continue
        cls = mapping[name]
        instance = cls()
        model = {
            "attributes": [
                [snake, instance.swagger_types[snake], camel]
                for snake, camel in instance.attribute_map.items()
            ]
        }
        enums = {}
        strict_enums = {}
        for snake in instance.attribute_map:
            info = _enum_info(cls, snake)
            if info:
                mode, allowed = info
                if mode == "unknown":
                    enums[snake] = allowed
                else:
                    strict_enums[snake] = allowed
        if enums:
            model["enums"] = enums
        if strict_enums:
            model["strictEnums"] = strict_enums
        pending += [(module, _referenced(a[1])) for a in model["attributes"]]
        disc = _discriminator(cls)
        if isinstance(disc, str):
            model["discriminator"] = disc
            pending.append((module, disc))
        elif disc:
            model["discriminator"] = disc
            pending += [(module, c) for c in [*disc["values"].values(), disc["fallback"]]]
        pool.setdefault(module, {})[name] = model

def collect_model_refs(refs, pool: dict) -> None:
    """Add SDK models referenced by compiled program model constructors to pool[module][class]."""
    pending = sorted(set(refs))
    if not pending:
        return
    mappings = {}
    for module, _ in pending:
        if module not in mappings:
            sdk_models = importlib.import_module(f"oci.{module}.models")
            mappings[module] = getattr(sdk_models, f"{module}_type_mapping")
    _collect(pending, pool, mappings)


def collect_responses(commands, clients, pool):
    """Walk the response models of every callable operation, including waiter getters."""
    operations = [target.get("operation", {}) for command in commands.values()
                  for target in [command, *command.get("variants", [])]]
    for command in commands.values():
        operations.extend(command.get("sdkOperations", []))
    for client in clients.values():
        operations.extend(client.get("lifecycleGetters", {}).values())
        operations.append(client.get("workRequestGetter", {}))
    pending = {(op["client"].split(".")[0], _referenced(op["responseType"]))
               for op in operations if op.get("responseType")}
    mappings = {}
    for module, _ in sorted(pending):
        if module not in mappings:
            sdk_models = importlib.import_module(f"oci.{module}.models")
            mappings[module] = getattr(sdk_models, f"{module}_type_mapping")
    _collect(sorted(pending), pool, mappings)

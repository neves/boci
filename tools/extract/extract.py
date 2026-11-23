# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Extract the Reference CLI command surface into spec/.

The Reference CLI loads only the service named on the command line, so each
service is extracted in a fresh process that loads just that service, exactly
as a real invocation would. See docs/adr/0001.

Usage:
  uv run --python 3.12 tools/extract/extract.py            # write spec/
  uv run --python 3.12 tools/extract/extract.py --service os  # dump one subtree (internal)
"""

import json
import hashlib
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import click

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sdk  # noqa: E402
import patterns as tier_b  # noqa: E402

CLIENTS = None  # collects SDK clients used while flattening one service
JSON_EXAMPLE_POOL = None  # deduplicates exact complex skeletons within one service
SPEC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "spec")


def node(cmd: click.Command, name: str) -> dict:
    out = {"name": name, "hidden": bool(getattr(cmd, "hidden", False))}
    if isinstance(cmd, click.Group):
        out["commands"] = {
            child: node(sub, child) for child, sub in sorted(cmd.commands.items())
        }
    return out


HOME = os.path.expanduser("~")


def jsonable(value):
    if isinstance(value, str) and HOME and (value == HOME or value.startswith(HOME + os.sep)):
        return "~" + value[len(HOME):]  # defaults expanded at import time; keep them portable
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if callable(value):
        return {"callable": getattr(value, "__qualname__", repr(value))}
    return {"repr": repr(value)}


def param_spec(p: click.Parameter) -> dict:
    t = p.type
    out = {
        "kind": p.param_type_name,
        "name": p.name,
        "opts": list(p.opts),
        "secondaryOpts": list(p.secondary_opts),
        "type": getattr(t, "name", type(t).__name__),
        "typeClass": f"{type(t).__module__}.{type(t).__qualname__}",
        "required": bool(p.required),
        "multiple": bool(getattr(p, "multiple", False)),
        "nargs": p.nargs,
        "isFlag": bool(getattr(p, "is_flag", False)),
        "count": bool(getattr(p, "count", False)),
        "hidden": bool(getattr(p, "hidden", False)),
        "expose": bool(p.expose_value),
        "eager": bool(p.is_eager),
    }
    if getattr(p, "is_bool_flag", False):
        out["isBoolFlag"] = True
    if getattr(p, "_flag_needs_value", False):
        out["flagNeedsValue"] = True
    if isinstance(t, click.types._NumberRangeBase):
        out["range"] = {"min": t.min, "max": t.max, "minOpen": bool(t.min_open), "maxOpen": bool(t.max_open), "clamp": bool(t.clamp)}
    if type(t).__name__ == "CliDatetime":
        out["datetimeRounding"] = t.apply_rounding
    if isinstance(t, click.Choice):
        out["choices"] = list(t.choices)
        out["caseSensitive"] = bool(t.case_sensitive)
    if p.envvar:
        out["envvar"] = jsonable(p.envvar)
    default = getattr(p, "default", None)
    if default is not None and type(default).__name__ != "Sentinel" and repr(default) != "Sentinel.UNSET":
        out["default"] = jsonable(default)
    if getattr(p, "is_flag", False) and getattr(p, "flag_value", None) not in (None, True):
        out["flagValue"] = jsonable(p.flag_value)
    # Param help text lives in the command's helpDoc records (with Click's extras).
    cb = getattr(p, "callback", None)
    if cb is not None:
        qual = getattr(cb, "__qualname__", repr(cb))
        if qual == "handle_param_with_default.<locals>.internal_handle_param":
            # cli_util.option hides `required` and `default` from Click so values can
            # still come from --from-json or oci_cli_rc; recover the real ones.
            cells = dict(zip(cb.__code__.co_freevars, (c.cell_contents for c in cb.__closure__)))
            out["clickRequired"] = out["required"]
            out["required"] = bool(cells.get("required", False))
            if cells.get("default") is not None:
                out["default"] = jsonable(cells["default"])
            out["callback"] = "oci-default"
        else:
            out["callback"] = f"{getattr(cb, '__module__', '?')}.{qual}"
    return out


def help_doc(cmd: click.Command, ctx: click.Context) -> dict:
    """What Click's format_help needs, computed by Click itself, so boci only has to
    port the (deterministic) HelpFormatter: usage pieces, the help paragraph text
    exactly as handed to write_text, and each param's (term, description) record."""
    import inspect

    text = inspect.cleandoc(cmd.help).partition("\f")[0] if cmd.help is not None else ""
    if cmd.deprecated:
        from click.core import _format_deprecated_label

        label = _format_deprecated_label(cmd.deprecated)
        text = f"{text} {label}" if text else label
    records = []
    for p in cmd.get_params(ctx):
        rec = p.get_help_record(ctx)
        if rec is not None:
            records.append(list(rec))
    doc = {"usage": " ".join(cmd.collect_usage_pieces(ctx)), "text": text, "records": records}
    if isinstance(cmd, click.Group):
        from oci_cli.aliasing.command_group_with_alias import CommandGroupWithAlias

        # Only CommandGroupWithAlias groups resolve [OCI_CLI_COMMAND_ALIASES].
        doc["aliasAware"] = isinstance(cmd, CommandGroupWithAlias)
    # Parser settings Click derives from the context (see ADR 0003).
    # (click.Context() alone ignores command.context_settings; make_context applies them.)
    settings = getattr(cmd, "context_settings", None) or {}
    doc["parse"] = {
        "interspersed": bool(settings.get("allow_interspersed_args", ctx.allow_interspersed_args)),
        "ignoreUnknown": bool(settings.get("ignore_unknown_options", ctx.ignore_unknown_options)),
        "allowExtra": bool(settings.get("allow_extra_args", ctx.allow_extra_args)),
    }
    if cmd.epilog:
        doc["epilog"] = inspect.cleandoc(cmd.epilog)
    if cmd.short_help:
        doc["shortHelp"] = inspect.cleandoc(cmd.short_help)
    if cmd.deprecated:
        doc["deprecated"] = True
    return doc


def flatten(cmd: click.Command, path: list, groups: dict, commands: dict, ctx: click.Context = None) -> None:
    entry = {"hidden": bool(getattr(cmd, "hidden", False))}
    if ctx is not None:
        entry["helpDoc"] = help_doc(cmd, ctx)
    if cmd.help:
        entry["help"] = cmd.help
    if cmd.short_help:
        entry["shortHelp"] = cmd.short_help
    key = " ".join(path)
    if isinstance(cmd, click.Group):
        if path:
            entry["params"] = [param_spec(p) for p in cmd.params]
            groups[key] = entry
        for child, sub in sorted(cmd.commands.items()):
            child_ctx = click.Context(sub, info_name=child, parent=ctx) if ctx is not None else None
            flatten(sub, path + [child], groups, commands, child_ctx)
    else:
        entry["callback"] = f"{cmd.callback.__module__}.{cmd.callback.__qualname__}" if cmd.callback else None
        examples = json_examples(cmd, ctx)
        if examples is not None:
            entry["jsonExamples"] = examples
        # Generated = callback lives in a services.*.generated module (see GLOSSARY: Generated command).
        entry["kind"] = "generated" if cmd.callback and ".generated." in cmd.callback.__module__ else "custom"
        if entry["kind"] == "generated" and CLIENTS is not None:
            from oci_cli.cli_clients import CLIENT_MAP

            client_key, op, others = sdk.command_operation(cmd.callback, CLIENT_MAP)
            if op:
                entry["operation"] = op
                entry["bindings"] = sdk.command_bindings(cmd.callback, op["method"], {p.name for p in cmd.params})
                if others:
                    entry["otherOperations"] = others
                spec_name, service_name = client_key.split(".", 1)
                CLIENTS[client_key] = sdk.client_info(CLIENT_MAP[spec_name][service_name])
        elif entry["kind"] == "custom" and CLIENTS is not None:
            from oci_cli.cli_clients import CLIENT_MAP

            tier, delegate = sdk.custom_delegate(
                cmd.callback, CLIENT_MAP, {p.name for p in cmd.params}
            )
            entry["tier"] = tier
            if tier == "B":
                entry["patterns"], survey = tier_b.survey(cmd)
                if survey:
                    entry["survey"] = survey
            if delegate:
                entry["delegate"] = {
                    "callback": delegate["callback"],
                    "renames": delegate["renames"],
                }
                for field in ("blankChecks", "checks", "wrapExceptions"):
                    if field in delegate:
                        entry["delegate"][field] = delegate[field]
                entry["operation"] = delegate["operation"]
                entry["bindings"] = delegate["bindings"]
                client = delegate["operation"]["client"]
                spec_name, service_name = client.split(".", 1)
                CLIENTS[client] = sdk.client_info(CLIENT_MAP[spec_name][service_name])
        entry["params"] = [param_spec(p) for p in cmd.params]
        commands[key] = entry


def json_examples(cmd: click.Command, ctx: click.Context) -> dict | None:
    """Capture the pinned CLI's JSON skeletons while its SDK models are loaded."""
    callback = cmd.callback
    metadata = None
    while callback is not None:
        closure = getattr(callback, "__closure__", None)
        if closure:
            values = dict(zip(callback.__code__.co_freevars, (cell.cell_contents for cell in closure)))
            if "input_params_to_complex_types" in values:
                metadata = values["input_params_to_complex_types"]
                break
        callback = getattr(callback, "__wrapped__", None)
    if metadata is None:
        return None

    from oci_cli.json_skeleton_utils import generate_input_dict_for_skeleton

    # Context data needed by the Reference CLI helper. No local OCI config or RC aliases
    # participate in extraction; aliases are invocation-specific, not command metadata.
    ctx.obj = {"input_params_to_complex_types": metadata, "parameter_aliases": {}}
    def encode_numbers(value):
        # Preserve Python's JSON spelling of floats (e.g. 0.0); JavaScript parses
        # those as integers, so a plain extracted JSON value would lose parity.
        if isinstance(value, float):
            return {"__bociJsonNumber": repr(value)}
        if isinstance(value, list):
            return [encode_numbers(child) for child in value]
        if isinstance(value, dict):
            return {key: encode_numbers(child) for key, child in value.items()}
        return value

    def intern(value):
        value = encode_numbers(value)
        key = json.dumps(value, sort_keys=True, separators=(",", ":"))
        identifier = hashlib.sha256(key.encode()).hexdigest()
        if identifier not in JSON_EXAMPLE_POOL:
            JSON_EXAMPLE_POOL[identifier] = value
        return identifier

    params = {name: intern(generate_input_dict_for_skeleton(ctx, name)) for name in metadata}
    full = encode_numbers(generate_input_dict_for_skeleton(ctx))
    from oci_cli.string_utils import camelize

    # Full-command examples contain each complex example again. Replace those
    # values with references so parameter and full-command cases share one copy.
    for name, example in params.items():
        full_name = camelize(name)
        if full_name in full:
            full[full_name] = {"__bociJsonRef": example}
    return {"full": full, "params": params}


def service_spec(name: str, cmd: click.Command) -> dict:
    global CLIENTS, JSON_EXAMPLE_POOL
    groups, commands = {}, {}
    CLIENTS = {}
    JSON_EXAMPLE_POOL = {}
    root_ctx = click.Context(load_root(), info_name="oci")
    ctx = click.Context(cmd, info_name=name, parent=root_ctx)
    flatten(cmd, [], groups, commands, ctx)
    # A waiter can call a different SDK client, even when its getter has no CLI leaf.
    from oci_cli import dynamic_loader
    from oci_cli.cli_clients import CLIENT_MAP

    waiter_clients = {
        c["operation"]["workRequestClient"]
        for c in commands.values()
        if "workRequestClient" in c.get("operation", {})
    }
    for key in sorted(waiter_clients):
        directory, client_name = key.split(".", 1)
        dynamic_loader.load_service_dir(directory)
        cls = CLIENT_MAP[directory][client_name]
        getter = {"client": key, **sdk.sdk_operation(cls, "get_work_request")}
        CLIENTS[key] = {**sdk.client_info(cls), "workRequestGetter": getter}
    sdk.hidden_lifecycle_getters(commands, CLIENTS, CLIENT_MAP)
    clients, CLIENTS = dict(sorted(CLIENTS.items())), None
    top = {"hidden": bool(getattr(cmd, "hidden", False))}
    if cmd.help:
        top["help"] = cmd.help
    if cmd.short_help:
        top["shortHelp"] = cmd.short_help
    if isinstance(cmd, click.Group):
        top["params"] = [param_spec(p) for p in cmd.params]
    top["helpDoc"] = help_doc(cmd, ctx)
    return {"service": name, "top": top, "clients": clients, "groups": groups, "commands": commands, "jsonExamplePool": JSON_EXAMPLE_POOL}


def kind_counts(spec: dict) -> dict:
    kinds = [c["kind"] for c in spec["commands"].values()]
    return {"generated": kinds.count("generated"), "custom": kinds.count("custom")}


def regions_spec() -> dict:
    """oci.regions lookup tables used to turn a region into a service endpoint."""
    from oci import regions

    return {
        "regions": sorted(regions.REGIONS),
        "shortNames": dict(sorted(regions.REGIONS_SHORT_NAMES.items())),
        "regionRealms": dict(sorted(regions.REGION_REALMS.items())),
        "realms": dict(regions.REALMS),
        "serviceEndpoints": dict(sorted(regions.SERVICE_ENDPOINTS.items())),
        "domainFormat": regions.DOMAIN_FORMAT,
    }


def datetime_spec() -> dict:
    """oci's CliDatetime accepted formats (regex + arrow format + assumed tz) and error text."""
    from oci_cli.custom_types.cli_datetime import CliDatetime

    return {
        "formats": [
            {"format": f["format_string"], "regex": f["regex_pattern"].pattern, "timezone": f["use_timezone"]}
            for f in CliDatetime.VALID_DATETIME_FORMATS
        ],
        "message": CliDatetime.VALID_DATETIME_EXCEPTION_MESSAGE,
    }


def write_json(path: str, data) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")


def load_root():
    from oci_cli.cli import cli  # registers setup, session, raw-request, interactive

    return cli


def dump_service(service: str) -> None:
    root = load_root()
    from oci_cli import dynamic_loader

    dynamic_loader.load_service(service)
    cmd = root.commands.get(service)
    json.dump({"tree": node(cmd, service), "spec": service_spec(service, cmd)} if cmd else None, sys.stdout)


def main() -> None:
    from oci_cli.service_mapping import service_mapping
    from oci_cli.version import __version__

    root = load_root()
    tree = node(root, "oci")

    def extract(service: str):
        res = subprocess.run(
            [sys.executable, __file__, "--service", service],
            capture_output=True,
            text=True,
            check=True,
        )
        return service, json.loads(res.stdout)

    services = sorted(service_mapping)
    empty = []
    kinds = {}
    os.makedirs(SPEC_DIR, exist_ok=True)
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for service, sub in pool.map(extract, services):
            if sub is None:
                # Listed in service_mapping but ships no code: `oci <service>` is "No such command".
                empty.append(service)
                continue
            tree["commands"][service] = sub["tree"]
            kinds[service] = kind_counts(sub["spec"])
            write_json(os.path.join(SPEC_DIR, f"{service}.json"), sub["spec"])
    tree["commands"] = dict(sorted(tree["commands"].items()))
    # Top-level commands registered by the core rather than a service (setup, session,
    # raw-request, profile, ...). NON_SERVICE_TOP_LEVEL_COMMANDS is incomplete, so derive them.
    core = sorted(n for n in root.commands if n not in service_mapping)
    for name in core:
        spec = service_spec(name, root.commands[name])
        kinds[name] = kind_counts(spec)
        write_json(os.path.join(SPEC_DIR, f"{name}.json"), spec)

    def count(n):
        return sum(count(c) for c in n["commands"].values()) if "commands" in n else 1

    index = {
        "referenceVersion": __version__,
        "nonServiceCommands": core,
        "servicesWithoutCommands": empty,
        "services": {
            name: {"dir": m[0], "title": m[1], "category": m[2]}
            for name, m in sorted(service_mapping.items())
        },
        "kinds": dict(sorted(kinds.items())),
        "rootHelp": root.help,
        "globalParams": [param_spec(p) for p in root.params],
        "rootHelpDoc": help_doc(root, click.Context(root, info_name="oci")),
        "datetime": datetime_spec(),
        "regions": regions_spec(),
        # cli_root.echo_help swaps OCI_HELP for the wrapped OCI_USER_HELP in root help.
        "ociHelp": __import__("oci_cli.cli_root", fromlist=["x"]).OCI_HELP,
        "ociUserHelp": __import__("oci_cli.cli_root", fromlist=["x"]).OCI_USER_HELP,
        "root": tree,
    }
    write_json(os.path.join(SPEC_DIR, "index.json"), index)
    print(f"services={len(services)} empty={empty} leaf_commands={count(tree)}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--service":
        dump_service(sys.argv[2])
    else:
        main()

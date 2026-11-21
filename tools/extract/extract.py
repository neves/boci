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
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import click

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sdk  # noqa: E402

CLIENTS = None  # collects SDK clients used while flattening one service
SPEC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "spec")


def node(cmd: click.Command, name: str) -> dict:
    out = {"name": name, "hidden": bool(getattr(cmd, "hidden", False))}
    if isinstance(cmd, click.Group):
        out["commands"] = {
            child: node(sub, child) for child, sub in sorted(cmd.commands.items())
        }
    return out


def jsonable(value):
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
    if getattr(p, "help", None):
        out["help"] = p.help
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


def flatten(cmd: click.Command, path: list, groups: dict, commands: dict) -> None:
    entry = {"hidden": bool(getattr(cmd, "hidden", False))}
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
            flatten(sub, path + [child], groups, commands)
    else:
        entry["callback"] = f"{cmd.callback.__module__}.{cmd.callback.__qualname__}" if cmd.callback else None
        # Generated = callback lives in a services.*.generated module (see GLOSSARY: Generated command).
        entry["kind"] = "generated" if cmd.callback and ".generated." in cmd.callback.__module__ else "custom"
        if entry["kind"] == "generated" and CLIENTS is not None:
            from oci_cli.cli_clients import CLIENT_MAP

            client_key, op, others = sdk.command_operation(cmd.callback, CLIENT_MAP)
            if op:
                entry["operation"] = op
                if others:
                    entry["otherOperations"] = others
                spec_name, service_name = client_key.split(".", 1)
                CLIENTS[client_key] = sdk.client_info(CLIENT_MAP[spec_name][service_name])
        entry["params"] = [param_spec(p) for p in cmd.params]
        commands[key] = entry


def service_spec(name: str, cmd: click.Command) -> dict:
    global CLIENTS
    groups, commands = {}, {}
    CLIENTS = {}
    flatten(cmd, [], groups, commands)
    clients, CLIENTS = dict(sorted(CLIENTS.items())), None
    top = {"hidden": bool(getattr(cmd, "hidden", False))}
    if cmd.help:
        top["help"] = cmd.help
    if cmd.short_help:
        top["shortHelp"] = cmd.short_help
    if isinstance(cmd, click.Group):
        top["params"] = [param_spec(p) for p in cmd.params]
    return {"service": name, "top": top, "clients": clients, "groups": groups, "commands": commands}


def kind_counts(spec: dict) -> dict:
    kinds = [c["kind"] for c in spec["commands"].values()]
    return {"generated": kinds.count("generated"), "custom": kinds.count("custom")}


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
        "root": tree,
    }
    write_json(os.path.join(SPEC_DIR, "index.json"), index)
    print(f"services={len(services)} empty={empty} leaf_commands={count(tree)}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--service":
        dump_service(sys.argv[2])
    else:
        main()

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

SPEC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "spec")


def node(cmd: click.Command, name: str) -> dict:
    out = {"name": name, "hidden": bool(getattr(cmd, "hidden", False))}
    if isinstance(cmd, click.Group):
        out["commands"] = {
            child: node(sub, child) for child, sub in sorted(cmd.commands.items())
        }
    return out


def load_root():
    from oci_cli.cli import cli  # registers setup, session, raw-request, interactive

    return cli


def dump_service(service: str) -> None:
    root = load_root()
    from oci_cli import dynamic_loader

    dynamic_loader.load_service(service)
    cmd = root.commands.get(service)
    json.dump(node(cmd, service) if cmd else None, sys.stdout)


def main() -> None:
    from oci_cli.dynamic_loader import NON_SERVICE_TOP_LEVEL_COMMANDS
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
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for service, sub in pool.map(extract, services):
            if sub is None:
                # Listed in service_mapping but ships no code: `oci <service>` is "No such command".
                empty.append(service)
                continue
            tree["commands"][service] = sub
    tree["commands"] = dict(sorted(tree["commands"].items()))

    def count(n):
        return sum(count(c) for c in n["commands"].values()) if "commands" in n else 1

    os.makedirs(SPEC_DIR, exist_ok=True)
    index = {
        "referenceVersion": __version__,
        "nonServiceCommands": NON_SERVICE_TOP_LEVEL_COMMANDS,
        "servicesWithoutCommands": empty,
        "services": {
            name: {"dir": m[0], "title": m[1], "category": m[2]}
            for name, m in sorted(service_mapping.items())
        },
        "root": tree,
    }
    with open(os.path.join(SPEC_DIR, "index.json"), "w") as f:
        json.dump(index, f, indent=1, sort_keys=False)
        f.write("\n")
    print(f"services={len(services)} empty={empty} leaf_commands={count(tree)}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--service":
        dump_service(sys.argv[2])
    else:
        main()

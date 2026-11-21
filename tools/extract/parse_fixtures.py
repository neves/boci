# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Golden data for boci's port of Click's option parser (src/parser.ts).

Runs Click's real _OptionParser over generated argv for real oci commands (root, a
group, many leaves) and records opts / leftover args / order, or the usage error.
Writes test/fixtures/parse.json.
"""

import json
import os
import random

import click
from click._utils import FLAG_NEEDS_VALUE, UNSET
from click.exceptions import UsageError

from oci_cli import dynamic_loader
from oci_cli.cli import cli as root

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
random.seed(99)

for service in ["os", "compute", "iam", "db", "network"]:
    dynamic_loader.load_service(service)


def leaves(cmd, path):
    if isinstance(cmd, click.Group):
        for name, sub in sorted(cmd.commands.items()):
            yield from leaves(sub, path + [name])
    else:
        yield path, cmd


nodes = [([], root), (["os"], root.commands["os"]), (["os", "bucket"], root.commands["os"].commands["bucket"])]
all_leaves = [x for s in ["os", "compute", "iam", "db", "network", "setup", "raw-request"] for x in leaves(root.commands[s], [s])]
nodes += random.sample(all_leaves, 40)


def jsonable(v):
    if v is UNSET:
        return {"$": "UNSET"}
    if v is FLAG_NEEDS_VALUE:
        return {"$": "FLAG_NEEDS_VALUE"}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    return v


def gen_argv(cmd):
    params = [p for p in cmd.params if isinstance(p, click.Option)]
    opt_names = [o for p in params for o in p.opts + p.secondary_opts]
    out = []
    for _ in range(random.randint(0, 7)):
        r = random.random()
        if r < 0.45 and opt_names:
            name = random.choice(opt_names)
            p = next(p for p in params if name in p.opts + p.secondary_opts)
            if p.is_flag and not p._flag_needs_value:
                out.append(name if random.random() < 0.9 else f"{name}=x")
            elif random.random() < 0.25 and name.startswith("--"):
                out.append(f"{name}=v{random.randint(0, 9)}")
            else:
                out.append(name)
                if random.random() < 0.9:
                    out.append(random.choice(["val", "-x", "--", "a=b", "", "-", "file://x"]))
        elif r < 0.55:
            out.append(random.choice(["--no-such", "--nope=1", "-Z", "-zq"]))
        elif r < 0.65:
            shorts = [o for o in opt_names if len(o) == 2 and o[0] == "-"]
            if shorts:
                out.append("-" + "".join(random.choice(shorts)[1] for _ in range(random.randint(1, 3))))
        elif r < 0.75:
            out.append("--")
        elif r < 0.85:
            out.append(random.choice(["pos", "list", "get", "x y"]))
        else:
            # root options showing up after subcommand tokens
            out.append(random.choice(["--profile", "--region", "--debug", "-d", "--output", "-v", "--help"]))
            if out[-1] in ("--profile", "--region", "--output"):
                out.append(random.choice(["p", "json", "table"]))
    return out


cases = []
for path, cmd in nodes:
    settings = getattr(cmd, "context_settings", None) or {}
    for _ in range(25):
        argv = gen_argv(cmd)
        ctx = click.Context(cmd, info_name=(path[-1] if path else "oci"), **settings)
        case = {"path": path, "argv": argv}
        try:
            opts, largs, order = cmd.make_parser(ctx).parse_args(list(argv))
            case["opts"] = {k: jsonable(v) for k, v in opts.items()}
            case["args"] = largs
            case["order"] = [p.name for p in order]
        except UsageError as e:
            case["error"] = {"type": type(e).__name__, "message": e.format_message(), "option": getattr(e, "option_name", None)}
        cases.append(case)

with open(os.path.join(ROOT, "test", "fixtures", "parse.json"), "w") as fh:
    json.dump(cases, fh)
print(f"wrote {len(cases)} cases, {sum('error' in c for c in cases)} errors")

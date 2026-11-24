# /// script
# requires-python = "==3.12.*"
# dependencies = ["oci-cli==3.96.3"]
# ///
"""Explain why Leaf commands are still missing (scripts/triage.ts, `bun run triage`).

For each command of one service, loaded the way a real invocation loads it: its Tier,
the reason the wrapper compiler (program.py) rejects it with the offending source, the
SDK operations the wrapper calls directly (as OperationSpec, for `bun run scaffold`),
and the wrapper's source location.

Usage:
  uv run --python 3.12 tools/extract/triage.py <service> "<command path>"...
Prints one JSON object per line.
"""

import ast
import copy
import inspect
import json
import os
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import program  # noqa: E402
import sdk  # noqa: E402


def find(root, path):
    cmd = root
    for part in path:
        cmd = getattr(cmd, "commands", {}).get(part)
        if cmd is None:
            return None
    return cmd


def client_calls(fn, client_map):
    """`client.method(...)` calls on clients the wrapper builds, as OperationSpecs."""
    clients = {}
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Call)
            and (program._dotted(node.value.func) or "").endswith("build_client")
            and len(node.value.args) >= 2
            and all(isinstance(a, ast.Constant) for a in node.value.args[:2])
        ):
            clients[node.targets[0].id] = (node.value.args[0].value, node.value.args[1].value)
    calls, seen = [], set()
    for node in sorted(
        (n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)),
        key=lambda n: (n.lineno, n.col_offset),
    ):
        var = node.func.value
        if not (isinstance(var, ast.Name) and var.id in clients):
            continue
        spec_name, service_name = clients[var.id]
        method = node.func.attr
        if (spec_name, service_name, method) in seen:
            continue
        seen.add((spec_name, service_name, method))
        entry = {"client": f"{spec_name}.{service_name}", "method": method, "line": node.lineno}
        try:
            if spec_name not in client_map:
                from oci_cli import dynamic_loader

                dynamic_loader.load_service_dir(spec_name)
            cls = client_map[spec_name][service_name]
            if callable(getattr(cls, method, None)):
                entry["operation"] = {"client": entry["client"], **sdk.sdk_operation(cls, method)}
        except Exception as e:  # noqa: BLE001 - report, don't stop the triage
            entry["error"] = repr(e)
        calls.append(entry)
    return calls


def helper_calls(fn, module_globals):
    """Module helpers and cli_util functions the wrapper calls (what a port must replicate)."""
    names = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            dotted = program._dotted(node.func) or ""
            head = dotted.split(".", 1)[0]
            if dotted.startswith("cli_util.") or (
                head in module_globals and inspect.isfunction(module_globals.get(head))
            ):
                names.add(dotted)
    return sorted(names)


def _label(e, clients, local_names):
    """A capability name for one Unsupported, shared by every wrapper that needs it."""
    reason, source = str(e), e.source or ""
    callee = source.split("(", 1)[0] if "(" in source else ""
    head = callee.split(".", 1)[0]
    if reason in ("call keywords",) or reason.startswith("call "):
        if head in clients:
            return "sdk: client.<method>(...)"
        if callee.startswith(("cli_util.", "click.", "json.", "os.", "oci.", "six.", "sys.")):
            return f"call {callee}"
        if head in local_names and "." in callee:
            return f"method .{callee.rsplit('.', 1)[1]}()"
        return f"call {callee or reason[5:]}"
    if reason == "attribute":
        return f"attribute .{source.rsplit('.', 1)[-1][:40]}"
    if reason.startswith("helper "):
        return reason
    if reason.startswith("helper"):
        return f"{reason}: {callee}"
    return reason


COMPOUND = (ast.If, ast.For, ast.While, ast.With, ast.Try)


def _stand_in(node):
    """What replaces a blamed node so the rest of the wrapper can still be compiled."""
    if isinstance(node, COMPOUND):
        body = list(node.body) + list(getattr(node, "orelse", []))
        for h in getattr(node, "handlers", []):
            body += h.body
        body += list(getattr(node, "finalbody", []))
        return [ast.Pass() if isinstance(s, (ast.Break, ast.Continue)) else s for s in body] or [ast.Pass()]
    if isinstance(node, ast.stmt):
        return [ast.Pass()]
    if isinstance(node, ast.expr):
        return ast.copy_location(ast.Constant(0), node)
    return None


def _replace(tree, node):
    stand_in = _stand_in(node)
    if stand_in is None:
        return False
    for parent in ast.walk(tree):
        for field, value in ast.iter_fields(parent):
            if value is node and not isinstance(stand_in, list):
                setattr(parent, field, stand_in)
                return True
            if isinstance(value, list) and any(v is node for v in value):
                i = next(i for i, v in enumerate(value) if v is node)
                value[i:i + 1] = stand_in if isinstance(stand_in, list) else [stand_in]
                return True
    return False


def needs(fn, module_globals, clients):
    """Every independent blocker in a wrapper, not just the first: compile, blame the
    innermost unsupported node, stand something supported in for it, and compile again."""
    fn = copy.deepcopy(fn)
    local_names = {a.arg for a in fn.args.args} | {"kwargs"} | {
        n.id for n in ast.walk(fn) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
    } | {h.name for h in ast.walk(fn) if isinstance(h, ast.ExceptHandler) and h.name}
    found = {}
    # Probe operands removed with a rejected expression or statement in their own
    # assignments. This keeps nested blockers visible without inventing Expr statements.
    invokes = any(isinstance(n, ast.Call) and program._dotted(n.func) == "ctx.invoke"
                  for st in fn.body for n in ast.walk(st))

    def operands(node):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            return operands(node.value)
        if isinstance(node, ast.Call):
            if program._dotted(node.func) == "ctx.invoke":
                return [kw.value for kw in node.keywords]
            return [*node.args, *(kw.value for kw in node.keywords)]
        values = []
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr) and not isinstance(getattr(child, "ctx", None), ast.Store):
                values.append(child)
            elif isinstance(child, (ast.withitem, ast.comprehension)):
                values.extend(operands(child))
        return values

    for _ in range(500):
        compiler = program.Compiler(module_globals, local_names)
        try:
            compiler.stmts(fn.body, {})
        except program.Unsupported as e:
            found.setdefault(_label(e, clients, local_names), (e.source or "").partition("\n")[0][:160] or None)
            if e.node is None or not _replace(fn, e.node):
                found["analysis incomplete: unreplaceable node"] = None
                break
            for expr in operands(e.node):
                fn.body.append(ast.copy_location(ast.Assign(
                    targets=[ast.Name(id="_probe", ctx=ast.Store())], value=expr), expr))
            continue
        if not compiler.targets and not invokes:
            found.setdefault("no ctx.invoke (calls the SDK directly)" if clients else "local wrapper without ctx.invoke", None)
        break
    else:
        found["analysis incomplete: iteration limit"] = None
    return dict(sorted(found.items()))


def triage(root, service, path, client_map):
    out = {"key": " ".join([service, *path])}
    cmd = find(root.commands.get(service), path) if path else root.commands.get(service)
    if cmd is None or cmd.callback is None:
        out["error"] = "no such command"
        return out
    callback = inspect.unwrap(cmd.callback)
    out["callback"] = f"{callback.__module__}.{callback.__qualname__}"
    try:
        file = inspect.getsourcefile(callback)
        lines, start = inspect.getsourcelines(callback)
        out["source"] = {
            "file": file[file.find("site-packages/") + 14:] if "site-packages/" in file else file,
            "line": start,
            "lines": len(lines),
        }
        out["sourceText"] = textwrap.dedent("".join(lines))
    except (OSError, TypeError):
        pass
    if ".generated." in callback.__module__:
        out["kind"] = "generated"
        return out
    out["kind"] = "custom"
    try:
        out["tier"], _ = sdk.custom_delegate(cmd.callback, client_map, {p.name for p in cmd.params})
    except Exception as e:  # noqa: BLE001
        out["tier"] = "?"
        out["tierError"] = repr(e)
    reason = program.why_unsupported(cmd.callback)
    if reason is not None:
        out["reason"] = str(reason)
        if reason.source is not None:
            out["blame"] = {"source": reason.source.splitlines()[0][:160], "line": reason.line}
    fn = program._fn_ast(cmd.callback)
    if fn is not None:
        import importlib

        module_globals = vars(importlib.import_module(callback.__module__))
        out["sdkCalls"] = client_calls(fn, client_map)
        out["invokes"] = sorted({
            ast.unparse(n.args[0]) for n in ast.walk(fn)
            if isinstance(n, ast.Call) and program._dotted(n.func) == "ctx.invoke" and n.args
        })
        clients = {
            n.targets[0].id for n in ast.walk(fn)
            if isinstance(n, ast.Assign) and len(n.targets) == 1
            and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call)
            and (program._dotted(n.value.func) or "").endswith("build_client")
        }
        out["needs"] = needs(fn, module_globals, clients) if reason is not None else {}
        if reason is not None and reason.source is None and not str(reason).startswith("no ctx.invoke"):
            out["needs"][str(reason)] = None
        out["helpers"] = helper_calls(fn, module_globals)
    return out


def main():
    service, paths = sys.argv[1], sys.argv[2:]
    from oci_cli.cli import cli as root
    from oci_cli import dynamic_loader
    from oci_cli.cli_clients import CLIENT_MAP

    if service not in root.commands:
        dynamic_loader.load_service(service)
    for path in paths:
        try:
            out = triage(root, service, path.split(), CLIENT_MAP)
        except Exception as e:  # noqa: BLE001
            out = {"key": f"{service} {path}", "error": repr(e)}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()

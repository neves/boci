# 07: Tier A tracer bullet — one wrapper command end to end

**What to build:** `apm-traces trace span get` (a Custom command) runs through the generic Engine and passes a Parity case, with no hand-written handler. It works because the extractor now records which Generated operation the wrapper calls and how it renames parameters.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Background
~752 of 1,188 Custom commands are "Tier A" wrappers. In the Reference CLI their callback (recorded in the spec as `callback`, e.g. `services.apm_traces.src.oci_cli_trace.trace_cli_extended.get_span_extended`) looks like:

```python
@cli_util.copy_params_from_generated_command(trace_cli.get_span, params_to_exclude=[...])
...
def get_span_extended(ctx, **kwargs):
    if 'time_span_started_gte' in kwargs:
        kwargs['time_span_started_greater_than_or_equal_to'] = kwargs['time_span_started_gte']
        kwargs.pop('time_span_started_gte')
    ctx.invoke(trace_cli.get_span, **kwargs)
```

Tier A = body is only rename/pop statements (`kwargs['a'] = kwargs['b']`, `kwargs['a'] = kwargs.pop('b')`, `kwargs.pop('x')`, those wrapped in `if 'x' in kwargs:`, docstrings) followed by exactly one trailing `ctx.invoke(<generated module>.<command>, **kwargs)`. Tier B = calls `ctx.invoke` but does more. Tier C = never calls `ctx.invoke`.

## What to do
1. Extractor (Python, `bun run extract`, ADR 0001): for each Custom command, AST-parse its callback source; classify `tier` A/B/C. For Tier A, resolve the invoked generated Click command (importable from the generated module), compute its `operation` and `bindings` with the existing SDK helpers used for Generated commands, then rewrite each binding's `param` from the generated name to the custom param name using the renames. Dropped params produce no binding. Emit `tier`, `delegate` (generated callback + renames), `operation`, `bindings` on the custom entry.
2. `bun run spec` shows tier and delegate for a custom command.
3. `engineSupports` accepts `kind: "custom"` with `tier: "A"` under the same method rules as Generated commands. For this ticket, gate it to the single key so nothing else changes.
4. Case generator: emit request-only cases for delegated custom commands (same shapes as generated ones) for `apm-traces` only; record goldens with `bun run golden --filter <id-prefix>`.

## Acceptance criteria
- [ ] Regenerated spec: Tier A count roughly 750 (report the exact A/B/C counts in the commit body).
- [ ] `apm-traces trace span get` case passes, including a renamed option (`--time-span-started-gte`) appearing in the request under the generated query name.
- [ ] No previously verified case changes; `bun run status` verified count only goes up.
- [ ] `bun run verify` green. Commit: `rung 8: tier A delegation tracer bullet`.

# 10: Survey and tag Tier B wrappers

**What to build:** The extractor tags each of the ~234 Tier B Custom commands with the logic patterns its callback uses, and a short report (`.scratch/remaining-commands/tier-b-report.md`) lists each pattern with its command count and 3 examples. Tickets 11–14 are confirmed or re-scoped from the report.

**Blocked by:** 07: Tier A tracer bullet.

**Status:** done

## Context for the implementer

Rough call counts measured across Tier B bodies (a command can have several):

- `click.UsageError` raised for argument checks — 63
- `json.dumps` / dict building of a complex param from flattened options — 62
- `cli_util.parse_json_parameter` — 33
- `click.File` / `open().read()` file-content params — 32
- multiple `ctx.invoke` calls (2–16 per command, polymorphic variants like Autonomous Database create with `adwc_args`/`atp_args`) — ~16
- direct client calls (`cli_util.build_client`, `client.get_database`) — ~11

Detect patterns statically (AST); for each, also record what the extractor can learn declaratively (e.g. which options are folded into which complex param, which pairs are mutually exclusive) so tickets 11–14 can be data-driven. Also list the Tier C commands per service (some, like `identity-domains * list`, may share a pattern) and note it in the report.

## Acceptance criteria

- [x] Spec entries for Tier B commands carry a `patterns` list; `bun run spec` prints it.
- [x] Report written; each of tickets 11–14 updated in place (scope, counts, examples) or marked obsolete; new tickets filed for any pattern with ≥10 commands not covered.
- [x] `bun run verify` green.

# 08: Tier A — all wrapper reads and deletes

**What to build:** Every Tier A Custom command whose delegated operation is GET, HEAD or bodyless DELETE runs through the Engine and matches the Reference CLI. Covers most of Rung 8's "Single-resource lookups", "Collection listing", "Filtered lookups" and "Deletion and confirmation" groups (e.g. `data-safe private-endpoint get`, `iam compartment list`, `data-safe private-endpoint delete`).

**Blocked by:** 07: Tier A tracer bullet.

**Status:** ready-for-agent

## Context for the implementer
- Remove the single-key gate from ticket 07 for these methods; extend the case generator to all services for delegated GET/HEAD/DELETE (`bun run parity:cases --all --method GET,HEAD,DELETE`), then `bun run golden` for the new cases.
- Run the generated set with `BOCI_PARITY_ALL=1`, collect failures, group by cause (e.g. delete `--force` confirmation prompt, `--all` pagination differences, choice case-insensitivity, renamed path params). Fix causes in the Engine, never per command.
- Commands that turn out not to be pure wrappers: add to `EXCLUDED` with a one-line reason; they'll be picked up by Tier B/C work.
- **Rule:** if more than ~3 distinct failure causes appear, fix the biggest 3 and file a follow-up ticket per remaining cause in this directory (next free number, `Blocked by: 08`), then mark this one done.

## Acceptance criteria
- [ ] Every Tier A read/delete is verified, excluded with reason, or covered by a filed follow-up ticket.
- [ ] One commit per cause. `bun run ladder sync` run and committed.
- [ ] `bun run verify` green.

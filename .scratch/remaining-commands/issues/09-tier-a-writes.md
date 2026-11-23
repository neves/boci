# 09: Tier A — all wrapper writes

**What to build:** Every Tier A Custom command whose delegated operation is POST, PUT or PATCH runs through the Engine: compartment moves (`* change-compartment`), updates, creates and actions that are plain wrappers (e.g. `data-safe private-endpoint change-compartment`, `data-safe registration-policy create`, `data-safe private-endpoint update`).

**Blocked by:** 03: bodyless actions, 04: complex-only bodies, 08: Tier A reads and deletes.

**Status:** ready-for-agent

## Context for the implementer

- Same procedure as ticket 08 for `--method POST,PUT,PATCH`.
- Expect causes around: update confirmation prompts (`--force`) when complex fields are replaced, waiter options copied from the generated command, renamed body fields, `--from-json` keys using custom vs generated names (check `generate-full-command-json-input` goldens).
- **Rule:** more than ~3 causes → fix the biggest 3, file follow-up tickets (`Blocked by: 09`) for the rest.

## Acceptance criteria

- [ ] Every Tier A write is verified, excluded with reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

# 12: Pattern: parameters read from a file

**What to build:** Tier B commands whose options take a file (`click.File`, `open().read()`, often then `.strip()` or JSON-parsed) behave like the Reference CLI: same accepted forms, same request, same error for a missing file.

**Blocked by:** 09: Tier A writes, 10: Tier B survey.

**Status:** ready-for-agent

## Context for the implementer
- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- Check goldens for error text on a missing file and for stripping/trailing-newline handling. Use tiny fixtures; stay offline.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 12`) for the rest.

## Acceptance criteria
- [ ] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

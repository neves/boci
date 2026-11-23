# 14: Pattern: several operations, one per variant

**What to build:** Tier B commands that pick among several Generated operations or body subtypes (e.g. Autonomous Database create variants, data-guard association create variants) send the right request for each variant.

**Blocked by:** 09: Tier A writes, 10: Tier B survey, 11: options into a JSON body, 13: argument validation, 16: del kwargs and blank checks.

**Status:** done

## Context for the implementer

- **Scope (ticket 10 survey):** 15 Tier B commands, listed under "14" in `.scratch/remaining-commands/tier-b-report.md` (`multi-invoke`; `survey.invokes` names each generated callback). Variant selectors: `network-firewall application|decryption-profile create|update` (by `--type`), `data-integration connection|data-asset create|update`, `autoscaling policy create|update`. Several requests: `kms management key|vault backup|restore`, `log-analytics upload upload-otlp-logs`. The Autonomous Database / data-guard examples above are not in this set: `db autonomous-database create` is a single invoke (ticket 16) and `db data-guard-association create *` is Tier C.

- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- These are few but high value (db). If a command can't be expressed as data (variant selector → delegate), write a hand handler in the per-service directory layout from ticket 02 and register it.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- Ticket 11 compiles wrapper bodies to programs (`tools/extract/program.py`, run by `src/core/program.ts`), limited to one generated target; `network-firewall application create` (both branches invoke the same callback) is already verified that way. Widening `program`/`generated` to several targets (one operation + bindings per invoked callback) may cover most variant selectors.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 14`) for the rest.

## Outcome

- The wrapper compiler takes several `ctx.invoke` targets (`variants` in the spec; each invoke names its target's index). Verified: `autoscaling policy create|update`, `kms management key|vault backup|restore`, `network-firewall application update`, `network-firewall decryption-profile create|update` (`application create` was already verified).
- `dict(pairs)` and tuples joined the program subset: `data-integration connection|data-asset create|update` verified.
- `log-analytics upload upload-otlp-logs` (one target; `os.path.exists`, `with open(...)`, a file as the body) moved to ticket 21.

## Acceptance criteria

- [x] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

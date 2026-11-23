# 14: Pattern: several operations, one per variant

**What to build:** Tier B commands that pick among several Generated operations or body subtypes (e.g. Autonomous Database create variants, data-guard association create variants) send the right request for each variant.

**Blocked by:** 09: Tier A writes, 10: Tier B survey, 11: options into a JSON body, 13: argument validation, 16: del kwargs and blank checks.

**Status:** ready-for-agent

## Context for the implementer

- **Scope (ticket 10 survey):** 15 Tier B commands, listed under "14" in `.scratch/remaining-commands/tier-b-report.md` (`multi-invoke`; `survey.invokes` names each generated callback). Variant selectors: `network-firewall application|decryption-profile create|update` (by `--type`), `data-integration connection|data-asset create|update`, `autoscaling policy create|update`. Several requests: `kms management key|vault backup|restore`, `log-analytics upload upload-otlp-logs`. The Autonomous Database / data-guard examples above are not in this set: `db autonomous-database create` is a single invoke (ticket 16) and `db data-guard-association create *` is Tier C.

- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- These are few but high value (db). If a command can't be expressed as data (variant selector → delegate), write a hand handler in the per-service directory layout from ticket 02 and register it.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 14`) for the rest.

## Acceptance criteria

- [ ] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

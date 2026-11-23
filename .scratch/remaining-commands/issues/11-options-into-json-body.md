# 11: Pattern: options assembled into a JSON body

**What to build:** Tier B commands that build a complex parameter from several flat options (`json.dumps` / dict building in the callback) send the same request body as the Reference CLI.

**Blocked by:** 09: Tier A writes, 10: Tier B survey, 13: argument validation, 16: del kwargs and blank checks.

**Status:** ready-for-agent

## Context for the implementer

- **Scope (ticket 10 survey):** 57 Tier B commands, listed under "11" in `.scratch/remaining-commands/tier-b-report.md`: patterns `fold-body` 43 overall, `parse-json` 37, `json-dumps` 59, `helper`, `computed-value`, single invoke, no file. Examples: `lb backend-set create` (helper folds into `health_checker`, `ssl_configuration`, …), `ce cluster create` (folds into `options`/`endpoint_config`), `mysql db-system create`. 12 are `network-firewall * bulk-upload`: parse + re-dump of one param only. `survey.folds` in the spec gives target param, JSON path, source options and whether each value is JSON-parsed; `bun run spec <service> <command…>` prints them.

- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- Make the folding declarative: the extractor (ticket 10) records target complex param and the option→field mapping; the Engine applies it before binding. Hand-code only what can't be expressed as data.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 11`) for the rest.

## Acceptance criteria

- [ ] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

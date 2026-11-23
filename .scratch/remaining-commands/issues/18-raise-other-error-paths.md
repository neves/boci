# 18: Error paths that raise something other than UsageError

**What to build:** Tier B commands tagged `raise-other` (they raise `ValueError`, `Exception`, `cli_exceptions.RequiredValueNotInDefaultOrUserInputError`, ...) print the same error and exit code as the Reference CLI on those paths.

**Blocked by:** 13: argument checks.

**Status:** ready-for-agent

## Context for the implementer

- The ticket 10 survey only records `click.UsageError` raises as `checks`; `raise-other` raises are tagged but not recorded. Extend `tools/extract/patterns.py` to record them (exception class, message or message template, enclosing conditions) and reuse ticket 13's predicate compiler (`tools/extract/checks.py`) and evaluator (`src/core/checks.ts`) where the condition is about options. How `cli_util.wrap_exceptions` renders each exception class comes from goldens, not guesses.
- Commands (15): `network-firewall application|decryption-profile|mapped-secret|tunnel-inspection-rule create|update` (8; `ValueError` when a type in the JSON details doesn't match the type option, often after `parse_json_parameter`), `data-flow application create|update`, `data-flow run create|submit` (4; `Exception` from a helper validating parameters), `goldengate deployment create` (missing `--deployment-name` without `--ogg-data`), `iam user api-key upload`, `database-migration connection create-oracle-connection`, `support incident update`.
- Record error invocations as Parity cases (key `usage-checks` while the happy path is unimplemented); happy paths stay with 11/12/14/15.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 18`) for the rest.

## Acceptance criteria

- [ ] Every `raise-other` command's error path is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

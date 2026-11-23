# 13: Pattern: argument checks that raise usage errors

**What to build:** Tier B commands that validate arguments (mutually exclusive or required-together options, value checks) print the same usage error and exit code as the Reference CLI, and otherwise run as wrappers.

**Blocked by:** 08: Tier A reads and deletes, 10: Tier B survey, 16: del kwargs and blank checks.

**Status:** done. Checks compile to predicates (`tools/extract/checks.py`, evaluated by `src/core/checks.ts`): Tier A `delegate.checks`, Tier B `survey.checks[].test`. `db backup list` and `vault secret create-base64` are Tier A and verified (2 Ladder items ticked). Error paths of 20 Tier B commands are covered by `usage-checks` Parity cases (lb backend-set/listener create|update, bv volume|boot-volume create, ce cluster create / node-pool create|update, kms management key|vault backup|restore, os bucket delete / retention-rule create, db system|vm-cluster update, compute volume-attachment list, autoscaling policy create|update, generative-ai-sandbox sandbox-file read|write); their happy paths stay with 11/12/14/15. `network public-ip get` is really a three-operation variant (ticket 14) and its checks read a computed local: ticket 17. Uncompiled checks over computed locals: ticket 17. `raise-other` error paths: ticket 18. Rover and remote-peering checks follow requests/prompts: hand-written (15).

## Context for the implementer

- **Scope (ticket 10 survey):** implement `survey.checks` (each `raise click.UsageError` with `when` = conjunction of its enclosing ifs, the options it reads, and the exact `message`) for every Tier B command: 33 `usage-error` commands and 16 `raise-other` (`ValueError` etc.). Only 3 commands (`db backup list`, `network public-ip get`, `vault secret create-base64`) have nothing else and are fully verified here; for the other 30+16, record the error-path cases and leave their happy path to 11/12/14. Examples with checks: `lb backend-set create` (exclusive + conditional-required), `bv volume create`, `ce cluster create`. `when` is Python source over `kwargs[...]`; compile it to a small predicate set (is None / truthy / not / and / or) rather than evaluating Python. `blank-check` is ticket 16.

- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- Record error invocations as Parity cases (no network needed). Prefer declarative rules (`exclusive`, `requiredTogether`) extracted from the AST; the exact message text must match the golden byte for byte.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 13`) for the rest.

## Acceptance criteria

- [x] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

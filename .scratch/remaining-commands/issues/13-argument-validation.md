# 13: Pattern: argument checks that raise usage errors

**What to build:** Tier B commands that validate arguments (mutually exclusive or required-together options, value checks) print the same usage error and exit code as the Reference CLI, and otherwise run as wrappers.

**Blocked by:** 08: Tier A reads and deletes, 10: Tier B survey, 16: del kwargs and blank checks.

**Status:** ready-for-agent

## Context for the implementer

- **Scope (ticket 10 survey):** implement `survey.checks` (each `raise click.UsageError` with `when` = conjunction of its enclosing ifs, the options it reads, and the exact `message`) for every Tier B command: 33 `usage-error` commands and 16 `raise-other` (`ValueError` etc.). Only 3 commands (`db backup list`, `network public-ip get`, `vault secret create-base64`) have nothing else and are fully verified here; for the other 30+16, record the error-path cases and leave their happy path to 11/12/14. Examples with checks: `lb backend-set create` (exclusive + conditional-required), `bv volume create`, `ce cluster create`. `when` is Python source over `kwargs[...]`; compile it to a small predicate set (is None / truthy / not / and / or) rather than evaluating Python. `blank-check` is ticket 16.

- Start from the Tier B report written by ticket 10 for the exact command list, counts and examples; that report overrides anything here.
- Record error invocations as Parity cases (no network needed). Prefer declarative rules (`exclusive`, `requiredTogether`) extracted from the AST; the exact message text must match the golden byte for byte.
- Write cases first: add hand-written Parity cases for 2–3 example commands, record goldens with `bun run golden --filter <id-prefix>`, see them fail, then implement, then widen to every command tagged with this pattern.
- Look up commands with `bun run spec <service> <command…>`; read the Reference CLI behaviour from goldens, not by running `oci` by hand.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 13`) for the rest.

## Acceptance criteria

- [ ] Every command tagged with this pattern is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

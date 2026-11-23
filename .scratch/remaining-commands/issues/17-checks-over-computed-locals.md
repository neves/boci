# 17: Argument checks that read computed locals

**What to build:** The Tier B argument checks ticket 13 could not compile print the same usage error and exit code as the Reference CLI. Their tests read locals the wrapper computes (`len(provided_update_identifiers)`, `len(command_args)`, `'user_data' in metadata`, `file.name`) or follow other work (a `del kwargs[...]`, another raise, a request), so `survey.checks[].test` is absent and the Engine skips them (and every later check of that command).

**Blocked by:** 13: argument checks.

**Status:** done

## Context for the implementer

- Ticket 13 compiles a check to a predicate (`tools/extract/checks.py`) only when its test reads options (`kwargs[...]`, `kwargs.get`, a parameter or a once-bound alias) and no I/O precedes it; Tier A wrappers carry them as `delegate.checks`, Tier B as `survey.checks[].test`, evaluated by `src/core/checks.ts`. Parity cases live in `test/parity/cases/usage-checks.json` (feature key `usage-checks` for Tier B).
- Uncompiled (`bun run spec <service> <command…>` prints `check (not compiled)`):
  - `db cloud-vm-cluster update` (4), `db vm-cluster update` (last 4): `provided_update_identifiers` = the set of `--update-id` / `--gi-image-id` / `--gi-home-id` given.
  - `network public-ip get` (2): `command_args` = the non-None options minus `from_json`; also its happy path picks one of three operations (ticket 14).
  - `compute instance launch` (6): `metadata` parsed from `--metadata` JSON; file options.
  - `opsi awr-hub-objects put` (1): `file.name == '<stdin>'`.
  - `goldengate deployment create` (3) / `update` (4): after `del kwargs[...]` and a `RequiredValueNotInDefaultOrUserInputError` (ticket 18).
- Option: widen the predicate set (e.g. `{"count": [options]}` for "how many of these are set") rather than evaluating Python. Commands whose happy path stays Tier B keep only error-path cases; their happy path belongs to 11/12/14.
- `rover node add-workload|delete-workload` and `network remote-peering-connection connect` checks follow requests or prompts: hand-written with ticket 15's own-logic commands, not here.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 17`) for the rest.

## Acceptance criteria

- [x] Every listed check is compiled and covered by a Parity case, or the command is excluded/assigned with a reason.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

## Outcome

- New predicate `{"countGt": [[options], n]}` for locals holding the options given (filtered dict comprehension over option reads, or `dict([... kwargs.items() if v is not None])` minus popped keys): `db cloud-vm-cluster update` (4), `db vm-cluster update` (4), `network public-ip get` (2) compile all checks. Their happy paths stay Tier B (dict comprehension / `next(six.iteritems(...))`, multi-operation by key): `usage-checks` cases only; all three happy paths: ticket 20.
- click.File aliases: `hasattr(f, 'name')` -> option given, `f.name == '<stdin>'` -> value `-`: `opsi awr-hub-objects put` (1) compiles.
- `compute instance launch` (6) and `goldengate deployment create` (3) / `update` (4) already run their checks through their compiled program (tickets 11/12; survey tests stay uncompiled but are unused); Parity cases now cover every check. The `RequiredValueNotInDefaultOrUserInputError` path of `create` stays with ticket 18.
- `rover node add-workload|delete-workload` and `network remote-peering-connection connect`: ticket 15 (own logic), as planned.

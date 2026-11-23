# 20: Ticket 11 wrappers outside the program subset

**What to build:** The ticket 11 wrappers that `tools/extract/program.py` can't compile send the same request (or error) as the Reference CLI.

**Blocked by:** 11: options into a JSON body, 12: file content params, 18: raise-other error paths.

**Status:** done

## Context for the implementer

- Ticket 11 compiles a Tier B wrapper's body to a JSON program (`program` in the spec: `let`/`set`/`del`/`if`/`usage`/`raise`/`invoke` over `kwargs`; `tools/extract/program.py`), run by `src/core/program.ts` before the generated command's own bindings (`generated`, `operation`, `bindings`). `bun run spec <service> <command…>` shows whether a command has one. Uncompiled, with what stops the compiler:
  - `data-flow application create|update`, `data-flow run create|submit`: helpers `convertArgumentStringToJson` / `convertParameterStringToJson` / `convertConfigurationStringToJson` (`re.split`, list comprehensions, loops, `return`) turn `--arguments`/`--parameters`/`--configuration` plain text into JSON; they raise `Exception` on bad input. Ticket 18 left that error path here (it needs the converters): throw `ProgramRaise("Exception", message)` (`src/core/program.ts`) from the converter and `runWrapper` prints `Exception: <message>`, exit 1, like `cli_util.wrap_exceptions`; record goldens for an odd token count and a missing `=`. Hand-code the three converters as named program functions (`["fn", ...]`) or a small TS helper the program calls.
  - `db vm-cluster update`: a dict comprehension over `six.iteritems` and `next(...)` picking the one given update identifier (its checks: ticket 17).
  - `db cloud-vm-cluster update` (ticket 12's): the same dict comprehension; its `--ssh-authorized-keys-file` list comprehension already compiles.
  - `network public-ip get` (ticket 17's): `command_args = dict([(k, v) for k, v in kwargs.items() if v is not None])`, then `ctx.invoke(func_call_dict[func_call_key], **command_args)` picks one of three generated commands by the one option given (renaming `public_ip_address` to `ip_address`). Its checks compile (`countGt`).
  - `mysql channel update-from-mysql`: its own `click.confirm` / `ctx.abort()` tags warning, then `force=True`.
  - `rover node set-secrets`: `click.prompt` (hidden, confirmed) for the secrets; arguably own logic (ticket 15).
- Programs stop with "not implemented" (`ProgramUnsupported`) on paths the Engine doesn't model: any non-UsageError `raise` (ticket 18), a missing key, and keywords the generated callback doesn't accept (e.g. `db database enable-database-management` without `--user-name` leaves `user_name` in kwargs, a TypeError in the Reference CLI). Record a golden for that TypeError path and model it if it's common.
- `log-analytics query export` compiles but writes its response to `--file`: ticket 22. (`network-firewall application create`, ticket 14's, compiled and is verified.)
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 20`) for the rest.

## Acceptance criteria

- [x] Every command listed above is verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

## Outcome

- Verified (`test/parity/cases/wrappers-outside-subset.json`): `data-flow application create|update`, `data-flow run create|submit` (converters hand-coded as `dataflowArguments` / `dataflowParameters` / `dataflowConfiguration`, `Exception` goldens for odd tokens and a missing `=`), `db vm-cluster update`, `db cloud-vm-cluster update`, `network public-ip get` (comprehensions, `next`, unpacking, a command picked from a dict), `mysql channel update-from-mysql` (`click.confirm` replay, `ctx.abort`).
- Follow-up ticket 25: `rover node set-secrets` (`click.prompt`) and the unexpected-keyword TypeError path (the `enable-database-management` example is unreachable: `--user-name` is required).

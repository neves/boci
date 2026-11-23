# 23: File-reading wrappers with their own logic

**What to build:** The ticket 12 wrappers that read files but also run logic outside the program subset (SDK lookups, `os.path` checks, `try`/`except`) behave like the Reference CLI, hand-written like Tier C if need be.

**Blocked by:** 12: file content params, 18: raise-other error paths.

**Status:** done

## Context for the implementer

- `os object copy` and `os object reencrypt`: base64-encode the SSE-C key files (`--encryption-key-file`, `--source-encryption-key-file`) via the module helper `_get_sse_customer_key_details` (also computes the key's SHA256) and call `cli_util.build_client` for lookups (`direct-client`). `src/commands/os/` already reads SSE-C key files for `object get|put`; reuse that.
- `database-migration connection create-oracle-connection`: `--sshkey-file` read like ticket 12's files, but `--wallet` is a path checked with `os.path.exists`/`isfile`, read in `try:` as bytes and base64-encoded; failures raise `click.ClickException(str(e))`, and `--ssh-key` with `--sshkey-file` raises `RequiredValueNotInDefaultOrUserInputError` (ticket 18). Ticket 18 left this command's error path here: a compiled `["raise", src, cls, msg]` (cls in `RAISABLE`, `tools/extract/program.py`) throws `ProgramRaise`, which `runWrapper` (`src/core/cli.ts`) renders as `cli_util.wrap_exceptions` does (usage + `Error:` for `RequiredValueNotInDefaultOrUserInputError`, `Class: str(e)` otherwise); add `ClickException` to that rendering (`Error: <msg>`, exit 1) from a golden.
- Ticket 12 machinery: `click.File` options reach programs as `ProgramFile` (`src/core/program.ts`), opened by `openClickFileForProgram` (`src/core/click-file.ts`); the compiler (`tools/extract/program.py`) knows `read()`, `b64encode`, `.decode()`, `for`, list comprehensions.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 23`) for the rest.

## Acceptance criteria

- [x] The three commands above are verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

## Outcome

- SSE-C key helpers (`_get_sse_params`, `_get_sse_customer_key_details`) are hand-coded program functions (`sseParams`, `sourceSseParams`, `sseCustomerKey`) with CPython's non-strict `b64decode` errors (`Error: Incorrect padding`, `ValueError: ... ASCII`). Cases: `test/parity/cases/sse-key-files.json`.
- `build_client(...)` / `client.get_namespace().data` / `ctx.obj['config']['region']` compile; the Engine makes `GET /n` on demand (`ProgramLookup`) and reruns the program. `ctx.obj['config']` before `build_client` is `KeyError: 'config'`, as in the Reference CLI (`os object copy --destination-namespace X` without `--destination-region`).
- `try: ... except Exception as e:`, `os.path.isfile`, `raise click.ClickException(str(e))` compile; `open()` on an unreadable file raises `PermissionError`. `ClickException` renders `ClickException: <msg>` (wrap_exceptions' generic branch), not `Error: <msg>`. Cases: `test/parity/cases/file-wrapper-logic.json`.

# 26: File-body wrappers outside the program subset

**What to build:** The two ticket 21 wrappers that send a file as the raw request body but use Python the program compiler doesn't model send the same request (bytes, content-type, content-length, signed headers) as the Reference CLI.

**Blocked by:** 21: binary file bodies from wrappers.

**Status:** ready-for-agent

## Context for the implementer

- Ticket 21 taught the Engine direct bodies from wrappers: bytes (`file.read()` in `'rb'`) and open files (`with open(path, mode) as f:`, a `ProgramFile` handed on; content-type defaults to `application/octet-stream` like the SDK signer). See `runWrapper` (`src/core/cli.ts`), `buildRequestBody` (`src/core/operation.ts`), `ProgramFiles` (`src/core/program.ts`), and `with`/`open`/`os.path.exists`/`isstr` in `tools/extract/program.py`. The case generator points options a program `open()`s at the sandbox file (`openedOptions`, `scripts/generate-cases.ts`).
- Not compiled yet, with what stops it:
  - `opsi awr-hub-objects put`: `hasattr(file, 'name')`, `file.name == '<stdin>'` and `os.path.basename(file.name)` on a `click.File('rb')` (the object name defaults to the file's basename; stdin needs `--name`, else a UsageError), then `kwargs['file'].read()` → body. `ProgramFile` would need its path (`name`).
  - `generative-ai-sandbox sandbox-file write`: `ExitStack`, `io.BytesIO(kwargs['file'].encode('utf-8'))` for literal `--file` text, `file.seekable()` / `tempfile.SpooledTemporaryFile` for pipes, `file.read(1)` / `seek` / `tell`, and a `SimpleNamespace` reader for an empty body (Content-Length: 0, no chunked framing). Likely simpler hand-coded (Tier C) from goldens: `--file` text, `--local-file` path, `--local-file -` (stdin), empty file, both/neither given (UsageError).
- `bun run spec <service> <command…>` prints the survey; read behaviour from goldens.

## Acceptance criteria

- [ ] Both commands are verified or excluded with a reason.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

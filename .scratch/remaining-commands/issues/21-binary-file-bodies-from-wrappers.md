# 21: Tier B wrappers that send a file as the raw request body

**What to build:** The ticket 12 wrappers that hand a binary file (a `click.File('rb')` option, or `open(path, 'rb')`) to the generated command as its direct body send the same request (bytes, content-type, content-length) as the Reference CLI.

**Blocked by:** 05: engine file bodies, 12: file content params.

**Status:** done

## Context for the implementer

- Ticket 12 runs programmed wrappers with `click.File` options as `ProgramFile`s (`src/core/program.ts`); a program whose invoke kwargs still hold a `ProgramFile` or bytes stops with "not implemented" (`runWrapper` in `src/core/cli.ts`). Ticket 05 teaches the Engine binary direct bodies; then let those kwargs through.
- Compiled, excluded in `EXCLUDED` (`src/core/registry.ts`), cases and goldens already recorded in `generated-wrapper-log-analytics`: `log-analytics content-import import-custom-content`, `log-analytics lookup append-data|register-lookup|update-data` (`kwargs['file'].read()` → body).
- Not compiled (`tools/extract/program.py`), with what stops it:
  - `data-science job create-job-artifact`, `model create-model-artifact`, `pipeline create-step-artifact`, `ml-app-implementation upload-package`: `isinstance(x, six.string_types)` blank checks, `with open(path, 'rb') as file:` around the invoke (the open file is the body).
  - `artifacts generic artifact upload-by-path`, `log-analytics upload upload-log-file|upload-log-events-file`, `log-analytics entity upload-discovery-data`, `generative-ai-sandbox sandbox-file write`: `with open(...)`.
  - `log-analytics upload upload-otlp-logs` (from ticket 14): `os.path.exists(path)`, then `with open(path, 'r')` (`--content-type application/json`: text body) or `open(path, 'rb')` (the open file is the body); a path that doesn't exist is sent as the body string itself.
  - `opsi awr-hub-objects put`: `hasattr(file, 'name')` / `os.path.basename(file.name)` (stdin needs `--name`).
- `bun run spec <service> <command…>` prints the survey; read behaviour from goldens.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 21`) for the rest.

## Acceptance criteria

- [x] Every command listed above is verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

## Outcome

- Verified: the four `log-analytics content-import|lookup` commands (bytes body); `data-science job create-job-artifact`, `model create-model-artifact`, `pipeline create-step-artifact`, `ml-app-implementation upload-package`, `artifacts generic artifact upload-by-path`, `log-analytics upload upload-log-file|upload-log-events-file`, `log-analytics entity upload-discovery-data` (open file body); `log-analytics upload upload-otlp-logs` (`os.path.exists`, all three branches in `test/parity/cases/file-bodies.json`).
- Follow-up ticket 26: `opsi awr-hub-objects put`, `generative-ai-sandbox sandbox-file write`.

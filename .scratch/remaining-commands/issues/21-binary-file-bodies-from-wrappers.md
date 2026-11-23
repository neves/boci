# 21: Tier B wrappers that send a file as the raw request body

**What to build:** The ticket 12 wrappers that hand a binary file (a `click.File('rb')` option, or `open(path, 'rb')`) to the generated command as its direct body send the same request (bytes, content-type, content-length) as the Reference CLI.

**Blocked by:** 05: engine file bodies, 12: file content params.

**Status:** ready-for-agent

## Context for the implementer

- Ticket 12 runs programmed wrappers with `click.File` options as `ProgramFile`s (`src/core/program.ts`); a program whose invoke kwargs still hold a `ProgramFile` or bytes stops with "not implemented" (`runWrapper` in `src/core/cli.ts`). Ticket 05 teaches the Engine binary direct bodies; then let those kwargs through.
- Compiled, excluded in `EXCLUDED` (`src/core/registry.ts`), cases and goldens already recorded in `generated-wrapper-log-analytics`: `log-analytics content-import import-custom-content`, `log-analytics lookup append-data|register-lookup|update-data` (`kwargs['file'].read()` → body).
- Not compiled (`tools/extract/program.py`), with what stops it:
  - `data-science job create-job-artifact`, `model create-model-artifact`, `pipeline create-step-artifact`, `ml-app-implementation upload-package`: `isinstance(x, six.string_types)` blank checks, `with open(path, 'rb') as file:` around the invoke (the open file is the body).
  - `artifacts generic artifact upload-by-path`, `log-analytics upload upload-log-file|upload-log-events-file`, `log-analytics entity upload-discovery-data`, `generative-ai-sandbox sandbox-file write`: `with open(...)`.
  - `opsi awr-hub-objects put`: `hasattr(file, 'name')` / `os.path.basename(file.name)` (stdin needs `--name`).
- `bun run spec <service> <command…>` prints the survey; read behaviour from goldens.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 21`) for the rest.

## Acceptance criteria

- [ ] Every command listed above is verified, excluded with a reason, or covered by a follow-up ticket.
- [ ] One commit per cause; `bun run ladder sync` run.
- [ ] `bun run verify` green.

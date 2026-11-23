# 22: Tier B wrappers that write the response to `--file`

**What to build:** Tier B wrappers whose generated command streams the response into a lazy `click.File('wb')` option (`--file`, `-` for stdout) write the same bytes and print the same output as the Reference CLI.

**Blocked by:** 12: file content params.

**Status:** done

## Context for the implementer

- `log-analytics query export` compiles (`program` in the spec) but passes its `--file` (`ProgramFile` in mode `wb`) to the generated command, so `runWrapper` (`src/core/cli.ts`) stops with "not implemented"; it is in `EXCLUDED` (`src/core/registry.ts`). Case `generated-wrapper-log-analytics-query-export` and its golden are recorded.
- `data-science ml-app-implementation download-package` and `ml-app-implementation-version download-package` don't compile (`isinstance(x, six.string_types)` blank check, then a rename); they hand `--file` to the generated download command.
- Check how the generated command writes the body (`cli_util` streaming to the file, empty file on error?) from a golden; `os object get` (`src/commands/os/get.ts`, `openClickFileForWrite`) already writes a response to a click.File.
- **Rule:** more than ~3 distinct failure causes → fix the biggest 3, file follow-up tickets (`Blocked by: 22`) for the rest.

## Acceptance criteria

- [x] The three commands above are verified, excluded with a reason, or covered by a follow-up ticket.
- [x] One commit per cause; `bun run ladder sync` run.
- [x] `bun run verify` green.

## Outcome

- The Engine now writes a stream response to `--file` for every generated download command (101 commands, Tier A delegates included): previously their requests matched but the body was printed as JSON. Hand-written cases in `test/parity/cases/stream-downloads.json` (file, `-`, empty body, ServiceError).
- Verified: `log-analytics query export` (the program's write-mode `ProgramFile` carries its path to the output binding); `data-science ml-app-implementation download-package` and `ml-app-implementation-version download-package` (already Tier A delegates; now write the file).
- The golden zygote no longer reports exit 120 after a command closes stdout (`--file -`).
- No follow-up tickets.

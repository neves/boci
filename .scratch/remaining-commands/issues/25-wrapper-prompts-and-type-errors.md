# 25: Wrapper prompts and TypeError paths

**What to build:** `rover node set-secrets` sends the same request (or error) as the Reference CLI, and programmed wrappers that pass keywords the generated callback doesn't accept print what the Reference CLI prints instead of "not implemented".

**Blocked by:** 20: wrappers outside the program subset.

**Status:** ready-for-agent

## Context for the implementer

- Left over from ticket 20 (its rule: fix the biggest 3 causes, file the rest).
- `rover node set-secrets`: `click.prompt(..., hide_input=True, confirmation_prompt=True)` for the secrets. Ticket 20 added `click.confirm` as `["fn", "confirm", text]`: `runProgram` throws `ProgramConfirm`, `runWrapper` (`src/core/cli.ts`) asks with `confirmUnderWrapExceptions` and runs the program again with the answers so far. A `click.prompt` can reuse that replay (a `ProgramPrompt` with the answer list holding strings); hidden input and the confirmation re-prompt ("Repeat for confirmation: ", "Error: The two entered values do not match.") need goldens with `stdin`. If it turns out to be own logic, hand-code it under ticket 15's rules instead.
- TypeError path: `runWrapper` returns "unsupported" when the program's invoke passes a keyword the generated command doesn't accept (`names` not in `accepted`): a `TypeError: <callback>() got an unexpected keyword argument '<name>'` in the Reference CLI. Ticket 20's example (`db database enable-database-management` without `--user-name`) can't happen: `--user-name` is required. Find a real one (run every programmed wrapper's generated cases and list "not implemented" exits from that check), record a golden, and model the message (under `cli_util.wrap_exceptions`, `TypeError: ...`, exit 1) if it is reachable.

## Acceptance criteria

- [ ] `rover node set-secrets` verified, or excluded with a reason.
- [ ] The unexpected-keyword path either has a golden and matches, or is shown unreachable.
- [ ] `bun run verify` green.

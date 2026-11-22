# boci

A Bun drop-in for Oracle's `oci` CLI. Read [GLOSSARY.md](GLOSSARY.md) for vocabulary and [docs/adr/](docs/adr/) for the decisions that must not be "fixed". [PLAN.md](PLAN.md) is the Ladder.

## Ground rules

- The Reference CLI is `oci-cli==3.96.3` on Python 3.12, installed with `uv tool install --python 3.12 oci-cli==3.96.3`. Its behavior defines correct. Never "improve" on it.
- Bun-native code (use the `bun` skill). No runtime dependencies except a JMESPath library. No OCI SDK.
- Checks: `bun run verify` (`bun fmt --check`, `bun check`, build, then `bun test` with every Parity case, generated ones included, against the compiled `dist/boci`; quiet). Add `bun lint` once the installed Bun has it.
- Default `bun test` (unit tests + hand-written Parity cases, ~10 s) is offline and fast: never let it touch the network or the real `~/.oci`. Generated cases (`test/parity/cases/generated-*.json`) run only with `BOCI_PARITY_ALL=1`.
- Live calls only through `bun run parity:live`, which reads `.env.test` (`BOCI_TEST_PROFILE=<your profile>`). Live tests may:
  - run any read-only command;
  - create only Always-Free resources in the root compartment, named `boci-parity-*` and tagged `boci-parity=true`, and delete only resources carrying that tag.
  - Never touch IAM policies, users, groups, tenancy settings, or any untagged resource. Commands in those areas are request-only.
- Never commit unscrubbed Recordings (tenancy/user OCIDs, namespace, fingerprints) or anything from `~/.oci`.

## Token budget

Every byte read stays in context and is re-sent on every later turn. Keep context small.

- **Ladder:** `bun run ladder` prints the current rung and the next item. Don't read PLAN.md in full. `bun run ladder tick` / `bun run ladder stuck` mark the item.
- **Spec:** never `cat`/`grep` `spec/*.json` (up to 2 MB each). Use `bun run spec <service> <command…>` for one Leaf command, or `bun run spec <service> [group]` to list commands. Help text comes from `bun src/main.ts <command> --help`.
- **Reference CLI behavior:** read the golden (`test/parity/golden/<id>.json`). Don't run `oci` by hand when a case can capture the behavior.
- **Tests while iterating:** run only what you touch: `bun test test/parity -t '<id or key>'` (prefix `BOCI_PARITY_ALL=1` for a `generated-*` case) or `bun test test/unit/<file>.test.ts`. Run the full `bun run verify` once, before the commit. Fix every error it reports before you re-run it.
- **Goldens:** `bun run golden --filter <id-prefix>`. Never pass `--force` without a reason. If a golden hangs, the Reference CLI is probably retrying with backoff (timeouts, 5xx, 429), so add `--no-retry` to the case unless retries are what it tests.
- **Reading:** read line ranges of large files (`src/cli.ts` is about 900 lines). Cap searches with `rg -n -m 20 …` and long output with `| head -50`. Read GLOSSARY.md or an ADR only when the item touches that vocabulary or decision.
- **No web search** for anything this repo already records (spec, goldens, recordings, DIVERGENCES.md).

## Resume requests

- Treat requests to "resume" or "loop" as "Resume the project ladder": continue from the first unticked item in PLAN.md. Honor an explicit pause or stop request.
- **One fresh context per item.** As the orchestrator, don't implement items yourself. For each item, start a new subagent with your harness's native subagent tool (same model) and this brief:

  > One boci ladder iteration. Follow AGENTS.md ("Token budget", "One loop iteration") for exactly the next item from `bun run ladder`. Commit it. Reply in ≤5 lines: commit SHA and message, item state (ticked / split / stuck), and anything that needs the user.

  Wait for it. Check `git log -1 --oneline` and `bun run status | head -14`, then start the next subagent. Don't read source, diffs or test output yourself. Never run two item subagents at once: they share the working tree and the Ladder is sequential.

- With no subagent tool: do one item, then a second at most. Then stop and tell the user to start a new thread with "resume".

## Subagents (within an item)

- An item subagent may delegate bounded, independent research or validation (e.g. "which spec fields does X need", "why does golden Y differ") to its own subagent with clear report-back criteria. The item subagent owns its acceptance decision and commit.

## One loop iteration

1. `bun run ladder`. Take the item it prints.
2. If the item is too big for one commit, split it into smaller unticked items in PLAN.md (edit only that line) and take the first one. Mechanical work across many commands (e.g. generated cases for many services) is one generator pass, not one item per service. Group what fails by cause, one commit per cause.
3. Write the failing test first. For behaviour: add Parity cases to `test/parity/cases/*.json` (key = Leaf command path or Engine feature), run `bun run golden --filter <id-prefix>` to record what the Reference CLI does, then, for a Custom command or Engine feature, add the key to `IMPLEMENTED` in `src/registry.ts` so the case runs (and fails). Generated commands are implemented by rule (`engineSupports`); widen the rule or use `IMPLEMENTED`/`EXCLUDED` for exceptions. For tooling: a unit test.
4. Implement until it passes, using focused tests (see Token budget). Use `bun run parity:live` only to record or to confirm a feature against the real account, then rely on the Recording.
5. `bun run verify`: all green.
6. `bun run ladder tick`, update DIVERGENCES.md if needed, and commit to local `main`: one feature per commit, message `rung N: <item>`. Never push.

## When stuck

- After 3 honest attempts on one item: add an **unresolved** entry to DIVERGENCES.md (invocation, what differs, what was tried), run `bun run ladder stuck`, commit, and move on.
- Stop the loop and report when:
  - the Ladder is done;
  - something needs the user (credentials, a non-Always-Free resource, a Reference CLI upgrade);
  - a previously verified Parity test goes red and the cause isn't the current change.

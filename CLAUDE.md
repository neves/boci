# boci

A Bun drop-in for Oracle's `oci` CLI. Read [GLOSSARY.md](GLOSSARY.md) for vocabulary and [docs/adr/](docs/adr/) for the decisions that must not be "fixed". [PLAN.md](PLAN.md) is the Ladder.

## Ground rules

- The Reference CLI is `oci-cli==3.96.3` on Python 3.12, installed with `uv tool install --python 3.12 oci-cli==3.96.3`. Its behavior defines correct. Never "improve" on it.
- Bun-native code (use the `bun` skill). No runtime dependencies except a JMESPath library. No OCI SDK.
- Checks: `bun fmt --check`, `bun check`, `bun test`. Add `bun lint` once the installed Bun has it.
- Default `bun test` is offline and fast: never let it touch the network or the real `~/.oci`.
- Live calls only through `bun run parity:live`, which reads `.env.test` (`BOCI_TEST_PROFILE=<your profile>`). Live tests may:
  - run any read-only command;
  - create only Always-Free resources in the root compartment, named `boci-parity-*` and tagged `boci-parity=true`, and delete only resources carrying that tag.
  - Never touch IAM policies, users, groups, tenancy settings, or any untagged resource. Commands in those areas are request-only.
- Never commit unscrubbed Recordings (tenancy/user OCIDs, namespace, fingerprints) or anything from `~/.oci`.

## One loop iteration

1. Run `bun run status`. Take the first unticked item in PLAN.md.
2. If the item is too big for one commit, split it into smaller unticked items in PLAN.md first and take the first one.
3. Write the failing test first: a Parity test (request-only against the fake endpoint, or a replayed Recording) or, for tooling, a unit test.
4. Implement until it passes. Use `bun run parity:live` only to record or to confirm a feature against the real account, then rely on the Recording.
5. Run `bun fmt --check`, `bun check`, `bun test`. All green.
6. Tick the item in PLAN.md, update DIVERGENCES.md if needed, and commit to local `main`: one feature per commit, message `rung N: <item>`. Never push.

## When stuck

- After 3 honest attempts on one item: add an **unresolved** entry to DIVERGENCES.md (invocation, what differs, what was tried), mark the item `- [~]` in PLAN.md, and move on.
- Stop the loop and report when:
  - the Ladder is done;
  - something needs the user (credentials, a non-Always-Free resource, a Reference CLI upgrade);
  - a previously verified Parity test goes red and the cause isn't the current change.

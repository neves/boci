# 06: `bun run ladder sync` ticks verified items

**What to build:** `bun run ladder sync` marks `[x]` every unticked Ladder item whose Leaf command key is now verified (same definition `bun run status` uses), and prints how many it ticked per rung. Stuck items (`[~]`) that became verified are ticked too. Lets one commit that verifies hundreds of commands update the Ladder in one step.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Context for the implementer

- The ladder's pure core is a small library (find current item, mark current); status logic lives in a status library. Add a pure `syncItems(markdown, isVerified)` function and unit-test it with a small markdown fixture; the script only wires it to real data.
- Items look like ``- [ ] `apm-traces trace span get` ``. Only touch the checkbox character.
- Don't read PLAN.md in full; it's ~1,500 lines. Test against fixtures.

## Acceptance criteria

- [ ] Unit test: ticks verified items, leaves unverified and non-command items alone, idempotent on a second run.
- [ ] Running it on the current repo changes nothing (or only items that are genuinely verified).
- [ ] Documented in one line in AGENTS.md "Token budget" next to `ladder tick`.
- [ ] `bun run verify` green.

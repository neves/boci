# 03: Engine runs POST/PUT actions without a body

**What to build:** The 395 Generated commands that are POST (394) or PUT (1) with no direct body and no body options — "action" endpoints such as `data-safe audit-trail stop`, `data-safe audit-trail resume`, `data-safe audit-policy retrieve`, `log-analytics query-work-request background` — run through the generic Engine and match the Reference CLI.

**Blocked by:** None (can start immediately).

**Status:** done

## Context for the implementer

- `engineSupports` in the registry currently rejects writes without at least one simple body binding. Widen it for: operation has no `body` and no binding targets `body`.
- Check what the Reference CLI sends: open one golden (`test/parity/golden/<id>.json`) for such a command and look at the recorded request — method, path, query, headers (`content-length: 0`? `content-type`?), and body (empty vs `{}`). Match it exactly.
- Generated request cases and goldens already exist in `test/parity/cases/generated-request-*.json`; they start running once `engineSupports` accepts the command. Run with `BOCI_PARITY_ALL=1 bun test test/parity -t '<key>'`.
- Some of these commands carry waiter options (`--wait-for-state`); work-request and lifecycle waiters already exist as Engine features.
- If a golden is missing, `bun run golden --filter <id-prefix>`; add `--no-retry` to the case if it hangs.

## Acceptance criteria

- [ ] All 395 commands report verified in `bun run status` or are in `EXCLUDED` with a reason.
- [ ] Failures grouped by cause, one commit per cause (`engine: <cause>`). If more than ~3 distinct causes appear, fix the first ones and file a follow-up ticket per remaining cause.
- [ ] `bun run ladder sync` (if ticket 06 is done) run; `bun run verify` green.

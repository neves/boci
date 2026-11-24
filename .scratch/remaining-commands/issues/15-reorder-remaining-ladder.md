# 15: Reorder what's left of Rung 8 by importance

**What to build:** After automatic tiers land, the remaining unticked Rung 8 items (hand-written Tier C commands plus anything excluded along the way) are reordered by user importance instead of guessed difficulty, so the normal one-item-per-subagent Ladder loop works on the most useful commands first. The Ladder-pause note in CLAUDE.md is removed.

**Blocked by:** 06: ladder sync, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28.

**Status:** done

## Context for the implementer

- Ticket 10's report (`.scratch/remaining-commands/tier-b-report.md`) lists 22 Tier B commands with own logic (SDK lookups, printing, waiting) and all 202 Tier C commands per service; they stay hand-written Rung 8 items and are ordered here like Tier C.
- Run `bun run ladder sync` first, then count what's left per service (`bun run status`).
- Order: (1) compute (`compute instance launch`, `compute instance list-vnics`, `compute instance attach-vnic`), ce (`ce cluster create-kubeconfig`), iam, bv, network; (2) db, fn (`fn function invoke`), resource-manager, kms/vault, artifacts, logging, monitoring; (3) remaining services alphabetically; (4) file transfers, streaming and bulk commands last.
- Keep difficulty as a tag in each group heading if useful, but the order is by importance.
- Investigate why `raw-request` (a Custom command, not implemented) is absent from the Ladder; add it in tier (1) or record the reason in DIVERGENCES.md.
- Edit PLAN.md with targeted edits (it's ~1,500 lines); preserve the `- [x] \`key\``item format the ladder script parses, and confirm`bun run ladder` prints the expected next item.

## Acceptance criteria

- [x] Rung 8 contains only genuinely remaining items, in the order above.
- [x] `raw-request` resolved (on the Ladder or documented).
- [x] The Ladder-pause note removed from CLAUDE.md.
- [x] `bun run verify` green. Commit: `docs: reorder rung 8 by importance`.

Reconciled Rung 8 with all 210 missing Leaf commands. The old `raw-request` item included a trailing space, and the old list omitted `ocvs sddc retrieve-sddc-operation-status`. The first remaining Compute item is `compute instance list-vnics` because `compute instance launch` is verified. The Object Storage namespace lookup is a separate Engine item.

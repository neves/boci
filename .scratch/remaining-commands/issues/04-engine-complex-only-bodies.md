# 04: Engine runs requests whose body options are all complex

**What to build:** The 308 Generated PATCH (69), PUT (73) and POST (166) commands whose body is built only from complex (JSON) options run through the Engine. Examples: `data-safe masking-column patch`, `data-safe security-assessment patch-checks` (JSON-Patch `items` arrays), `db console-connection update`, `data-safe target-database activate`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Context for the implementer
- The Engine already builds bodies that mix simple and complex options; `engineSupports` merely refuses commands where every body binding is complex. Widen the rule, then let the cases tell you what's actually different.
- Likely differences to check against goldens: a body that is a top-level JSON array, `--from-json` for the whole body, `generate-full-command-json-input` output, required complex options, content-type for JSON-Patch.
- Cases and goldens already exist (`generated-request-*`). Run focused: `BOCI_PARITY_ALL=1 bun test test/parity -t '<key>'`.
- Spec details per command: `bun run spec <service> <command…>`. Never cat spec files.

## Acceptance criteria
- [ ] All 308 commands verified or in `EXCLUDED` with a reason.
- [ ] One commit per failure cause; more than ~3 causes → follow-up tickets for the rest.
- [ ] `bun run verify` green.

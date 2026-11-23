# 02: Split the Object Storage command module by feature

**What to build:** The ~5,100-line Object Storage Custom command module becomes a directory with one module per feature (object get, put, resume-put/multipart, bulk upload/download/delete, sync, shared helpers). Each registers its handlers in the registry from ticket 01. This sets the layout every future hand-written service follows: one directory per service, one module per group or feature. No behaviour change.

**Blocked by:** 01: Handler registry with lazy dispatch.

**Status:** ready-for-agent

## Context for the implementer
- Purely mechanical moves. Do not edit logic while moving; if you spot a bug, note it in the commit body instead.
- Read the file in ranges (it is huge); first list its top-level functions with `rg -n "^export (async )?function|^function|^const" ` capped with `| head -80`, then plan the cut lines.
- Shared helpers (multipart math, transfer manager, etc.) go in one shared module inside the directory.
- The hand-written cases `os-object-*.json` are the safety net: run `bun test test/parity -t 'os object'` after each move.

## Acceptance criteria
- [ ] No module in the new directory exceeds ~1,200 lines.
- [ ] All `os object *` Parity cases pass unchanged.
- [ ] `bun run verify` green. Commit message: `refactor: split os commands by feature`.

# 02: Share binary output across download commands

**What to build:** Use one byte-writing implementation for generated and Object Storage downloads while keeping each command’s file-opening and progress behavior.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A multichunk binary response reaches stdout and a named file byte for byte through both command paths.
- [ ] Partial file writes are completed before advancing to the next chunk.
- [ ] A generated download with an empty response leaves an absent destination uncreated.

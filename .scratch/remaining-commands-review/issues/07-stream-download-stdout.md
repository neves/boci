# 07: Stream downloads to stdout as chunks arrive

**What to build:** Make the shared binary output path respect backpressure so a piped consumer can process a download before it finishes.

**Blocked by:** 02 — Share binary output across download commands

**Status:** ready-for-agent

- [ ] In an offline delayed-response test the consumer receives the first chunk while the server is still withholding the final chunk.
- [ ] The complete piped output is byte-exact, including non-text bytes.
- [ ] The writer awaits downstream capacity instead of retaining the full download until command exit.

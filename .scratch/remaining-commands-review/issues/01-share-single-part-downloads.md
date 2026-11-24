# 01: Share single-part Object Storage downloads

**What to build:** Use one single-part transfer routine for bulk-download and sync so fixes reach both commands.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Both commands write the same binary fixture byte for byte.
- [ ] An existing directory at the destination and an unsuccessful GET retain each command’s established behavior, including diagnostics and exit status.

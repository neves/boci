# 08: Report invalid download destinations like Click

**What to build:** Report a lazy download file-open failure in the same way as the Reference CLI.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] With a nonempty successful response and a missing destination parent, download-package matches the Reference CLI stderr and exit status.
- [ ] With an empty successful response, the same destination stays unopened and the result matches the golden.

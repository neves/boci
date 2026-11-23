# 03: Publish and verify release SHA256 checksums

**What to build:** Tagged releases include a `SHA256SUMS` manifest covering every published binary, and both the shell and PowerShell installers verify the downloaded binary's checksum before installing it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The release workflow generates and uploads a `SHA256SUMS` file containing SHA-256 digests for all release binaries.
- [ ] The shell installer downloads `SHA256SUMS`, verifies the matching binary's digest, and aborts without installing if verification fails.
- [ ] The PowerShell installer downloads `SHA256SUMS`, verifies the matching binary's digest, and aborts without installing if verification fails.

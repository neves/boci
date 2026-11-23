# 06: Add npm metadata and community health files

**What to build:** The npm package includes full discovery metadata, and the repository provides standard security, contribution, changelog, and issue-reporting documentation.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The package manifest includes `license`, `repository`, `homepage`, `bugs`, and `keywords` fields.
- [ ] `SECURITY.md` documents how to report security and credential-handling vulnerabilities.
- [ ] `CONTRIBUTING.md` documents how to run verification checks, add parity test cases, and avoid committing sensitive recordings.
- [ ] `CHANGELOG.md` is added and linked from release notes (or release notes are auto-generated on tag push).
- [ ] A GitHub issue template for parity mismatches prompts for `oci` vs `boci` output, exit codes, and version info.

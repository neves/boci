# 02: Add continuous CI workflow on push and PR

**What to build:** Every push to `main` and every pull request automatically runs the full verification suite across Linux, macOS, and Windows, with all workflow actions on supported Node.js runtimes.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A CI workflow runs on `push` to `main` and on `pull_request` across Ubuntu, macOS, and Windows runners.
- [x] Each OS job installs dependencies and passes the full `verify` check (formatting, type-checking, build, and parity tests).
- [x] Deprecated Node 20 GitHub Actions across existing workflows are updated to current major versions so no Node 20 deprecation annotations appear.

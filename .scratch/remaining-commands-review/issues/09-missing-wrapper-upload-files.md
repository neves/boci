# 09: Report missing wrapper upload files like Python

**What to build:** Give callers the Python file error when a wrapper opens a missing upload source.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] With a missing job artifact file, create-job-artifact reproduces the Reference CLI FileNotFoundError diagnostic and exits 1.
- [ ] The failure occurs before any service request and without suggesting a fallback.

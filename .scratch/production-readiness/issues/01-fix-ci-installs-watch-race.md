# 01: Fix ci-installs workflow watch race

**What to build:** Running `mise run ci-installs` reliably waits for the newly triggered GitHub Actions run instead of failing with an immediate `404` right after dispatch.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Dispatching the install-test workflow waits or retries briefly until GitHub registers the new run ID before watching it.
- [ ] Running `mise run ci-installs` no longer exits with `HTTP 404: Not Found` immediately after printing the workflow run URL.

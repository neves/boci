# 05: Engine runs requests whose body is a file or raw data

**What to build:** The 41 Generated POST (26) and PUT (15) commands whose request body is a direct, non-JSON payload (file upload or stream) run through the Engine. Examples: `data-safe masking-policy upload`, `data-safe sensitive-data-model upload`, `data-safe sensitive-type bulk-create`, `os-management-hub software-source update-software-source-manifest`, `data-science model update-model-custom-metadatum-artifact`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Context for the implementer
- Look at a golden to learn how the Reference CLI reads the file option (path vs `file://`), which content-type and content-length it sends, and whether it streams.
- `os object put` already sends raw file bodies; reuse its upload helpers where they fit rather than writing a second implementation.
- `bulk-create` may be a JSON array body rather than binary — check each subgroup before generalizing.
- Cases for file bodies need a fixture file; keep fixtures tiny under `test/fixtures`.

## Acceptance criteria
- [ ] All 41 commands verified or in `EXCLUDED` with a reason.
- [ ] Test runs stay offline and don't read real `~/.oci`.
- [ ] `bun run verify` green.

# 04: Share pre-open file and directory permission checks across Click and Object Storage

**What to build:** Use one shared pre-open file accessibility check across Click file readers/writers and one shared directory read-accessibility check across Object Storage bulk/sync commands so directory and Windows permission errors behave identically everywhere.

**Blocked by:** 02: Move boci Windows permission sidecar helper to `src/lib/` and avoid stale entries

**Status:** complete

- [x] Click file read, write, and wrapper-program file openers share one pre-open directory and permission check without duplicating logic.
- [x] Object Storage `bulk-download`, `bulk-upload`, and `sync` share one directory read-access check and preserve all existing diagnostics and exit codes.

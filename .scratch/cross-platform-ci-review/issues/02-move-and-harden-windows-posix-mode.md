# 02: Move boci Windows permission sidecar helper to `src/lib/` and avoid stale entries

**What to build:** Place the boci-specific POSIX permission sidecar helper in `src/lib/` as required by repo conventions, apply real `chmodSync` on Windows alongside the sidecar, and invalidate sidecar records when a target file is replaced or recreated so stale synthetic modes never leak across runs.

**Blocked by:** None (can start immediately)

**Status:** complete

- [x] The boci-specific permission helper lives under `src/lib/` (not `src/utils/`) and all callers are updated.
- [x] Deleting and recreating a file or directory at the same path on Windows does not inherit a previously recorded sidecar mode (e.g. `0o000`), and `chmodSync` is still invoked on Windows for OS-level read-only bit enforcement.

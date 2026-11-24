# 03: Record executable mode in Windows branch of `boci update`

**What to build:** Ensure `replaceBinary` in `boci update` records executable (`0o755`) permissions when replacing a binary on Windows (`platform === "win32"`) just as it does on POSIX platforms.

**Blocked by:** 02: Move boci Windows permission sidecar helper to `src/lib/` and avoid stale entries

**Status:** complete

- [x] Running `replaceBinary` with `platform = "win32"` leaves the target binary with mode `0o755` (`getPosixMode(bin) & 0o111` is non-zero).
- [x] Unit tests cover the `"win32"` branch of `replaceBinary` directly.

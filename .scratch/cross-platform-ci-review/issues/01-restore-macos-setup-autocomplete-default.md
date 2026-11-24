# 01: Restore real macOS default profile in `setup autocomplete`

**What to build:** Ensure `boci setup autocomplete` follows the Reference CLI's macOS (`darwin`) behavior in production—defaulting to and creating `~/.bash_profile` instead of `~/.bashrc`—while allowing the parity test harness to override the platform when running Linux-recorded goldens.

**Blocked by:** None (can start immediately)

**Status:** complete

- [x] On macOS (`darwin`) without `BOCI_SETUP_PLATFORM` set, `boci setup autocomplete` prefers and offers to create `~/.bash_profile` just like `oci setup autocomplete`.
- [x] When `BOCI_SETUP_PLATFORM` is set (e.g. to `linux` in the parity test harness or `darwin` in unit tests), `boci setup autocomplete` honors the override so Linux-recorded parity goldens pass on macOS and Windows.

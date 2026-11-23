# 08: Add boci update self-update command

**What to build:** Users who installed the standalone binary can run a self-update command to fetch, checksum-verify, and replace their binary with the latest release, or receive a clear upgrade hint if managed by a package manager.

**Blocked by:** 03: Publish and verify release SHA256 checksums

**Status:** done

- [x] Running the self-update command checks the latest release and reports if already up to date.
- [x] When a newer release exists for the current OS/architecture, it downloads the binary, verifies its digest against `SHA256SUMS`, and atomically replaces the running executable.
- [x] When installed via Homebrew, Scoop, mise, Nix, AUR, or npm, it detects or warns appropriately with the package manager's upgrade command instead of corrupting managed files.
- [x] Tests cover up-to-date, upgrade, checksum-mismatch abort, and Windows/POSIX replacement behavior.

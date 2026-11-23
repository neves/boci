# 05: Automate package manager updates on release

**What to build:** Pushing a release tag automatically updates the Homebrew tap, Scoop bucket, AUR package, and Nix flake with the new version and SHA-256 checksums.

**Blocked by:** 03: Publish and verify release SHA256 checksums

**Status:** done

- [x] On release, the Homebrew formula, Scoop manifest, AUR `PKGBUILD`/`.SRCINFO`, and Nix flake hashes are updated for the new tag using the published `SHA256SUMS`.
- [x] External tap/bucket/AUR pushes fail loudly in CI if required credentials are missing, without silently skipping.
- [x] Installing via Homebrew, Scoop, and Nix after a release resolves the new version cleanly.

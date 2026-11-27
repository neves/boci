# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] - 2026-11-26

### Added

- **100% OCI CLI command parity (all 9,372 leaf commands verified against `oci-cli==3.96.3`)**:
  - Compiled Tier A/B/C wrapper engine supporting complex-only bodies, direct file request bodies, bodyless write actions, compiled argument checks, renamed options, and SDK delegation.
  - Custom commands including Object Storage bulk/sync/multipart/delete operations, `setup bootstrap` and `setup pkcs11-auth`, `fn function invoke`, image signatures, DB tokens, instance principal setup, and `raw-request` sessions.
- **`boci update`** self-update command with SHA256 checksum verification.
- **Differential fuzzing (`bun run fuzz`)** and **read-only live side-by-side parity runner (`mise run live-parity`)** verified across 1,105+ live READ commands in 154 OCI services against `oci-cli==3.96.3` (4.65× overall / 5.83× median speedup).
- **Release & installation tooling**: cross-platform binaries (Linux glibc/musl, macOS x64/arm64, Windows x64), `SHA256SUMS` verification, GitHub build provenance attestations, npm OIDC provenance publishing, Nix flake, AUR `PKGBUILD`, Homebrew/Scoop/curl/PowerShell install scripts, continuous CI across Linux/macOS/Windows, and landing page deployment.

### Fixed

- **Live OCI API parity fixes**:
  - Honor `client.dualStackByDefault` and `OCI_DUAL_STACK_ENDPOINT_ENABLED` when resolving endpoints (`jms`, `jms-utils`).
  - Deserialize empty HTTP 204 bodies and `[]` array bodies for model `responseType` into null-initialized model fields (`data-safe`, `vulnerability-scanning`).
  - Suppress pagination `WARNING:` when `opc-next-page` response header is empty (`threat-intelligence`).
  - Preserve original endpoint template hostname casing in `ServiceError.request_endpoint` (`cpg`).
  - Escape non-ASCII characters as `\uXXXX` in `ServiceError` JSON output (`db maintenance-run list`).
- **Differential fuzzing & cross-platform fixes**:
  - SDK model deserialization (enums, datetimes, floats, polymorphism, nulls), JMESPath `--query` / `--output table` / `--raw-output`, `--all` and `--limit` pagination, non-ASCII request body framing and signing, interactive mode (`-i`), and validation/confirmation ordering.
  - Resolved all Windows CI test failures and `bun lint` warnings across `src/`, `scripts/`, and `test/`.

## [0.0.1] - 2026-04-01

### Added

- Initial `boci` CLI implementation with `oci-cli==3.96.3` spec extraction, argument parsing, help rendering, config/rc handling, request signing, and endpoint resolution.
- Parity test harness, golden recording tooling, and cross-platform binary build pipeline.

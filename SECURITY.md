# Security Policy

## Reporting a Vulnerability

**Please do not report security or credential-handling vulnerabilities through public GitHub issues.**

If you discover a security issue in `boci`—especially anything involving credential handling, private key permissions, request signing, config parsing (`~/.oci/config`), session tokens, instance/resource principal authentication, or accidental secret leakage—please report it privately via GitHub Security Advisories:

- <https://github.com/neves/boci/security/advisories/new>

When reporting, please include:

- A clear description of the vulnerability and its potential impact.
- Steps to reproduce (command invoked, relevant flags, and environment details—with all real OCIDs, keys, fingerprints, and tokens redacted).
- The `boci --version` output and operating system/architecture.

We aim to acknowledge reports within 72 hours and coordinate a fix and disclosure timeline with you before publishing details.

## Supported Versions

Security fixes are provided for the latest released version and the `main` branch.

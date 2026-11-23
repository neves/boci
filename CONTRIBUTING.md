# Contributing to boci

Thank you for helping make `boci` a faithful, fast drop-in replacement for the Oracle Cloud Infrastructure (`oci`) CLI.

## Ground Rules

- **Reference CLI:** `oci-cli==3.96.3` on Python 3.12 (`uv tool install --python 3.12 oci-cli==3.96.3`). Its behavior defines correct—never "improve" on it.
- **No extra runtime dependencies:** Only `jmespath` is used at runtime. No OCI SDK.
- **Vocabulary & ADRs:** Check [`GLOSSARY.md`](GLOSSARY.md) and [`docs/adr/`](docs/adr/) before changing core behavior.

## Running Verification Checks

Run the full verification suite before opening a PR:

```console
$ bun run verify
```

This runs formatting checks (`bun fmt --check`), TypeScript type checking (`bun check`), compiles `dist/boci`, and executes all unit and parity tests (including generated cases) against `dist/boci`.

For fast offline iteration while developing:

```console
$ bun test                                  # unit tests + hand-written parity cases
$ bun test test/unit/<file>.test.ts         # single unit test file
$ bun test test/parity -t '<id or key>'     # single parity case
```

## Adding Parity Test Cases

1. Add a case to `test/parity/cases/*.json` with `key` set to the Leaf command path (e.g. `"os ns get"`) or Engine feature.
2. Record the Reference CLI's behavior into `test/parity/golden/<id>.json`:
   ```console
   $ bun run golden --filter <id-prefix>
   ```
   (Use `--no-retry` in the case if the Reference CLI would otherwise retry with backoff.)
3. For a Custom command or Engine feature, add its `key` to `IMPLEMENTED` in `src/core/registry.ts` (generated commands are governed by `engineSupports` / `EXCLUDED`).
4. Implement the behavior and verify with `bun run verify`.

If a difference from `oci` is intentional or currently unresolvable, document it in [`DIVERGENCES.md`](DIVERGENCES.md).

## Sensitive Data & Recordings

**Never commit unscrubbed recordings or anything from `~/.oci`.**

- Committed fixtures and recordings in `test/recordings/` and `test/parity/golden/` must never contain real tenancy/user OCIDs, namespaces, key fingerprints, private keys, session tokens, or local home directory paths.
- Live tests (`bun run parity:live`) use `.env.test` (`BOCI_TEST_PROFILE=<profile>`) and must only create Always-Free resources named `boci-parity-*` tagged `boci-parity=true`.

# boci plan

boci is a Bun drop-in for the Reference CLI (`oci-cli==3.96.3`, Python 3.12). Vocabulary: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr/](docs/adr/). How to execute one step: [CLAUDE.md](CLAUDE.md).

This file is the **Ladder**. Work top to bottom. Each `- [ ]` item is one baby step = one commit. `bun run status` parses this file, so keep the checkbox format exact. Tick an item only when its acceptance check passes.

## Targets

- Parity: same stdout (byte-exact after masks), same parsed stderr error, same exit code, same config/env behavior. Help: same flags and descriptions, layout may differ.
- `boci --version` prints `3.96.3`.
- Startup: `--version` < 50 ms, first request on the wire < 100 ms (Reference CLI: ~420 ms just for `--version`).
- Builds: linux-x64, linux-arm64, darwin-x64, darwin-arm64. Windows is a late rung.
- Default `bun test` is fully offline. Live account only via `bun run parity:live` during implementation.

## Repository layout (target)

```
tools/extract/extract.py   uv script: walks the Reference CLI Click tree → spec/
spec/index.json            services → command groups → leaf commands (+ generated|custom)
spec/<service>.json        per-service leaf commands: flags, defaults, help, operation mapping
src/main.ts                boci entry point
src/…                      engine: config, parser, signer, http, output, query, pagination
src/custom/<service>/…     hand-written Custom commands
test/harness/              fake endpoint, recorder proxy, CLI runner, comparator, masks
test/fixtures/             throwaway API key + config (fake tenancy) for offline runs
test/recordings/           scrubbed live recordings (committed)
test/parity/               parity cases (generated + hand-written)
scripts/status.ts          `bun run status`
DIVERGENCES.md             recorded Divergences
```

## Rung -1 — Foundations (measure before building)

- [x] Bun project skeleton: `package.json` scripts (`status`, `extract`, `build`, `test`, `parity:live`), strict `tsconfig.json`, `.gitignore` (incl. `.env.test`), `bun fmt` + `bun check` + `bun test` green on an empty test.
- [x] Extractor v1: `tools/extract/extract.py` (uv inline deps, Python 3.12, `oci-cli==3.96.3`) dumps the full Click tree after overrides to `spec/index.json`: every group and leaf command with name, aliases, hidden flag. Acceptance: leaf count printed and committed.
- [x] Extractor v2: per leaf command, every option (names, short aliases, type, required, default, multiple, is_flag, choices, help) and global options into `spec/<service>.json`.
- [x] Extractor v3a: classify each leaf as `generated` (callback defined in a `generated` module) or `custom`; record counts per service.
- [x] Extractor v3b: for each generated leaf, join to its SDK client method: HTTP method, path template, path/query/header params, body param and model, response model, whether it paginates.
- [x] Extractor v3c: for each generated leaf, map every CLI option to where it lands (path/query/header param or body field with its JSON key and complex type).
- [x] `bun run status`: reads `spec/`, parity results and this Ladder; prints per-service missing/implemented/verified counts, totals, the engine-feature (Ladder) checklist, and Divergences. Everything starts as missing.
- [x] Offline fixtures: generate a throwaway RSA key + `test/fixtures/config` with a fake tenancy/user so both CLIs sign requests with no real credentials.
- [x] Harness a: fake endpoint (`Bun.serve`) that records every request (method, path, query, headers, body) and serves a canned response per case.
- [x] Harness b: CLI runner that runs a CLI (`oci` or `boci`) with argv in a sandbox against the fake endpoint and returns stdout, stderr, exit code and captured requests.
- [x] Harness c: Parity case + golden format; `bun run golden` runs the Reference CLI for every case (parallel) and stores its observation; comparator with the central mask list; `bun test` compares boci against goldens only (ADR 0004).
- [x] Recorder: a `sitecustomize.py` hook (loaded via `PYTHONPATH`) logs every request/response the real `oci` makes, so TLS and signatures stay intact; a scrubber replaces OCIDs, namespace and fingerprint with stable fakes; `bun run record <id> -- <oci args>` writes `test/recordings/<id>.json`. Used only for live work. (A forwarding proxy can't work: the signed `host` header would no longer match.)
- [x] `DIVERGENCES.md` with the entry format and an empty list.

## Rung 0 — Offline behavior

- [x] `boci --version` → `3.96.3`, compiled binary via `bun build --compile`, startup measured in status.
- [x] Leaf command help (`oci os ns get --help`): byte-exact Click help (port of Click's HelpFormatter + Python textwrap, oci's list-boundary tweak), help records extracted from Click itself; stdout, exit 0; honours `COLUMNS`.
- [x] Group help (`oci os --help`, `oci os ns --help`): Click group help with command short-help truncation; stderr, exit 2 (Click's no-subcommand path).
- [x] Root help (`oci --help`): oci's category-grouped command list and global options; stdout, exit 0.
- [x] Ship `spec/` inside the compiled binary (today `dist/boci` reads `spec/` from the source tree): per-service embedded files, loaded lazily; keep `--help` within the start-up budget.
- [x] Click-compatible parser (ADR 0003): `--opt value`, `--opt=value`, flags, `--x/--no-x`, multiple, short aliases. (Port of Click's _OptionParser + difflib suggestions, checked against 1,075 cases from Click's real parser.)
- [x] Usage errors: Click's invocation flow (root options anywhere, stock vs oci-patched error display, unknown command/option, missing value, extra args, Missing command, `--max-retries` + `--no-retry`) — 25 parity cases. Sandbox now routes non-local traffic to a dead proxy.
- [x] Value conversion errors: Click types (Choice, INT, FLOAT, BOOL, File, oci custom types) with Click's messages, for root and leaf options.
- [x] Missing required options: oci's own check (`Missing option(s) --x.` with usage, stderr, exit 1), after defaults from `oci_cli_rc`/`--from-json` are considered.
- [ ] Missing-command handling: "not implemented yet" error with a distinct exit code; `BOCI_FALLBACK=oci` hands the command to the Reference CLI.
- [ ] Config file: `--config-file`, `--profile`, `OCI_CLI_PROFILE`, `OCI_CLI_CONFIG_FILE`, `DEFAULT` inheritance, missing-profile/missing-file errors, file-permission warnings, the missing `OCI_API_KEY` key-label warning.
- [ ] `oci_cli_rc`: default values per command, command aliases, parameter aliases, `--cli-rc-file`.

## Rung 1 — First signed request

- [ ] API-key request signer (ADR 0002), verified byte-for-byte against the Reference CLI's signature over the fake endpoint.
- [ ] Region → endpoint resolution (region, realm, `--region`, `--endpoint`, `OCI_CLI_REGION`).
- [ ] `boci os ns get` — request-only parity, then live parity confirmed once with the `.env.test` profile.
- [ ] Service error mapping: non-2xx → same stderr JSON (`code`, `message`, `status`, `target_service`, …) and exit code.
- [ ] Global options: `--request-id`, `--debug` (shape only), `--connection-timeout`, `--read-timeout`, `--max-retries`/`--no-retry`.

## Rung 2 — Generated GETs

- [ ] Path parameters + query parameters for any generated GET. Auto-generate request-only parity cases for every generated GET; a pass marks those leaf commands verified.
- [ ] Response headers surfaced like the Reference CLI (`etag`, `opc-next-page` in output where applicable).
- [ ] HEAD and DELETE without body; `--force` and confirmation prompts.

## Rung 3 — Lists and output

- [ ] Pagination: `--limit`, `--page`, `--all`, `--page-size`.
- [ ] `--query` (JMESPath, incl. oci's custom functions).
- [ ] `--output table` byte-exact; `--raw-output`.
- [ ] Recordings: curated live list/get recordings across services, replayed offline.

## Rung 4 — Request bodies

- [ ] Simple-typed body flags for generated POST/PUT/PATCH; auto-generated request-only cases for every such command.
- [ ] Complex JSON flags, `file://` and `--from-json`, `--generate-full-command-json-input`, `--generate-param-json-input`.
- [ ] Polymorphic bodies (discriminator subcommands).
- [ ] `--if-match`, `--if-none-match`, extra headers.
- [ ] First mutating live tests on Always-Free, test-owned resources in the root compartment (name `boci-parity-*`, freeform tag `boci-parity=true`), with cleanup that deletes only tagged resources.

## Rung 5 — Waiters

- [ ] `--wait-for-state`, `--max-wait-seconds`, `--wait-interval-seconds`.
- [ ] Work-request waiters.

## Rung 6 — Other auth methods

- [ ] `--auth security_token` (session token config).
- [ ] `--auth instance_principal` (request-only against a fake metadata service).
- [ ] `--auth resource_principal`.
- [ ] `--auth api_key` with passphrase-protected keys.

## Rung 7 — Custom commands (hardest last)

Ordered by the extractor's custom list, simplest first. Expand this rung into one item per Custom command once Extractor v3 exists.

- [ ] Object Storage: `object put`/`get` single-part, then multipart, then `bulk-upload`/`bulk-download`/`bulk-delete`, then `sync`.
- [ ] `setup config`, `setup keys`, `setup repair-file-permissions`, `setup autocomplete`.
- [ ] `session authenticate`/`refresh`/`validate`/`export`/`import`.
- [ ] Remaining Custom commands, one item each.
- [ ] Interactive mode (`-i`).
- [ ] Windows support.

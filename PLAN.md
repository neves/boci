# boci plan

boci is a Bun drop-in for the Reference CLI (`oci-cli==3.96.3`, Python 3.12). Vocabulary: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr/](docs/adr/). How to execute one step: [AGENTS.md](AGENTS.md).

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
- [x] `bun run status`: reads `spec/`, parity results (untracked `test/parity/results.json`, written by a full `bun run verify`) and this Ladder; prints per-service missing/implemented/verified counts, totals, the engine-feature (Ladder) checklist, and Divergences. Everything starts as missing.
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
- [x] Missing-command handling: "not implemented yet" error with a distinct exit code; `BOCI_FALLBACK=oci` hands the command to the Reference CLI.
- [x] Config file: configparser + `oci.config.from_file` ports (76 fixtures from oci itself), `--config-file`/`OCI_CLI_CONFIG_FILE`, `--profile`/`OCI_CLI_PROFILE`, `OCI_CLI_AUTH`, DEFAULT inheritance, the `OCI_API_KEY` key-label warning (8 parity cases). File-permission warnings and config-error display happen when the client is built → rung 1.
- [x] `oci_cli_rc` a: file location (`--cli-rc-file`/`--defaults-file`, `OCI_CLI_RC_FILE`, `~/.oci/oci_cli_rc`, `~/.oci/cli-defaults`) and `[OCI_CLI_SETTINGS]` `default_profile`.
- [x] `oci_cli_rc` b: default values per profile section (lookup hierarchy `compute.instance.list.compartment-id` → … → `compartment-id`) feeding the required check.
- [x] `oci_cli_rc` c: `[OCI_CLI_COMMAND_ALIASES]` global and command-sequence aliases, incl. the "Could not use … as an alias" warning.
- [x] `oci_cli_rc` d: `[OCI_CLI_PARAM_ALIASES]` (parsing, help text, collision warnings).

## Rung 1 — First signed request

- [x] Start-up: split the runtime index so `--version`/root parsing reads only what it needs (the command tree per service lives with the service). Target `--version` ≤ 15 ms and ≤ 50 MB RSS with the compiled binary (now 27 ms / 57 MB).
- [x] Refresh README.md and site/index.html numbers from `bench/results/latest.json` (help and usage errors are now measured).
- [x] API-key request signer (ADR 0002), verified byte-for-byte against the Reference CLI's signature over the fake endpoint.
- [x] Region → endpoint resolution: port of oci.regions + BaseClient endpoint logic (short codes, realms, domain-style regions, `OCI_DEFAULT_REALM`, realm-specific templates, `{dualStack?…}` options, base paths, `--endpoint`), 1,800 fixtures from real SDK clients. CLI region precedence (`--region`, `OCI_CLI_REGION`, rc, config) lands with `os ns get`.
- [x] `boci os ns get` — request-only parity.
- [x] `boci os ns get` — live parity confirmed once with the `.env.test` profile.
- [x] Client build errors: config file/profile not found, as oci prints them when executing.
- [x] Client build errors: invalid key file, as oci prints them when executing.
- [x] Client build warnings: file-permission warnings for config and key, as oci prints them when executing.
- [x] Service error mapping: non-2xx → same stderr JSON (`code`, `message`, `status`, `target_service`, …) and exit code.
- [x] Global option: `--request-id`.
- [x] Global option: `--debug` (shape only).
- [x] Global option: `--connection-timeout`.
- [x] Global option: `--read-timeout`.
- [x] Global option: `--no-retry` disables SDK retries and omits `opc-client-retries`.
- [x] Global option: `--max-retries` sets the maximum attempt count (the Reference CLI's `max_attempts`).
- [x] External region sources: `~/.oci/regions-config.json` and `OCI_REGION_METADATA`.
- [x] Realm-specific endpoint params such as `{namespaceName+Dot}`.

## Rung 2 — Generated GETs

- [x] Generated GET path parameters, verified with `compute boot-volume-attachment get`.
- [x] Generated GET query parameters, verified with `compute global-image-capability-schema list`.
- [x] Auto-generate request-only parity cases for all generated GETs in Compute.
- [x] Auto-generate request-only parity cases for all generated GETs in Object Storage and IAM.
- [x] Finish 3,230 passing generated GET request-only cases across remaining services; 194 cases fail in two causes.
- [x] Fix generated GET requests missing `opc-retry-token` (request-only parity case setup).
- [x] Fix generated GET paths that leave operation parameter placeholders literal instead of substituting values.
- [x] Response headers surfaced like the Reference CLI (`etag`, `opc-next-page` in output where applicable).
- [x] HEAD and DELETE without body; `--force` and confirmation prompts.

## Rung 3 — Lists and output

- [x] Pagination: `--limit`, `--page`, `--all`, `--page-size`.
- [x] `--query` (JMESPath, incl. oci's custom functions).
- [x] `oci_cli_rc` e: `[OCI_CLI_CANNED_QUERIES]` — `--query query://name`.
- [x] `--output table` byte-exact; `--raw-output`.
- [x] Recordings: curated live list/get recordings across services, replayed offline.

## Rung 4 — Request bodies

- [x] Simple-typed body flags for generated POST/PUT/PATCH.
- [x] Auto-generated request-only cases for every generated POST/PUT/PATCH command.
- [x] Fix generated request query/header mismatches (missing query args and Log Analytics `Expect: 100-continue`).
- [x] Fix generated request signature mismatches for special PUT body shapes.
- [x] Complex JSON body flags, including `file://` values.
- [x] `--from-json` loading and command-line override behavior.
- [x] `--generate-full-command-json-input` and `--generate-param-json-input`.
- [x] Polymorphic bodies (discriminator subcommands).
- [x] `--if-match`, `--if-none-match`, extra headers.
- [x] First mutating live tests on Always-Free, test-owned resources in the root compartment (name `boci-parity-*`, freeform tag `boci-parity=true`), with cleanup that deletes only tagged resources.

## Rung 5 — Waiters

- [x] `--wait-for-state`, `--max-wait-seconds`, `--wait-interval-seconds`.
- [x] Work-request waiters for Generated commands using their own client.
- [x] Work-request waiters for Generated commands that use a separate work-request client.

## Rung 6 — Other auth methods

- [x] `--auth security_token` (session token config).
- [x] `--auth instance_principal` (request-only against a fake metadata service).
- [x] `--auth resource_principal`.
- [x] `--auth api_key` with passphrase-protected keys.

## Rung 7 — Custom commands (hardest last)

Ordered by the extractor's custom list, simplest first. Expand this rung into one item per Custom command once Extractor v3 exists.

- [x] Object Storage: `os object get` (single-part).
- [x] Object Storage: `os object put` (single-part).
- [x] Object Storage: `os object get` (multipart).
- [x] Object Storage: `os object put` (multipart and stdin).
- [x] Object Storage: `os object resume-put`.
- [x] Object Storage: `os object bulk-upload`.
- [x] Object Storage: `os object bulk-download`.
- [x] Object Storage: `os object bulk-delete`.
- [x] Object Storage: `os object sync`.
- [x] `setup repair-file-permissions`.
- [x] `setup keys`.
- [x] `setup config`.
- [x] `setup autocomplete`.
- [x] `session validate`.
- [x] `session refresh`.
- [x] `session export`.
- [x] `session import`.
- [x] `session authenticate`.

## Rung 8 — Remaining commands and Engine features

### Compute, Kubernetes, IAM, Block Volume, Networking and raw requests

- [x] `compute instance list-vnics`
- [x] `compute instance attach-vnic`
- [x] `compute instance action`
- [x] `compute instance change-compartment`
- [x] `compute instance detach-vnic`
- [ ] `compute instance-console-connection get-plink-connection-string`
- [ ] `compute volume-attachment list`
- [ ] `ce cluster create-kubeconfig`
- [ ] `ce cluster generate-token`
- [ ] `iam compartment create`
- [ ] `iam compartment list`
- [ ] `iam db-token get`
- [ ] `iam group add-user`
- [ ] `iam group list-users`
- [ ] `iam group remove-user`
- [ ] `iam policy update`
- [ ] `iam tag reactivate`
- [ ] `iam tag retire`
- [ ] `iam tag-namespace reactivate`
- [ ] `iam tag-namespace retire`
- [ ] `iam tag-namespace update`
- [ ] `iam user list-groups`
- [ ] `bv backup copy`
- [ ] `bv boot-volume create`
- [ ] `bv boot-volume-backup copy`
- [ ] `bv volume create`
- [ ] `network remote-peering-connection connect`
- [ ] `network vnic assign-ipv6`
- [ ] `network vnic assign-private-ip`
- [ ] `network vnic unassign-ipv6`
- [ ] `network vnic unassign-private-ip`
- [ ] `raw-request`

### Database, Functions, Resource Manager, KMS and Artifacts

- [ ] `db autonomous-database delete`
- [ ] `db data-guard-association create from-existing-db-system`
- [ ] `db data-guard-association create from-existing-vm-cluster`
- [ ] `db data-guard-association create with-new-db-system`
- [ ] `db data-guard-association failover`
- [ ] `db data-guard-association reinstate`
- [ ] `db data-guard-association switchover`
- [ ] `db data-guard-association update`
- [ ] `db database create`
- [ ] `db database create-database-from-database`
- [ ] `db database create-from-backup`
- [ ] `db database create-from-database`
- [ ] `db database create-standby-database`
- [ ] `db database delete`
- [ ] `db database list`
- [ ] `db database patch`
- [ ] `db db-home create`
- [ ] `db patch get by-database`
- [ ] `db patch list by-database`
- [ ] `db patch-history get by-database`
- [ ] `db patch-history list by-database`
- [ ] `db system patch`
- [ ] `fn function invoke`
- [ ] `fn function create archive-function direct-archive fn-update-runtime-config`
- [ ] `fn function create archive-function direct-archive manual-runtime-config`
- [ ] `fn function create archive-function object-storage fn-update-runtime-config`
- [ ] `fn function create archive-function object-storage manual-runtime-config`
- [ ] `fn function create container-function`
- [ ] `fn function create pbf-function`
- [ ] `fn function delete`
- [ ] `fn function update archive-function`
- [ ] `fn function update container-function`
- [ ] `fn function update pbf-function`
- [ ] `resource-manager job create-import-tf-state-job`
- [ ] `resource-manager job create-plan-rollback-job`
- [ ] `resource-manager job get-job-logs`
- [ ] `resource-manager stack copy`
- [ ] `resource-manager stack create`
- [ ] `resource-manager stack update`
- [ ] `kms management key-version cancel-deletion`
- [ ] `kms management key-version create`
- [ ] `kms management key-version schedule-deletion`
- [ ] `artifacts container image list`
- [ ] `artifacts container image-signature get-verify`
- [ ] `artifacts container image-signature list`
- [ ] `artifacts container repository list`
- [ ] `artifacts generic artifact list`
- [ ] `artifacts repository list`

### Remaining services

- [ ] `adm vulnerability-audit create`
- [ ] `adm vulnerability-audit create-vulnerability-audit-external-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-oci-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-unknown-source-vulnerability-audit-source`
- [ ] `apm-synthetics monitor create-sql-monitor`
- [ ] `apm-synthetics monitor update-sql-monitor`
- [ ] `audit event list`
- [ ] `cloud-bridge discovery asset-source create`
- [ ] `cloud-bridge discovery asset-source update`
- [ ] `cloud-bridge inventory asset create`
- [ ] `cloud-bridge inventory asset update`
- [ ] `cloud-guard data-mask-rule create`
- [ ] `cloud-guard data-mask-rule create-for-all-targets`
- [ ] `cloud-guard data-mask-rule create-for-services`
- [ ] `cloud-guard data-mask-rule create-for-targets`
- [ ] `cloud-guard data-mask-rule update`
- [ ] `cloud-guard data-mask-rule update-for-all-targets`
- [ ] `cloud-guard data-mask-rule update-for-services`
- [ ] `cloud-guard data-mask-rule update-for-targets`
- [ ] `cloud-migrations target-asset create`
- [ ] `cloud-migrations target-asset update`
- [ ] `data-science job head-job-artifact`
- [ ] `data-science model head-model-artifact`
- [ ] `data-science pipeline head-step-artifact`
- [ ] `data-science pipeline list`
- [ ] `data-science pipeline-run list`
- [ ] `database-management managed-database get-awr-db-report`
- [ ] `dbtools-runtime connection execute-sql async`
- [ ] `dbtools-runtime connection execute-sql sync`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec create default`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec update default`
- [ ] `devops project summarize-project-analytics`
- [ ] `devops repository summarize-repository-analytics`
- [ ] `generative-ai-data enrichment-jobs cancel`
- [ ] `identity-domains apps list`
- [ ] `identity-domains groups list`
- [ ] `identity-domains users list`
- [ ] `iot digital-twin-instance update`
- [ ] `media-services media-stream stream-distribution-channel generate-session-token`
- [ ] `model-deployment inference-result predict`
- [ ] `mysql db-system start`
- [ ] `mysql db-system stop`
- [ ] `network-firewall service create`
- [ ] `network-firewall service update`
- [ ] `ocvs sddc retrieve-sddc-operation-status`
- [ ] Object Storage namespace lookup when `--namespace` is omitted. Cover the Engine path using the `GET /n` recording pattern from `os object copy`.
- [ ] `os bucket delete`
- [ ] `os multipart abort`
- [ ] `os object head`
- [ ] `os object list`
- [ ] `os object list-object-versions`
- [ ] `os object restore`
- [ ] `os object restore-status`
- [ ] `os retention-rule update`
- [ ] `profile diagnose`
- [ ] `profile list`
- [ ] `rover create-master-key-policy`
- [ ] `rover device data-sync task cancel`
- [ ] `rover device data-sync task get`
- [ ] `rover device data-sync task get-snapshot`
- [ ] `rover device data-sync task list`
- [ ] `rover device data-sync task start`
- [ ] `rover device data-sync task-definition change-compartment`
- [ ] `rover device data-sync task-definition change-state`
- [ ] `rover device data-sync task-definition create`
- [ ] `rover device data-sync task-definition delete`
- [ ] `rover device data-sync task-definition get`
- [ ] `rover device data-sync task-definition list`
- [ ] `rover device data-sync task-definition update`
- [ ] `rover device diagnostics bundle cancel`
- [ ] `rover device diagnostics bundle create`
- [ ] `rover device diagnostics bundle get`
- [ ] `rover device diagnostics bundle list`
- [ ] `rover device diagnostics bundle view-summary`
- [ ] `rover device system-upgrade get-import-history`
- [ ] `rover device system-upgrade get-import-status`
- [ ] `rover node add-workload`
- [ ] `rover node create`
- [ ] `rover node delete`
- [ ] `rover node delete-workload`
- [ ] `rover node get-certificate`
- [ ] `rover node list-workload`
- [ ] `rover node request-approval`
- [ ] `rover node setup-identity`
- [ ] `rover node show`
- [ ] `rover node update`
- [ ] `rover standalone-cluster add-workload`
- [ ] `rover standalone-cluster change-compartment`
- [ ] `rover standalone-cluster create`
- [ ] `rover standalone-cluster delete`
- [ ] `rover standalone-cluster delete-workload`
- [ ] `rover standalone-cluster get-certificate`
- [ ] `rover standalone-cluster list-workloads`
- [ ] `rover standalone-cluster request-approval`
- [ ] `rover standalone-cluster set-secrets`
- [ ] `rover standalone-cluster show`
- [ ] `rover standalone-cluster update`
- [ ] `rover station-cluster add-workload`
- [ ] `rover station-cluster change-compartment`
- [ ] `rover station-cluster create`
- [ ] `rover station-cluster delete`
- [ ] `rover station-cluster delete-workload`
- [ ] `rover station-cluster get-certificate`
- [ ] `rover station-cluster list-workloads`
- [ ] `rover station-cluster request-approval`
- [ ] `rover station-cluster set-secrets`
- [ ] `rover station-cluster show`
- [ ] `rover station-cluster update`
- [ ] `session terminate`
- [ ] `setup bootstrap`
- [ ] `setup find-installations`
- [ ] `setup instance-principal`
- [ ] `setup oci-cli-rc`
- [ ] `setup pkcs11-auth`
- [ ] `support incident put-attachment`
- [ ] `waas policy-config update`

### File transfers, streaming and bulk operations

- [ ] `artifacts container image-signature sign-upload`
- [ ] `compute image export to-object`
- [ ] `compute image export to-object-uri`
- [ ] `compute image import from-object`
- [ ] `compute image import from-object-uri`
- [ ] `generative-ai-sandbox sandbox-command stream`
- [ ] `generative-ai-sandbox sandbox-command-event stream`
- [ ] `generative-ai-sandbox sandbox-file read`
- [ ] `kms management key restore-from-file`
- [ ] `kms management vault restore-from-file`
- [ ] `management-dashboard dashboard export`
- [ ] `model-deployment inference-result predict-with-response-stream`
- [ ] `os object bulk-delete-versions`
- [ ] `rover device system-upgrade import-bundle`
- [ ] `rover device system-upgrade upload-bundle`

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
- [x] `compute instance-console-connection get-plink-connection-string`
- [x] `compute volume-attachment list`
- [x] `ce cluster create-kubeconfig`
- [x] `ce cluster generate-token`
- [x] `iam compartment create`
- [x] `iam compartment list`
- [x] `iam db-token get`
- [x] `iam group add-user`
- [x] `iam group list-users`
- [x] `iam group remove-user`
- [x] `iam policy update`
- [x] `iam tag reactivate`
- [x] `iam tag retire`
- [x] `iam tag-namespace reactivate`
- [x] `iam tag-namespace retire`
- [x] `iam tag-namespace update`
- [x] `iam user list-groups`
- [x] `bv backup copy`
- [x] `bv boot-volume create`
- [x] `bv boot-volume-backup copy`
- [x] `bv volume create`
- [x] `network remote-peering-connection connect`
- [x] `network vnic assign-ipv6`
- [x] `network vnic assign-private-ip`
- [x] `network vnic unassign-ipv6`
- [x] `network vnic unassign-private-ip`
- [x] `raw-request`

### Database, Functions, Resource Manager, KMS and Artifacts

- [x] `db autonomous-database delete`
- [x] `db data-guard-association create from-existing-db-system`
- [x] `db data-guard-association create from-existing-vm-cluster`
- [x] `db data-guard-association create with-new-db-system`
- [x] `db data-guard-association failover`
- [x] `db data-guard-association reinstate`
- [x] `db data-guard-association switchover`
- [x] `db data-guard-association update`
- [x] `db database create`
- [x] `db database create-database-from-database`
- [x] `db database create-from-backup`
- [x] `db database create-from-database`
- [x] `db database create-standby-database`
- [x] `db database delete`
- [x] `db database list`
- [x] `db database patch`
- [x] `db db-home create`
- [x] `db patch get by-database`
- [x] `db patch list by-database`
- [x] `db patch-history get by-database`
- [x] `db patch-history list by-database`
- [x] `db system patch`
- [x] `fn function invoke`
- [x] `fn function create archive-function direct-archive fn-update-runtime-config`
- [x] `fn function create archive-function direct-archive manual-runtime-config`
- [x] `fn function create archive-function object-storage fn-update-runtime-config`
- [x] `fn function create archive-function object-storage manual-runtime-config`
- [x] `fn function create container-function`
- [x] `fn function create pbf-function`
- [x] `fn function delete`
- [x] `fn function update archive-function`
- [x] `fn function update container-function`
- [x] `fn function update pbf-function`
- [x] `resource-manager job create-import-tf-state-job`
- [x] `resource-manager job create-plan-rollback-job`
- [x] `resource-manager job get-job-logs`
- [x] `resource-manager stack copy`
- [x] `resource-manager stack create`
- [x] `resource-manager stack update`
- [x] `kms management key-version cancel-deletion`
- [x] `kms management key-version create`
- [x] `kms management key-version schedule-deletion`
- [x] `artifacts container image list`
- [x] `artifacts container image-signature get-verify`
- [x] `artifacts container image-signature list`
- [x] `artifacts container repository list`
- [x] `artifacts generic artifact list`
- [x] `artifacts repository list`

### Remaining services

- [x] `adm vulnerability-audit create`
- [x] `adm vulnerability-audit create-vulnerability-audit-external-resource-vulnerability-audit-source`
- [x] `adm vulnerability-audit create-vulnerability-audit-oci-resource-vulnerability-audit-source`
- [x] `adm vulnerability-audit create-vulnerability-audit-unknown-source-vulnerability-audit-source`
- [x] `apm-synthetics monitor create-sql-monitor`
- [x] `apm-synthetics monitor update-sql-monitor`
- [x] `audit event list`
- [x] `cloud-bridge discovery asset-source create`
- [x] `cloud-bridge discovery asset-source update`
- [x] `cloud-bridge inventory asset create`
- [x] `cloud-bridge inventory asset update`
- [x] `cloud-guard data-mask-rule create`
- [x] `cloud-guard data-mask-rule create-for-all-targets`
- [x] `cloud-guard data-mask-rule create-for-services`
- [x] `cloud-guard data-mask-rule create-for-targets`
- [x] `cloud-guard data-mask-rule update`
- [x] `cloud-guard data-mask-rule update-for-all-targets`
- [x] `cloud-guard data-mask-rule update-for-services`
- [x] `cloud-guard data-mask-rule update-for-targets`
- [x] `cloud-migrations target-asset create`
- [x] `cloud-migrations target-asset update`
- [x] `data-science job head-job-artifact`
- [x] `data-science model head-model-artifact`
- [x] `data-science pipeline head-step-artifact`
- [x] `data-science pipeline list`
- [x] `data-science pipeline-run list`
- [x] `database-management managed-database get-awr-db-report`
- [x] `dbtools-runtime connection execute-sql async`
- [x] `dbtools-runtime connection execute-sql sync`
- [x] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec create default`
- [x] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec update default`
- [x] `devops project summarize-project-analytics`
- [x] `devops repository summarize-repository-analytics`
- [x] `generative-ai-data enrichment-jobs cancel`
- [x] `identity-domains apps list`
- [x] `identity-domains groups list`
- [x] `identity-domains users list`
- [x] `iot digital-twin-instance update`
- [x] `media-services media-stream stream-distribution-channel generate-session-token`
- [x] `model-deployment inference-result predict`
- [x] `mysql db-system start`
- [x] `mysql db-system stop`
- [x] `network-firewall service create`
- [x] `network-firewall service update`
- [x] `ocvs sddc retrieve-sddc-operation-status`
- [x] Object Storage namespace lookup when `--namespace` is omitted. Cover the Engine path using the `GET /n` recording pattern from `os object copy`.
- [x] `os bucket delete`
- [x] `os multipart abort`
- [x] `os object head`
- [x] `os object list`
- [x] `os object list-object-versions`
- [x] `os object restore`
- [x] `os object restore-status`
- [x] `os retention-rule update`
- [x] `profile diagnose`
- [x] `profile list`
- [x] `rover create-master-key-policy`
- [x] `rover device data-sync task cancel`
- [x] `rover device data-sync task get`
- [x] `rover device data-sync task get-snapshot`
- [x] `rover device data-sync task list`
- [x] `rover device data-sync task start`
- [x] `rover device data-sync task-definition change-compartment`
- [x] `rover device data-sync task-definition change-state`
- [x] `rover device data-sync task-definition create`
- [x] `rover device data-sync task-definition delete`
- [x] `rover device data-sync task-definition get`
- [x] `rover device data-sync task-definition list`
- [x] `rover device data-sync task-definition update`
- [x] `rover device diagnostics bundle cancel`
- [x] `rover device diagnostics bundle create`
- [x] `rover device diagnostics bundle get`
- [x] `rover device diagnostics bundle list`
- [x] `rover device diagnostics bundle view-summary`
- [x] `rover device system-upgrade get-import-history`
- [x] `rover device system-upgrade get-import-status`
- [x] `rover node add-workload`
- [x] `rover node create`
- [x] `rover node delete`
- [x] `rover node delete-workload`
- [x] `rover node get-certificate`
- [x] `rover node list-workload`
- [x] `rover node request-approval`
- [x] `rover node setup-identity`
- [x] `rover node show`
- [x] `rover node update`
- [x] `rover standalone-cluster add-workload`
- [x] `rover standalone-cluster change-compartment`
- [x] `rover standalone-cluster create`
- [x] `rover standalone-cluster delete`
- [x] `rover standalone-cluster delete-workload`
- [x] `rover standalone-cluster get-certificate`
- [x] `rover standalone-cluster list-workloads`
- [x] `rover standalone-cluster request-approval`
- [x] `rover standalone-cluster set-secrets`
- [x] `rover standalone-cluster show`
- [x] `rover standalone-cluster update`
- [x] `rover station-cluster add-workload`
- [x] `rover station-cluster change-compartment`
- [x] `rover station-cluster create`
- [x] `rover station-cluster delete`
- [x] `rover station-cluster delete-workload`
- [x] `rover station-cluster get-certificate`
- [x] `rover station-cluster list-workloads`
- [x] `rover station-cluster request-approval`
- [x] `rover station-cluster set-secrets`
- [x] `rover station-cluster show`
- [x] `rover station-cluster update`
- [x] `session terminate`
- [x] `setup bootstrap`
- [x] `setup find-installations`
- [x] `setup instance-principal`
- [x] `setup oci-cli-rc`
- [x] `setup pkcs11-auth`
- [x] `support incident put-attachment`
- [x] `waas policy-config update`

### File transfers, streaming and bulk operations

- [x] `artifacts container image-signature sign-upload`
- [x] `compute image export to-object`
- [x] `compute image export to-object-uri`
- [x] `compute image import from-object`
- [x] `compute image import from-object-uri`
- [x] `generative-ai-sandbox sandbox-command stream`
- [x] `generative-ai-sandbox sandbox-command-event stream`
- [x] `generative-ai-sandbox sandbox-file read`
- [x] `kms management key restore-from-file`
- [x] `kms management vault restore-from-file`
- [x] `management-dashboard dashboard export`
- [x] `model-deployment inference-result predict-with-response-stream`
- [x] `os object bulk-delete-versions`
- [x] `rover device system-upgrade import-bundle`
- [x] `rover device system-upgrade upload-bundle`

## Rung 9 — Differential fuzzing

`bun run fuzz` (scripts/fuzz.ts) runs random spec-valid invocations through both CLIs against random model-shaped replies. Per item: reproduce with the seed and command given, `--promote` the mismatches into `test/parity/cases/fuzz-found.json` (goldens included), make them pass, and fix by cause, not per command. Findings from `bun run fuzz --limit 300 --seed 42`.

- [x] Fuzz: hangs. boci runs past 60 s where oci returns (e.g. `network vcn topology get`, `network vcn patch`, `identity-domains my-smtp-credential delete`, `opsi database-insights update-mds-my-sql-database`; seed 42).
- [x] Fuzz: SDK model deserialisation. Unknown enum values print as `UNKNOWN_ENUM_VALUE`; datetimes keep microseconds (`.123000+00:00`); unknown response fields are dropped; nulls and polymorphic subtypes print like the SDK.
- [x] Fuzz: service error output. `TransientServiceError` for 429/5xx, response headers (`etag`, `opc-work-request-id`, …) in the error body, non-JSON error bodies.
- [x] Fuzz: invalid `--query`. JMESPath `ParseError` message and exit 1 instead of a JavaScript stack trace or exit 0.
- [x] Fuzz: `--query` results with `--output table` and `--raw-output` (e.g. `length(data)` with `--output table` fails in oci with `TypeError`).
- [x] Fuzz: command validation rules (e.g. `bv volume list --sort-by` without `--availability-domain`; `--all` with `--limit`; confirmation `Abort:` on wrapper commands).
- [x] Fuzz: request encoding of unusual values (non-latin-1 header values make oci fail with `UnicodeEncodeError`; empty strings, `&`/`?`/`/` in path and query values; repeated `multiple` options).
- [x] Fuzz: option values starting with `-` parse as Click short-option clusters (e.g. `--compartment-id -leading-dash` enters interactive mode in oci). Re-add `-leading-dash` to the TEXT pool in scripts/fuzz-lib.ts.
- [x] Fuzz: full sweep. Fixed `oci-zygote.py` / `oci-zygote.ts` / `runner.ts` / `fuzz.ts` timeout cleanup so timed-out child process groups are killed cleanly without deadlocking workers; ran `bun run fuzz --seed 42 --iterations 3 --timeout 30` across all 9,305 commands (27,457/27,915 matched = 98.4%, 447 mismatches in 396 commands, 11 `rover` secondary-client timeouts in `oci`) and split remaining mismatches by cause below.
- [x] Fuzz (full sweep): `list_call_get_up_to_limit` collection handling. Match `oci`'s `None`/`int` `TypeError` when collection items are null/int, `--limit <= 0` empty/`None` and header-only output (incl. `--query` on `None`), and `--limit N` client-side truncation (e.g. `adm knowledge-base list`, `data-catalog glossary list`, `analytics work-request list`, `ai-data-platform work-request-error list`, `opsi awr-hub-objects list`, `rover node rover-bundle-request list`; seed 42).
- [x] Fuzz (full sweep): `--all` pagination edge cases. Follow next-page tokens through pages with empty/null items, stop on SDK deserialisation errors, and match `list_call_get_all_results` page ordering/merging (e.g. `ai-vision stream-source-collection list-stream-sources`, `cloud-guard responder-execution-summary list-responder-executions`, `waas waas-policy list`, `bv boot-volume-replica list`, `db oneoff-patch list`; seed 42).
- [x] Fuzz (full sweep): binary/stream request body encoding and signatures. Match `oci` body encoding and produce valid HTTP signatures for non-ASCII UTF-8 stream bodies (e.g. `cloud-migrations migration-plan import`, `data-safe sensitive-data-model upload`, `marketplace-publisher term-version create`, `self partner-integeration create-subscription-usage-record-details submit-subscription-usage-batch`; seed 42).
- [x] Fuzz (full sweep): JSON option parsing and error parameter names. Accept valid JSON string literals (`"string"`) in complex-type options (`iot flow-runtime update-flows`, `opsi opsi-data-objects query-data-standard-query`, `opsi database-insights change-autonomous-database-insight-advanced-features-credential-by-vault`) and report the CLI parameter name in `must be in JSON format` errors (`log-analytics source upsert-source`, `validate-source`, `validate-source-extfield-details`; seed 42).
- [x] Fuzz (full sweep): construct wrapper SSH public keys from `--ssh-authorized-keys-file` (`db cloud-vm-cluster create`; seed 42).
- [x] Fuzz (full sweep): match wrapper `userPassword` object construction (`dbtools connection create-{mysql-database,oracle-database,postgresql}`; seed 42).
- [x] Fuzz (full sweep): read `--ipxe-script-file` into generated request bodies (`compute instance launch-instance-host-group-placement-constraint-details`; seed 42).
- [x] Fuzz (full sweep): match flags omitted by the wrapper (`db pluggable-database local-clone`; seed 42).
- [x] Fuzz (full sweep): match nested model type errors (`db database create-database-from-database`; seed 42).
- [x] Fuzz (full sweep): deserialize array replies to SDK model defaults in custom wrappers (`network vnic assign-private-ip`, `db patch-history list by-database`; seed 42).
- [x] Fuzz (full sweep): match wrapper SDK list deserialization and indexing errors (`db database list`, `db database create-from-database`; seed 42).
- [x] Fuzz (full sweep): match wrapper attribute errors for list-valued detail options (`network-firewall {application,decryption-profile,mapped-secret,nat-rule,service,tunnel-inspection-rule} {create,update}`; seed 42).
- [x] Fuzz (full sweep): match string concatenation errors in `resource-manager stack copy` (seed 42).
- [x] Fuzz (full sweep): match wrapper attribute errors on missing values (`rover {node,standalone-cluster,station-cluster} list-workload(s)`; seed 42).
- [x] Fuzz (full sweep): match empty or invalid implicit Object Storage namespaces (`os object head`/`restore`, `os multipart abort`; seed 42).
- [x] Fuzz (full sweep): match SDK list deserialization in `compute instance list-vnics` (seed 42).
- [x] Fuzz (full sweep): match work-request client errors in `compute instance change-compartment` (seed 42).
- [x] Fuzz (full sweep): match `compute instance-console-connection get-plink-connection-string` edge cases (seed 42).
- [x] Fuzz (full sweep): match `compute console-history get-content` download output (seed 42).
- [x] Fuzz (full sweep): match first-use auto-prompt output ordering on non-terminal stdout (`iam compartment list`/`group list-users`/`user list-groups`; seed 42).
- [x] Fuzz (full sweep): match `network remote-peering-connection connect` invalid `--peer-region-name` handling (seed 42).
- [x] Fuzz (full sweep): match `db database delete` edge cases (seed 42).
- [x] Fuzz (full sweep): match `rover {node,station-cluster} delete-workload` edge cases (seed 42).
- [x] Fuzz (full sweep): match delegated missing-option usage paths on `data-science ml-app-instance-view update`/`fn function create archive-function object-storage fn-update-runtime-config` (seed 42).
- [x] Fuzz (full sweep): match SDK errors after `generative-ai-data generate-sql-jobs generate` clears missing-option errors (seed 42).

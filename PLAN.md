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

## Rung 8 — Remaining Custom commands

Difficulty estimates range from **1/5 (easiest)** to **5/5 (hardest)**. Groups reflect command names and expected behavior. Check the pinned callback when taking an item.

### 1/5 — Local profile lookups

<details>
<summary>2 commands</summary>

- [x] `profile current`
- [ ] `profile list`

</details>

### 1/5 — Single-resource lookups and metadata

<details>
<summary>88 commands</summary>

- [ ] `apm-traces scheduled-query get`
- [ ] `apm-traces trace log get`
- [ ] `apm-traces trace span get`
- [ ] `apm-traces trace trace get`
- [ ] `ccc infrastructure get`
- [ ] `ccc upgrade-schedule get`
- [ ] `certificates certificate-authority-bundle get`
- [ ] `certificates certificate-bundle get`
- [ ] `certs-mgmt certificate-authority-version get`
- [ ] `certs-mgmt certificate-version get`
- [ ] `compute capacity-topology get`
- [ ] `compute global-image-capability-schema get`
- [ ] `compute global-image-capability-schema-version get`
- [ ] `compute image-capability-schema get`
- [ ] `compute pic agreements get`
- [ ] `compute-management instance-pool lb-attachment get`
- [ ] `data-integration connection-validation get`
- [ ] `data-integration data-flow-validation get`
- [ ] `data-safe private-endpoint get`
- [ ] `data-science ds-private-endpoint get`
- [ ] `data-science ml-app get`
- [ ] `data-science ml-app-implementation get`
- [ ] `data-science ml-app-implementation-version get`
- [ ] `data-science ml-app-instance get`
- [ ] `data-science ml-app-instance-view get`
- [ ] `database-management private-endpoint get`
- [ ] `db cloud-exa-infra get`
- [ ] `db db-system-upgrade-history get`
- [ ] `db external-cdb get`
- [ ] `db external-db-connector get`
- [ ] `db external-non-cdb get`
- [ ] `db external-pdb get`
- [ ] `db pdb-conversion-history get`
- [ ] `db upgrade-history get`
- [ ] `dbtools connection get`
- [ ] `dbtools endpoint-service get`
- [ ] `dbtools identity get`
- [ ] `dbtools private-endpoint get`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec create default`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec update default`
- [ ] `devops build-pipeline-stage get`
- [ ] `devops deploy-artifact get`
- [ ] `devops deploy-environment get`
- [ ] `devops deploy-pipeline get`
- [ ] `devops deploy-stage get`
- [ ] `generative-ai-data enrichment-jobs get`
- [ ] `generative-ai-data generate-sql-jobs get`
- [ ] `iam db-token get`
- [ ] `instance-agent command get`
- [ ] `instance-agent command-execution get`
- [ ] `integration integration-instance get`
- [ ] `limits-increase item get`
- [ ] `limits-increase limits-increase-request get`
- [ ] `log-analytics em-bridge get`
- [ ] `log-analytics entity get`
- [ ] `log-analytics entity-type get`
- [ ] `log-analytics log-group get`
- [ ] `log-analytics object-collection-rule get`
- [ ] `logging agent-configuration get`
- [ ] `management-agent agent get`
- [ ] `management-agent install-key get`
- [ ] `media-services media-asset-distribution-channel-attachment get`
- [ ] `network drg-route-distribution get`
- [ ] `network nsg get`
- [ ] `network public-ip get`
- [ ] `ocvs esxi-host get`
- [ ] `opsi awr-hub-objects get`
- [ ] `opsi awr-hub-objects head`
- [ ] `opsi opsi-private-endpoint get`
- [ ] `os object head`
- [ ] `os-management-hub lifecycle-environment get`
- [ ] `os-management-hub lifecycle-stage get`
- [ ] `os-management-hub managed-instance-group get`
- [ ] `rover device data-sync task get`
- [ ] `rover device data-sync task-definition get`
- [ ] `rover device diagnostics bundle get`
- [ ] `rover node show`
- [ ] `rover standalone-cluster show`
- [ ] `rover station-cluster show`
- [ ] `service-catalog private-application-package get`
- [ ] `service-catalog service-catalog-association get`
- [ ] `stack-monitoring baselineable-metric get`
- [ ] `stack-monitoring metric-extension get`
- [ ] `stack-monitoring resource get`
- [ ] `stack-monitoring resource-task get`
- [ ] `stack-monitoring resource-type get`
- [ ] `vbstudio instance get`
- [ ] `visual-builder vb-instance get`

</details>

### 2/5 — Collection listing and pagination

<details>
<summary>79 commands</summary>

- [ ] `apm-traces scheduled-query list`
- [ ] `artifacts container image list`
- [ ] `artifacts container image-signature list`
- [ ] `artifacts container repository list`
- [ ] `artifacts generic artifact list`
- [ ] `artifacts repository list`
- [ ] `audit event list`
- [ ] `ccc infrastructure list`
- [ ] `ccc upgrade-schedule list`
- [ ] `cloud-guard problem list`
- [ ] `compute capacity-topology bare-metal-host list`
- [ ] `compute capacity-topology hpc-island list`
- [ ] `compute capacity-topology network-block list`
- [ ] `compute global-image-capability-schema-version list`
- [ ] `compute volume-attachment list`
- [ ] `data-science ds-private-endpoint list`
- [ ] `data-science ml-app list`
- [ ] `data-science ml-app-implementation list`
- [ ] `data-science ml-app-implementation-version list`
- [ ] `data-science ml-app-instance list`
- [ ] `data-science ml-app-instance-view list`
- [ ] `data-science pipeline list`
- [ ] `data-science pipeline-run list`
- [ ] `db backup list`
- [ ] `db cloud-vm-cluster list`
- [ ] `db database list`
- [ ] `db exadb-vm-cluster list`
- [ ] `db exascale-db-storage-vault list`
- [ ] `db gi-minor-version-summary list`
- [ ] `dbtools identity list`
- [ ] `dbtools-runtime credential list`
- [ ] `devops deploy-stage list`
- [ ] `devops deployment list`
- [ ] `goldengate ai-model list`
- [ ] `iam compartment list`
- [ ] `identity-domains apps list`
- [ ] `identity-domains groups list`
- [ ] `identity-domains users list`
- [ ] `integration work-request list`
- [ ] `log-analytics entity list`
- [ ] `log-analytics entity-topology list`
- [ ] `logging agent-configuration list`
- [ ] `logging log-group list`
- [ ] `management-agent agent list`
- [ ] `media-services media-workflow-task-declaration list`
- [ ] `mysql db-system list`
- [ ] `network drg-route-distribution-statement list`
- [ ] `network drg-route-table list`
- [ ] `network nsg rules list`
- [ ] `network nsg vnics list`
- [ ] `oce oce-instance list`
- [ ] `oce work-request list`
- [ ] `oce work-request-error list`
- [ ] `oce work-request-log-entry list`
- [ ] `ocvs esxi-host list`
- [ ] `opsi database-insights list`
- [ ] `opsi exadata-insights list`
- [ ] `opsi host-insights list`
- [ ] `os object list`
- [ ] `os-management-hub event list`
- [ ] `os-management-hub lifecycle-environment list`
- [ ] `os-management-hub lifecycle-stage list`
- [ ] `os-management-hub managed-instance list`
- [ ] `os-management-hub managed-instance-group list`
- [ ] `os-management-hub management-station list`
- [ ] `os-management-hub profile list`
- [ ] `os-management-hub scheduled-job list`
- [ ] `os-management-hub software-source list`
- [ ] `os-management-hub work-request list`
- [ ] `rover device data-sync task list`
- [ ] `rover device data-sync task-definition list`
- [ ] `rover device diagnostics bundle list`
- [ ] `service-catalog private-application-package list`
- [ ] `service-catalog service-catalog-association list`
- [ ] `stack-monitoring baselineable-metric list`
- [ ] `stack-monitoring metric-extension list`
- [ ] `support incident list`
- [ ] `visual-builder application list`
- [ ] `visual-builder work-request list`

</details>

### 2/5 — Compartment moves

<details>
<summary>37 commands</summary>

- [ ] `ccc infrastructure change-compartment`
- [ ] `ccc upgrade-schedule change-compartment`
- [ ] `compute capacity-topology change-compartment`
- [ ] `compute image-capability-schema change-compartment`
- [ ] `compute instance change-compartment`
- [ ] `data-safe private-endpoint change-compartment`
- [ ] `data-science ds-private-endpoint change-compartment`
- [ ] `data-science ml-app change-compartment`
- [ ] `data-science ml-app-implementation change-compartment`
- [ ] `data-science ml-app-instance change-compartment`
- [ ] `data-science ml-app-instance-view change-compartment`
- [ ] `database-management private-endpoint change-compartment`
- [ ] `db cloud-exa-infra change-compartment`
- [ ] `db external-cdb change-compartment`
- [ ] `db external-non-cdb change-compartment`
- [ ] `db external-pdb change-compartment`
- [ ] `dbtools connection change-compartment`
- [ ] `dbtools identity change-compartment`
- [ ] `dbtools private-endpoint change-compartment`
- [ ] `integration integration-instance change-compartment`
- [ ] `log-analytics em-bridge change-compartment`
- [ ] `log-analytics entity change-compartment`
- [ ] `log-analytics log-group change-compartment`
- [ ] `log-analytics object-collection-rule change-compartment`
- [ ] `logging agent-configuration change-compartment`
- [ ] `network nsg change-compartment`
- [ ] `opsi opsi-private-endpoint change-compartment`
- [ ] `os-management-hub lifecycle-environment change-compartment`
- [ ] `os-management-hub managed-instance-group change-compartment`
- [ ] `rover device data-sync task-definition change-compartment`
- [ ] `rover node change-compartment`
- [ ] `rover standalone-cluster change-compartment`
- [ ] `rover station-cluster change-compartment`
- [ ] `stack-monitoring metric-extension change-compartment`
- [ ] `stack-monitoring resource change-compartment`
- [ ] `stack-monitoring resource-task change-compartment`
- [ ] `visual-builder vb-instance change-compartment`

</details>

### 2/5 — Filtered lookups and summaries

<details>
<summary>55 commands</summary>

- [ ] `artifacts container image-signature get-verify`
- [ ] `artifacts generic artifact get-by-path`
- [ ] `compute instance list-vnics`
- [ ] `compute instance-console-connection get-plink-connection-string`
- [ ] `data-flow run list-logs`
- [ ] `data-integration task-run-lineage list-task-run-lineages`
- [ ] `data-science work-request list-work-request-logs`
- [ ] `database-management associated-database-summary list-associated-databases`
- [ ] `database-management managed-database get-awr-db-report`
- [ ] `db autonomous-database-wallet get-metadata`
- [ ] `db external-cdb list-external-pdbs`
- [ ] `db pluggable-database get-snapshot`
- [ ] `devops project summarize-project-analytics`
- [ ] `devops repository summarize-repository-analytics`
- [ ] `iam group list-users`
- [ ] `iam user list-groups`
- [ ] `log-analytics assoc list-associated-entities`
- [ ] `log-analytics assoc list-entity-source-assocs`
- [ ] `log-analytics entity list-associations`
- [ ] `log-analytics query search`
- [ ] `management-agent agent summarize-plugin-counts`
- [ ] `marketplace listing-summary search-listings-free-text`
- [ ] `marketplace listing-summary search-listings-structured`
- [ ] `monitoring metric-data summarize-metrics-data`
- [ ] `opsi database-insights list-database-configurations`
- [ ] `opsi enterprise-manager-bridges list-importable-enterprise-manager-entities`
- [ ] `opsi host-insights list-host-configurations`
- [ ] `os object list-object-versions`
- [ ] `os-management-hub lifecycle-stage list-installed-packages`
- [ ] `os-management-hub managed-instance get-analytic-content`
- [ ] `os-management-hub managed-instance list-modules`
- [ ] `os-management-hub managed-instance summarize-analytics`
- [ ] `os-management-hub managed-instance-group list-available-modules`
- [ ] `os-management-hub managed-instance-group list-available-packages`
- [ ] `os-management-hub managed-instance-group list-available-software-sources`
- [ ] `os-management-hub managed-instance-group list-installed-packages`
- [ ] `os-management-hub managed-instance-group list-managed-instances`
- [ ] `os-management-hub managed-instance-group list-modules`
- [ ] `os-management-hub software-source list-all-software-packages`
- [ ] `os-management-hub software-source list-module-profiles`
- [ ] `os-management-hub software-source search-modules`
- [ ] `resource-manager job get-job-logs`
- [ ] `rover device data-sync task get-snapshot`
- [ ] `rover device diagnostics bundle view-summary`
- [ ] `rover device system-upgrade get-import-history`
- [ ] `rover device system-upgrade get-import-status`
- [ ] `rover node get-encryption-key`
- [ ] `rover node list-workload`
- [ ] `rover standalone-cluster list-workloads`
- [ ] `rover station-cluster list-workloads`
- [ ] `stack-monitoring metric-extension summarize-metrics`
- [ ] `stack-monitoring metric-extension summarize-resources`
- [ ] `stack-monitoring resource search-members`
- [ ] `threat-intelligence indicator summarize`
- [ ] `threat-intelligence indicator-summaries list-indicators`

</details>

### 3/5 — Deletion and confirmation

<details>
<summary>66 commands</summary>

- [ ] `apm-traces scheduled-query delete`
- [ ] `artifacts generic artifact delete-by-path`
- [ ] `ccc infrastructure delete`
- [ ] `ccc upgrade-schedule delete`
- [ ] `compute capacity-topology delete`
- [ ] `compute image-capability-schema delete`
- [ ] `data-integration connection-validation delete`
- [ ] `data-integration data-flow-validation delete`
- [ ] `data-safe private-endpoint delete`
- [ ] `data-science ds-private-endpoint delete`
- [ ] `data-science ml-app delete`
- [ ] `data-science ml-app-implementation delete`
- [ ] `data-science ml-app-instance delete`
- [ ] `database-management private-endpoint delete`
- [ ] `db autonomous-database delete`
- [ ] `db cloud-exa-infra delete`
- [ ] `db database delete`
- [ ] `db external-cdb delete`
- [ ] `db external-db-connector delete`
- [ ] `db external-non-cdb delete`
- [ ] `db external-pdb delete`
- [ ] `db pluggable-database delete-snapshot`
- [ ] `dbtools connection delete`
- [ ] `dbtools identity delete`
- [ ] `dbtools private-endpoint delete`
- [ ] `devops build-pipeline-stage delete`
- [ ] `devops deploy-artifact delete`
- [ ] `devops deploy-environment delete`
- [ ] `devops deploy-pipeline delete`
- [ ] `devops deploy-stage delete`
- [ ] `devops repository delete-ref`
- [ ] `fn function delete`
- [ ] `integration integration-instance delete`
- [ ] `limits-increase limits-increase-request delete`
- [ ] `log-analytics em-bridge delete`
- [ ] `log-analytics entity delete`
- [ ] `log-analytics entity-type delete`
- [ ] `log-analytics log-group delete`
- [ ] `log-analytics object-collection-rule delete`
- [ ] `logging agent-configuration delete`
- [ ] `management-agent agent delete`
- [ ] `management-agent install-key delete`
- [ ] `media-services media-asset-distribution-channel-attachment delete`
- [ ] `network drg-route-distribution delete`
- [ ] `network nsg delete`
- [ ] `nosql table delete-replica`
- [ ] `ocvs esxi-host delete`
- [ ] `opsi awr-hub-objects delete`
- [ ] `opsi opsi-private-endpoint delete`
- [ ] `os bucket delete`
- [ ] `os-management-hub lifecycle-environment delete`
- [ ] `os-management-hub managed-instance-group delete`
- [ ] `rover device data-sync task-definition delete`
- [ ] `rover node delete`
- [ ] `rover node delete-workload`
- [ ] `rover standalone-cluster delete`
- [ ] `rover standalone-cluster delete-workload`
- [ ] `rover station-cluster delete`
- [ ] `rover station-cluster delete-workload`
- [ ] `service-catalog service-catalog-association delete`
- [ ] `stack-monitoring baselineable-metric delete`
- [ ] `stack-monitoring metric-extension delete`
- [ ] `stack-monitoring resource delete`
- [ ] `stack-monitoring resource-type delete`
- [ ] `vbstudio instance delete`
- [ ] `visual-builder vb-instance delete`

</details>

### 3/5 — Property and association changes

<details>
<summary>57 commands</summary>

- [ ] `apm-config data-file put`
- [ ] `artifacts container image remove-version`
- [ ] `compute instance attach-vnic`
- [ ] `compute instance detach-vnic`
- [ ] `compute-management instance-pool lb-attachment attach`
- [ ] `compute-management instance-pool lb-attachment detach`
- [ ] `database-management tablespace remove-datafile-with-pwd`
- [ ] `db cloud-exa-infra add-storage`
- [ ] `db database patch`
- [ ] `db system patch`
- [ ] `dbtools connection add-lock`
- [ ] `dbtools connection remove-lock`
- [ ] `dbtools identity add-lock`
- [ ] `dbtools identity remove-lock`
- [ ] `dbtools private-endpoint add-lock`
- [ ] `dbtools private-endpoint remove-lock`
- [ ] `dif stack add`
- [ ] `iam group add-user`
- [ ] `iam group remove-user`
- [ ] `identity-domains app put`
- [ ] `identity-domains authentication-factor-setting put`
- [ ] `identity-domains dynamic-resource-group put`
- [ ] `identity-domains group put`
- [ ] `identity-domains identity-provider put`
- [ ] `identity-domains me put`
- [ ] `identity-domains user put`
- [ ] `identity-domains user-capabilities-changer put`
- [ ] `identity-domains user-password-changer put`
- [ ] `identity-domains user-password-resetter put`
- [ ] `identity-domains user-status-changer put`
- [ ] `limits-increase limits-increase-request patch`
- [ ] `log-analytics entity add-associations`
- [ ] `log-analytics entity remove-associations`
- [ ] `logging-ingestion put-logs`
- [ ] `network drg-route-distribution-statement add`
- [ ] `network drg-route-distribution-statement remove`
- [ ] `network nsg rules add`
- [ ] `network nsg rules remove`
- [ ] `network vnic assign-ipv6`
- [ ] `network vnic assign-private-ip`
- [ ] `network vnic unassign-ipv6`
- [ ] `network vnic unassign-private-ip`
- [ ] `opsi awr-hub-objects put`
- [ ] `os-management-hub lifecycle-stage attach-managed-instance`
- [ ] `os-management-hub lifecycle-stage detach-managed-instance`
- [ ] `os-management-hub managed-instance-group attach-managed-instances`
- [ ] `os-management-hub managed-instance-group attach-software-sources`
- [ ] `os-management-hub managed-instance-group detach-managed-instances`
- [ ] `os-management-hub managed-instance-group detach-software-sources`
- [ ] `os-management-hub managed-instance-group remove-module-profile`
- [ ] `os-management-hub managed-instance-group remove-packages`
- [ ] `os-management-hub profile attach-lifecycle-stage`
- [ ] `os-management-hub profile attach-managed-instance-group`
- [ ] `rover node add-workload`
- [ ] `rover standalone-cluster add-workload`
- [ ] `rover station-cluster add-workload`
- [ ] `support incident put-attachment`

</details>

### 3/5 — Resource updates

<details>
<summary>230 commands</summary>

- [ ] `analytics analytics-instance update-vanity-url`
- [ ] `apm-synthetics dedicated-vantage-point update-with-oracle-rm-stack`
- [ ] `apm-synthetics monitor update-browser-monitor`
- [ ] `apm-synthetics monitor update-dns-sec-monitor`
- [ ] `apm-synthetics monitor update-dns-server-monitor`
- [ ] `apm-synthetics monitor update-dns-trace-monitor`
- [ ] `apm-synthetics monitor update-ftp-monitor`
- [ ] `apm-synthetics monitor update-network-monitor`
- [ ] `apm-synthetics monitor update-rest-monitor`
- [ ] `apm-synthetics monitor update-scripted-browser-monitor`
- [ ] `apm-synthetics monitor update-scripted-rest-monitor`
- [ ] `apm-synthetics monitor update-sql-monitor`
- [ ] `apm-traces attributes update-attribute`
- [ ] `apm-traces attributes update-auto-activate`
- [ ] `apm-traces attributes update-notes`
- [ ] `apm-traces scheduled-query update`
- [ ] `artifacts container repository update`
- [ ] `artifacts generic artifact update-by-path`
- [ ] `audit config update`
- [ ] `autoscaling policy update`
- [ ] `bastion bastion update`
- [ ] `capacity-management demand-signal occm-demand-signal-item update`
- [ ] `ccc infrastructure update`
- [ ] `ccc upgrade-schedule update`
- [ ] `ce node-pool update`
- [ ] `certs-mgmt certificate update`
- [ ] `certs-mgmt certificate-authority update-root-ca-by-generating-config-details`
- [ ] `certs-mgmt certificate-authority update-root-ca-managed-externally`
- [ ] `certs-mgmt certificate-authority update-subordinate-ca-issued-by-internal-ca`
- [ ] `certs-mgmt certificate-authority update-subordinate-ca-managed-internally-issued-by-external-ca`
- [ ] `cloud-bridge discovery asset-source update`
- [ ] `cloud-bridge inventory asset update`
- [ ] `cloud-guard data-mask-rule update`
- [ ] `cloud-guard data-mask-rule update-for-all-targets`
- [ ] `cloud-guard data-mask-rule update-for-services`
- [ ] `cloud-guard data-mask-rule update-for-targets`
- [ ] `cloud-migrations target-asset update`
- [ ] `compute capacity-topology update`
- [ ] `compute image-capability-schema update`
- [ ] `data-flow application update`
- [ ] `data-integration connection update`
- [ ] `data-integration data-asset update`
- [ ] `data-integration schedule update`
- [ ] `data-integration schedule update-custom-frequency`
- [ ] `data-integration schedule update-daily-frequency`
- [ ] `data-integration schedule update-hourly-frequency`
- [ ] `data-integration schedule update-monthly-frequency`
- [ ] `data-integration schedule update-monthly-rule-frequency`
- [ ] `data-integration schedule update-weekly-frequency`
- [ ] `data-integration task update-pipeline-task`
- [ ] `data-integration task update-task-from-rest-task`
- [ ] `data-integration task update-task-from-sql-task`
- [ ] `data-safe private-endpoint update`
- [ ] `data-safe registration-policy update`
- [ ] `data-science ds-private-endpoint update`
- [ ] `data-science job update`
- [ ] `data-science ml-app update`
- [ ] `data-science ml-app-implementation update`
- [ ] `data-science ml-app-implementation-version update`
- [ ] `data-science ml-app-instance update`
- [ ] `data-science ml-app-instance-view update`
- [ ] `data-science notebook-session update`
- [ ] `database-management job update-result-location`
- [ ] `database-management private-endpoint update`
- [ ] `datacc infrastructure update`
- [ ] `db autonomous-database update`
- [ ] `db backup update`
- [ ] `db cloud-exa-infra update`
- [ ] `db cloud-vm-cluster update`
- [ ] `db data-guard-association update`
- [ ] `db database update`
- [ ] `db exadb-vm-cluster update`
- [ ] `db exascale-db-storage-vault update`
- [ ] `db external-cdb update`
- [ ] `db external-db-connector update`
- [ ] `db external-db-connector update-macs-connector`
- [ ] `db external-non-cdb update`
- [ ] `db external-pdb update`
- [ ] `db key-store update-oracle-key-vault-details`
- [ ] `db system update`
- [ ] `db vm-cluster update`
- [ ] `dbtools connection update-generic-jdbc`
- [ ] `dbtools connection update-mysql-database`
- [ ] `dbtools connection update-oracle-database`
- [ ] `dbtools connection update-postgresql`
- [ ] `dbtools identity update-oracle-database-resource-principal`
- [ ] `dbtools private-endpoint update`
- [ ] `devops build-pipeline-stage update-build-stage`
- [ ] `devops build-pipeline-stage update-deliver-artifact-stage`
- [ ] `devops build-pipeline-stage update-trigger-deployment-stage`
- [ ] `devops build-pipeline-stage update-wait-stage`
- [ ] `devops connection update-bitbucket-cloud-connection`
- [ ] `devops connection update-bitbucket-server-connection`
- [ ] `devops connection update-github-connection`
- [ ] `devops connection update-gitlab-connection`
- [ ] `devops connection update-gitlab-server-connection`
- [ ] `devops deploy-artifact update`
- [ ] `devops deploy-artifact update-generic-artifact`
- [ ] `devops deploy-artifact update-helm-command-spec`
- [ ] `devops deploy-artifact update-helm-repository-artifact`
- [ ] `devops deploy-artifact update-inline-artifact`
- [ ] `devops deploy-artifact update-ocir-artifact`
- [ ] `devops deploy-environment update`
- [ ] `devops deploy-environment update-compute-instance-environment`
- [ ] `devops deploy-environment update-function-environment`
- [ ] `devops deploy-environment update-oke-cluster-environment`
- [ ] `devops deploy-pipeline update`
- [ ] `devops deploy-stage update`
- [ ] `devops deploy-stage update-compute-instance-group-blue-green-traffic-shift-stage`
- [ ] `devops deploy-stage update-compute-instance-group-canary-approval-stage`
- [ ] `devops deploy-stage update-compute-instance-group-canary-traffic-shift-stage`
- [ ] `devops deploy-stage update-deploy-compute-instance-group-blue-green-stage`
- [ ] `devops deploy-stage update-deploy-compute-instance-group-canary-stage`
- [ ] `devops deploy-stage update-deploy-compute-instance-group-stage`
- [ ] `devops deploy-stage update-deploy-function-stage`
- [ ] `devops deploy-stage update-deploy-oke-blue-green-stage`
- [ ] `devops deploy-stage update-deploy-oke-canary-stage`
- [ ] `devops deploy-stage update-deploy-oke-stage`
- [ ] `devops deploy-stage update-invoke-function-stage`
- [ ] `devops deploy-stage update-load-balancer-traffic-shift-stage`
- [ ] `devops deploy-stage update-manual-approval-stage`
- [ ] `devops deploy-stage update-oke-blue-green-traffic-shift-stage`
- [ ] `devops deploy-stage update-oke-canary-approval-stage`
- [ ] `devops deploy-stage update-oke-canary-traffic-shift-stage`
- [ ] `devops deploy-stage update-oke-helm-chart-stage`
- [ ] `devops deploy-stage update-shell-stage`
- [ ] `devops deploy-stage update-wait-stage`
- [ ] `devops deployment update`
- [ ] `dif stack update`
- [ ] `email email-ip-pool update`
- [ ] `fleet-software-update fsu-cycle update-image-id-target`
- [ ] `fleet-software-update fsu-cycle update-patch`
- [ ] `fleet-software-update fsu-cycle update-version-target`
- [ ] `fusion-apps fusion-environment update`
- [ ] `gdp pipeline update`
- [ ] `generative-ai imported-model update`
- [ ] `goldengate connection update-amazon-kinesis-connection`
- [ ] `goldengate connection update-amazon-s3-connection`
- [ ] `goldengate connection update-azure-data-lake-storage-connection`
- [ ] `goldengate connection update-google-big-query-connection`
- [ ] `goldengate connection update-google-cloud-storage-connection`
- [ ] `goldengate connection update-microsoft-fabric-connection`
- [ ] `goldengate connection update-object-storage-connection`
- [ ] `goldengate connection update-oracle-ai-data-platform-connection`
- [ ] `goldengate connection update-oracle-nosql-connection`
- [ ] `goldengate deployment update`
- [ ] `iam policy update`
- [ ] `iam tag update`
- [ ] `iam tag-namespace update`
- [ ] `integration integration-instance update`
- [ ] `iot digital-twin-instance update`
- [ ] `jms fleet-agent-configuration update`
- [ ] `lb backend-set update`
- [ ] `lb listener update`
- [ ] `lb nsg update`
- [ ] `limits-increase limits-increase-request update`
- [ ] `log-analytics em-bridge update`
- [ ] `log-analytics entity update`
- [ ] `log-analytics entity-type update`
- [ ] `log-analytics log-group update`
- [ ] `log-analytics lookup update-data`
- [ ] `log-analytics object-collection-rule update`
- [ ] `logging agent-configuration update`
- [ ] `logging agent-configuration update-log-configuration`
- [ ] `logging log-saved-search update`
- [ ] `management-agent agent update`
- [ ] `management-agent agent update-prometheus-datasource`
- [ ] `management-agent install-key update`
- [ ] `monitoring alarm update`
- [ ] `mysql channel update-from-mysql`
- [ ] `mysql db-system update`
- [ ] `network drg-route-distribution update`
- [ ] `network drg-route-distribution-statement update`
- [ ] `network drg-route-table update`
- [ ] `network nsg rules update`
- [ ] `network nsg update`
- [ ] `network private-ip update`
- [ ] `network-firewall application update`
- [ ] `network-firewall decryption-profile update`
- [ ] `network-firewall mapped-secret update`
- [ ] `network-firewall nat-rule update`
- [ ] `network-firewall service update`
- [ ] `network-firewall tunnel-inspection-rule update`
- [ ] `nosql row update`
- [ ] `ocvs esxi-host update`
- [ ] `ocvs sddc update`
- [ ] `opsi database-insights update-autonomous-db`
- [ ] `opsi database-insights update-em-external-db`
- [ ] `opsi database-insights update-macs-external-db`
- [ ] `opsi host-insights update-em-external-host`
- [ ] `opsi host-insights update-macs-external-host`
- [ ] `opsi opsi-private-endpoint update`
- [ ] `os retention-rule update`
- [ ] `os-management-hub dynamic-set update-packages`
- [ ] `os-management-hub lifecycle-environment update`
- [ ] `os-management-hub managed-instance update`
- [ ] `os-management-hub managed-instance update-packages`
- [ ] `os-management-hub managed-instance-group update`
- [ ] `os-management-hub managed-instance-group update-all-packages`
- [ ] `os-management-hub management-station update`
- [ ] `os-management-hub software-source update-custom-swsrc`
- [ ] `os-management-hub update-all-packages-in-compartment`
- [ ] `queue queue-admin consumer-group update`
- [ ] `queue queue-admin queue update`
- [ ] `resource-manager stack update`
- [ ] `resource-manager template update`
- [ ] `rover device data-sync task-definition update`
- [ ] `rover node update`
- [ ] `rover standalone-cluster update`
- [ ] `rover station-cluster update`
- [ ] `stack-monitoring baselineable-metric update`
- [ ] `stack-monitoring config update-onboard-config`
- [ ] `stack-monitoring metric-extension update`
- [ ] `stack-monitoring metric-extension update-http-metric-ext`
- [ ] `stack-monitoring metric-extension update-jmx-metric-ext`
- [ ] `stack-monitoring metric-extension update-os-cmd-metric-ext`
- [ ] `stack-monitoring metric-extension update-sql-metric-ext`
- [ ] `stack-monitoring monitoring-template update`
- [ ] `stack-monitoring resource update`
- [ ] `stack-monitoring resource-task update`
- [ ] `stack-monitoring resource-task update-agent-receiver`
- [ ] `stack-monitoring resource-task update-resource-type-configs`
- [ ] `stack-monitoring resource-type update`
- [ ] `stack-monitoring resource-type update-system-format-resource-type`
- [ ] `support incident update`
- [ ] `vbstudio instance update`
- [ ] `visual-builder vb-instance update`
- [ ] `waas certificate update-address-list`
- [ ] `waas custom-protection-rule update-setting`
- [ ] `waas policy-config update`

</details>

### 4/5 — Configuration and session workflows

<details>
<summary>7 commands</summary>

- [ ] `profile diagnose`
- [ ] `session terminate`
- [ ] `setup bootstrap`
- [ ] `setup find-installations`
- [ ] `setup instance-principal`
- [ ] `setup oci-cli-rc`
- [ ] `setup pkcs11-auth`

</details>

### 4/5 — Credentials and certificates

<details>
<summary>55 commands</summary>

- [ ] `ce cluster generate-token`
- [ ] `certs-mgmt certificate create-certificate-issued-by-internal-ca`
- [ ] `certs-mgmt certificate create-certificate-managed-externally-issued-by-internal-ca`
- [ ] `certs-mgmt certificate update-certificate-by-importing-config-details`
- [ ] `certs-mgmt certificate update-certificate-managed-externally`
- [ ] `certs-mgmt certificate update-certificate-managed-internally`
- [ ] `database-management managed-database cfg-auto-capture-filters-with-password`
- [ ] `database-management managed-database cfg-auto-capture-filters-with-secret`
- [ ] `database-management managed-database cfg-auto-spm-evolve-task-with-password`
- [ ] `database-management managed-database cfg-auto-spm-evolve-task-with-secret`
- [ ] `database-management managed-database change-plan-retention-with-password`
- [ ] `database-management managed-database change-plan-retention-with-secret`
- [ ] `database-management managed-database change-space-budget-with-password`
- [ ] `database-management managed-database change-space-budget-with-secret`
- [ ] `database-management managed-database change-spb-attr-with-password`
- [ ] `database-management managed-database change-spb-attr-with-secret`
- [ ] `database-management managed-database disable-auto-plan-capture-with-password`
- [ ] `database-management managed-database disable-auto-plan-capture-with-secret`
- [ ] `database-management managed-database disable-auto-spm-evolve-task-with-password`
- [ ] `database-management managed-database disable-auto-spm-evolve-task-with-secret`
- [ ] `database-management managed-database disable-hf-auto-spm-evolve-task-with-password`
- [ ] `database-management managed-database disable-hf-auto-spm-evolve-task-with-secret`
- [ ] `database-management managed-database disable-spb-usage-with-password`
- [ ] `database-management managed-database disable-spb-usage-with-secret`
- [ ] `database-management managed-database drop-sql-plan-baselines-with-password`
- [ ] `database-management managed-database drop-sql-plan-baselines-with-secret`
- [ ] `database-management managed-database enable-auto-plan-capture-with-password`
- [ ] `database-management managed-database enable-auto-plan-capture-with-secret`
- [ ] `database-management managed-database enable-auto-spm-evolve-task-with-password`
- [ ] `database-management managed-database enable-auto-spm-evolve-task-with-secret`
- [ ] `database-management managed-database enable-hf-auto-spm-evolve-task-with-password`
- [ ] `database-management managed-database enable-hf-auto-spm-evolve-task-with-secret`
- [ ] `database-management managed-database enable-spb-usage-with-password`
- [ ] `database-management managed-database enable-spb-usage-with-secret`
- [ ] `database-management managed-database load-spb-from-awr-with-password`
- [ ] `database-management managed-database load-spb-from-awr-with-secret`
- [ ] `database-management managed-database load-spb-from-cc-with-password`
- [ ] `database-management managed-database load-spb-from-cc-with-secret`
- [ ] `database-management tablespace drop-with-secret`
- [ ] `database-management tablespace remove-datafile-with-secret`
- [ ] `dbtools identity refresh-oracle-database-resource-principal-credential`
- [ ] `dbtools identity validate-oracle-database-resource-principal-credential`
- [ ] `media-services media-stream stream-distribution-channel generate-session-token`
- [ ] `opsi database-insights change-autonomous-database-insight-advanced-features-credential-by-vault`
- [ ] `opsi database-insights change-macs-managed-autonomous-database-insight-connection-credential-by-named-credentials`
- [ ] `opsi database-insights change-macs-managed-cloud-database-insight-connection-credential-by-vault`
- [ ] `opsi database-insights enable-autonomous-database-insight-advanced-features-credential-by-vault`
- [ ] `opsi database-insights test-macs-managed-autonomous-database-insight-connection-credential-by-named-credentials`
- [ ] `opsi database-insights test-macs-managed-cloud-database-insight-connection-credential-by-vault`
- [ ] `rover node get-certificate`
- [ ] `rover node set-secrets`
- [ ] `rover standalone-cluster get-certificate`
- [ ] `rover standalone-cluster set-secrets`
- [ ] `rover station-cluster get-certificate`
- [ ] `rover station-cluster set-secrets`

</details>

### 4/5 — Lifecycle transitions and scheduling

<details>
<summary>49 commands</summary>

- [ ] `apm-traces attributes activate`
- [ ] `apm-traces attributes deactivate`
- [ ] `certs-mgmt certificate-authority-version cancel-deletion`
- [ ] `certs-mgmt certificate-authority-version schedule-deletion`
- [ ] `certs-mgmt certificate-version cancel-deletion`
- [ ] `certs-mgmt certificate-version schedule-deletion`
- [ ] `compute instance launch`
- [ ] `data-science ml-app-instance-view disable-trigger`
- [ ] `data-science ml-app-instance-view enable-trigger`
- [ ] `db database enable-database-management`
- [ ] `db external-cdb disable-db-management`
- [ ] `db external-cdb enable-db-management`
- [ ] `db external-non-cdb disable-db-management`
- [ ] `db external-non-cdb disable-operations-insights`
- [ ] `db external-non-cdb enable-db-management`
- [ ] `db external-non-cdb enable-operations-insights`
- [ ] `db external-pdb disable-db-management`
- [ ] `db external-pdb disable-operations-insights`
- [ ] `db external-pdb enable-db-management`
- [ ] `db external-pdb enable-operations-insights`
- [ ] `db node start`
- [ ] `db node stop`
- [ ] `db pluggable-database enable-pluggable-database-management`
- [ ] `db system launch`
- [ ] `db system launch-from-database`
- [ ] `db system launch-from-db-system`
- [ ] `generative-ai-data enrichment-jobs cancel`
- [ ] `instance-agent command cancel`
- [ ] `integration integration-instance start`
- [ ] `integration integration-instance stop`
- [ ] `kms management key-version cancel-deletion`
- [ ] `kms management key-version schedule-deletion`
- [ ] `limits-increase item cancel`
- [ ] `limits-increase limits-increase-request cancel`
- [ ] `mysql db-system start`
- [ ] `mysql db-system stop`
- [ ] `opsi database-insights enable-em-external-db`
- [ ] `opsi host-insights enable-em-external-host`
- [ ] `opsi host-insights enable-macs-external-host`
- [ ] `os-management-hub lifecycle-stage reboot`
- [ ] `os-management-hub managed-instance-group reboot`
- [ ] `rover device data-sync task cancel`
- [ ] `rover device data-sync task start`
- [ ] `rover device diagnostics bundle cancel`
- [ ] `stack-monitoring metric-extension disable`
- [ ] `stack-monitoring metric-extension enable`
- [ ] `stack-monitoring resource disable-external-database`
- [ ] `visual-builder vb-instance start`
- [ ] `visual-builder vb-instance stop`

</details>

### 4/5 — Other service-specific actions

<details>
<summary>52 commands</summary>

- [ ] `apm-traces attributes pin`
- [ ] `apm-traces attributes unpin`
- [ ] `apm-traces query query-response run-query`
- [ ] `bds instance install-patch`
- [ ] `bds instance install-patch-domain-based-odh-patching-config`
- [ ] `bds instance install-patch-downtime-based-odh-patching-config`
- [ ] `bv backup copy`
- [ ] `bv boot-volume-backup copy`
- [ ] `certs-mgmt certificate-authority-version revoke`
- [ ] `certs-mgmt certificate-version revoke`
- [ ] `data-catalog search query`
- [ ] `data-flow run submit`
- [ ] `dbtools-runtime connection execute-sql async`
- [ ] `dbtools-runtime connection execute-sql sync`
- [ ] `dif stack deploy-artifacts`
- [ ] `generative-ai-data enrichment-jobs generate`
- [ ] `generative-ai-data enrichment-jobs generate-delta-refresh`
- [ ] `generative-ai-data enrichment-jobs generate-full-build`
- [ ] `generative-ai-data enrichment-jobs generate-partial-build`
- [ ] `generative-ai-data generate-sql-jobs generate`
- [ ] `generative-ai-sandbox sandbox-file read`
- [ ] `generative-ai-sandbox sandbox-file write`
- [ ] `iam tag reactivate`
- [ ] `iam tag retire`
- [ ] `iam tag-namespace reactivate`
- [ ] `iam tag-namespace retire`
- [ ] `integration integration-instance change-network-endpoint`
- [ ] `log-analytics lookup append-data`
- [ ] `log-analytics lookup register-lookup`
- [ ] `log-analytics parser extract-structured-log-field-paths`
- [ ] `log-analytics parser extract-structured-log-header-paths`
- [ ] `log-analytics parser test-parser`
- [ ] `log-analytics parser upsert-parser`
- [ ] `log-analytics source upsert-source`
- [ ] `log-analytics source validate-source`
- [ ] `log-analytics source validate-source-extfield-details`
- [ ] `log-analytics storage recall-archived-data`
- [ ] `model-deployment inference-result predict`
- [ ] `network remote-peering-connection connect`
- [ ] `ocvs esxi-host replace-host`
- [ ] `ocvs sddc vmware-versions`
- [ ] `optimizer resource-action-summary filter-resource-actions`
- [ ] `os multipart abort`
- [ ] `os object copy`
- [ ] `os object reencrypt`
- [ ] `raw-request `
- [ ] `resource-manager stack copy`
- [ ] `search resource structured-search`
- [ ] `stack-monitoring baselineable-metric evaluate`
- [ ] `stack-monitoring metric-extension publish`
- [ ] `stack-monitoring metric-extension test`
- [ ] `stack-monitoring resource manage-license`

</details>

### 4/5 — Resource creation and variants

<details>
<summary>245 commands</summary>

- [ ] `adm vulnerability-audit create`
- [ ] `adm vulnerability-audit create-vulnerability-audit-external-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-oci-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-unknown-source-vulnerability-audit-source`
- [ ] `analytics analytics-instance create`
- [ ] `analytics analytics-instance create-vanity-url`
- [ ] `api-gateway certificate create`
- [ ] `apm-synthetics dedicated-vantage-point create-with-oracle-rm-stack`
- [ ] `apm-synthetics monitor create-browser-monitor`
- [ ] `apm-synthetics monitor create-dns-sec-monitor`
- [ ] `apm-synthetics monitor create-dns-server-monitor`
- [ ] `apm-synthetics monitor create-dns-trace-monitor`
- [ ] `apm-synthetics monitor create-ftp-monitor`
- [ ] `apm-synthetics monitor create-network-monitor`
- [ ] `apm-synthetics monitor create-rest-monitor`
- [ ] `apm-synthetics monitor create-scripted-browser-monitor`
- [ ] `apm-synthetics monitor create-scripted-rest-monitor`
- [ ] `apm-synthetics monitor create-sql-monitor`
- [ ] `apm-synthetics worker create`
- [ ] `apm-traces scheduled-query create`
- [ ] `autoscaling policy create`
- [ ] `bastion bastion create`
- [ ] `bastion session create`
- [ ] `bastion session create-managed-ssh`
- [ ] `bastion session create-port-forwarding`
- [ ] `batch batch-context create-oci-logging-configuration`
- [ ] `bv boot-volume create`
- [ ] `bv volume create`
- [ ] `capacity-management demand-signal occm-demand-signal-item create`
- [ ] `capacity-management occ-capacity-request create`
- [ ] `ccc infrastructure create`
- [ ] `ce cluster create`
- [ ] `ce cluster create-kubeconfig`
- [ ] `ce node-pool create`
- [ ] `certs-mgmt certificate create-by-importing-config`
- [ ] `certs-mgmt certificate-authority create-root-ca-by-generating-config-details`
- [ ] `certs-mgmt certificate-authority create-root-ca-managed-externally`
- [ ] `certs-mgmt certificate-authority create-subordinate-ca-issued-by-internal-ca`
- [ ] `certs-mgmt certificate-authority create-subordinate-ca-managed-internally-issued-by-external-ca`
- [ ] `cloud-bridge discovery asset-source create`
- [ ] `cloud-bridge inventory asset create`
- [ ] `cloud-guard data-mask-rule create`
- [ ] `cloud-guard data-mask-rule create-for-all-targets`
- [ ] `cloud-guard data-mask-rule create-for-services`
- [ ] `cloud-guard data-mask-rule create-for-targets`
- [ ] `cloud-migrations target-asset create`
- [ ] `compute image-capability-schema create`
- [ ] `compute instance-console-connection create`
- [ ] `compute pic subscription create`
- [ ] `cpg cluster-placement-group create`
- [ ] `data-flow application create`
- [ ] `data-flow run create`
- [ ] `data-integration connection create`
- [ ] `data-integration data-asset create`
- [ ] `data-integration schedule create`
- [ ] `data-integration schedule create-custom-frequency`
- [ ] `data-integration schedule create-daily-frequency`
- [ ] `data-integration schedule create-hourly-frequency`
- [ ] `data-integration schedule create-monthly-frequency`
- [ ] `data-integration schedule create-monthly-rule-frequency`
- [ ] `data-integration schedule create-weekly-frequency`
- [ ] `data-integration task create-pipeline-task`
- [ ] `data-integration task create-task-from-rest-task`
- [ ] `data-integration task create-task-from-sql-task`
- [ ] `data-integration task-validation create-from-pipeline-task`
- [ ] `data-integration workspace create`
- [ ] `data-safe registration-policy create`
- [ ] `data-science ds-private-endpoint create`
- [ ] `data-science job create`
- [ ] `data-science job create-job-artifact`
- [ ] `data-science job-run create`
- [ ] `data-science ml-app-implementation create`
- [ ] `data-science ml-app-instance create`
- [ ] `data-science ml-app-instance create-with-iam-auth`
- [ ] `data-science model create-model-artifact`
- [ ] `data-science notebook-session create`
- [ ] `data-science pipeline create-step-artifact`
- [ ] `database-migration connection create-oracle-connection`
- [ ] `datacc infrastructure create`
- [ ] `db autonomous-database create`
- [ ] `db autonomous-database create-adb-cross-region-data-guard-details`
- [ ] `db backup create`
- [ ] `db cloud-vm-cluster create`
- [ ] `db database create`
- [ ] `db database create-database-from-database`
- [ ] `db database create-from-database`
- [ ] `db database create-standby-database`
- [ ] `db db-home create`
- [ ] `db exadb-vm-cluster create`
- [ ] `db exascale-db-storage-vault create`
- [ ] `db external-pdb create`
- [ ] `db key-store create-oracle-key-vault-details`
- [ ] `db pluggable-database create`
- [ ] `db vm-cluster create`
- [ ] `dbtools connection create-generic-jdbc`
- [ ] `dbtools connection create-mysql-database`
- [ ] `dbtools connection create-oracle-database`
- [ ] `dbtools connection create-postgresql`
- [ ] `dbtools identity create-oracle-database-resource-principal`
- [ ] `devops build-pipeline-stage create-build-stage`
- [ ] `devops build-pipeline-stage create-deliver-artifact-stage`
- [ ] `devops build-pipeline-stage create-trigger-deployment-stage`
- [ ] `devops build-pipeline-stage create-wait-stage`
- [ ] `devops connection create-bitbucket-cloud-connection`
- [ ] `devops connection create-bitbucket-server-connection`
- [ ] `devops connection create-github-connection`
- [ ] `devops connection create-gitlab-connection`
- [ ] `devops connection create-gitlab-server-connection`
- [ ] `devops deploy-artifact create-generic-artifact`
- [ ] `devops deploy-artifact create-helm-command-spec`
- [ ] `devops deploy-artifact create-helm-repository-artifact`
- [ ] `devops deploy-artifact create-inline-artifact`
- [ ] `devops deploy-artifact create-ocir-artifact`
- [ ] `devops deploy-pipeline create`
- [ ] `devops deploy-stage create-compute-instance-group-blue-green-traffic-shift-stage`
- [ ] `devops deploy-stage create-compute-instance-group-canary-approval-stage`
- [ ] `devops deploy-stage create-compute-instance-group-canary-traffic-shift-stage`
- [ ] `devops deploy-stage create-deploy-compute-instance-group-blue-green-stage`
- [ ] `devops deploy-stage create-deploy-compute-instance-group-canary-stage`
- [ ] `devops deploy-stage create-deploy-compute-instance-group-stage`
- [ ] `devops deploy-stage create-deploy-function-stage`
- [ ] `devops deploy-stage create-deploy-oke-blue-green-stage`
- [ ] `devops deploy-stage create-deploy-oke-canary-stage`
- [ ] `devops deploy-stage create-deploy-oke-stage`
- [ ] `devops deploy-stage create-invoke-function-stage`
- [ ] `devops deploy-stage create-load-balancer-traffic-shift-stage`
- [ ] `devops deploy-stage create-manual-approval-stage`
- [ ] `devops deploy-stage create-oke-blue-green-traffic-shift-stage`
- [ ] `devops deploy-stage create-oke-canary-approval-stage`
- [ ] `devops deploy-stage create-oke-canary-traffic-shift-stage`
- [ ] `devops deploy-stage create-oke-helm-chart-stage`
- [ ] `devops deploy-stage create-shell-stage`
- [ ] `devops deploy-stage create-wait-stage`
- [ ] `devops deployment create-pipeline-deployment`
- [ ] `devops deployment create-pipeline-redeployment`
- [ ] `devops deployment create-single-stage-deployment`
- [ ] `devops deployment create-single-stage-redeployment`
- [ ] `dif stack create`
- [ ] `disaster-recovery dr-plan-execution create-start-drill`
- [ ] `disaster-recovery dr-plan-execution create-start-drill-precheck`
- [ ] `disaster-recovery dr-plan-execution create-stop-drill`
- [ ] `disaster-recovery dr-plan-execution create-stop-drill-precheck`
- [ ] `dns zone create`
- [ ] `email email-ip-pool create`
- [ ] `fleet-software-update fsu-cycle create-patch`
- [ ] `fusion-apps fusion-environment create`
- [ ] `gdp pipeline create`
- [ ] `generative-ai imported-model create-from-huggingface`
- [ ] `generative-ai imported-model create-from-objectstorage`
- [ ] `goldengate connection create-amazon-kinesis-connection`
- [ ] `goldengate connection create-amazon-s3-connection`
- [ ] `goldengate connection create-azure-data-lake-storage-connection`
- [ ] `goldengate connection create-google-big-query-connection`
- [ ] `goldengate connection create-google-cloud-storage-connection`
- [ ] `goldengate connection create-microsoft-fabric-connection`
- [ ] `goldengate connection create-object-storage-connection`
- [ ] `goldengate connection create-oracle-ai-data-platform-connection`
- [ ] `goldengate connection create-oracle-nosql-connection`
- [ ] `goldengate deployment create`
- [ ] `goldengate pipeline create-zero-etl-pipeline`
- [ ] `iam compartment create`
- [ ] `identity-domains api-key create`
- [ ] `identity-domains app create`
- [ ] `identity-domains auth-token create`
- [ ] `identity-domains customer-secret-key create`
- [ ] `identity-domains dynamic-resource-group create`
- [ ] `identity-domains group create`
- [ ] `identity-domains identity-provider create`
- [ ] `identity-domains me create`
- [ ] `identity-domains o-auth2-client-credential create`
- [ ] `identity-domains smtp-credential create`
- [ ] `identity-domains user create`
- [ ] `identity-domains user-db-credential create`
- [ ] `instance-agent command create`
- [ ] `integration integration-instance create`
- [ ] `kms management key-version create`
- [ ] `lb backend-set create`
- [ ] `lb certificate create`
- [ ] `lb listener create`
- [ ] `lb load-balancer create`
- [ ] `limits-increase limits-increase-request create`
- [ ] `log-analytics entity create`
- [ ] `logging agent-configuration create-log-configuration`
- [ ] `logging log-saved-search create`
- [ ] `management-agent agent create-prometheus-datasource`
- [ ] `monitoring alarm create`
- [ ] `mysql channel create-from-mysql`
- [ ] `mysql db-system create`
- [ ] `network drg-route-table create`
- [ ] `network virtual-circuit create`
- [ ] `network-firewall application create`
- [ ] `network-firewall decryption-profile create`
- [ ] `network-firewall mapped-secret create`
- [ ] `network-firewall nat-rule create`
- [ ] `network-firewall service create`
- [ ] `network-firewall tunnel-inspection-rule create`
- [ ] `nosql index create`
- [ ] `nosql table create-replica`
- [ ] `ocvs esxi-host create`
- [ ] `ocvs sddc create`
- [ ] `oma lockbox create`
- [ ] `ons subscription create`
- [ ] `opsi database-insights create-em-external-db`
- [ ] `opsi exadata-insights create-em-external-exadata`
- [ ] `opsi host-insights create-em-external-host`
- [ ] `opsi host-insights create-macs-external-host`
- [ ] `os replication create-replication-policy`
- [ ] `os retention-rule create`
- [ ] `os-management-hub management-station create`
- [ ] `os-management-hub profile create-group-profile`
- [ ] `os-management-hub profile create-lifecycle-profile`
- [ ] `os-management-hub scheduled-job create`
- [ ] `os-management-hub software-source create-custom-swsrc`
- [ ] `os-management-hub software-source create-versioned-custom-swsrc`
- [ ] `pss instance create`
- [ ] `queue queue-admin consumer-group create`
- [ ] `queue queue-admin queue create`
- [ ] `resource-manager job create-apply-job`
- [ ] `resource-manager job create-apply-rollback-job`
- [ ] `resource-manager job create-destroy-job`
- [ ] `resource-manager job create-import-tf-state-job`
- [ ] `resource-manager job create-plan-job`
- [ ] `resource-manager job create-plan-rollback-job`
- [ ] `resource-manager stack create`
- [ ] `resource-manager stack create-from-template`
- [ ] `resource-manager template create`
- [ ] `rover create-master-key-policy`
- [ ] `rover device data-sync task-definition create`
- [ ] `rover device diagnostics bundle create`
- [ ] `rover node create`
- [ ] `rover standalone-cluster create`
- [ ] `rover station-cluster create`
- [ ] `stack-monitoring baselineable-metric create`
- [ ] `stack-monitoring config create-onboard-config`
- [ ] `stack-monitoring metric-extension create`
- [ ] `stack-monitoring metric-extension create-http-metric-ext`
- [ ] `stack-monitoring metric-extension create-jmx-metric-ext`
- [ ] `stack-monitoring metric-extension create-os-cmd-metric-ext`
- [ ] `stack-monitoring metric-extension create-sql-metric-ext`
- [ ] `stack-monitoring monitoring-template create`
- [ ] `stack-monitoring resource create`
- [ ] `stack-monitoring resource-type create-system-format-resource-type`
- [ ] `support incident create`
- [ ] `vault secret create-base64`
- [ ] `vbstudio instance create`

</details>

### 4/5 — Specialized database operations

<details>
<summary>34 commands</summary>

- [ ] `data-safe target-database manage-privileges`
- [ ] `database-management tablespace drop-with-pwd`
- [ ] `db autonomous-database-wallet rotate`
- [ ] `db cloud-exa-infra configure-exascale`
- [ ] `db data-guard-association create from-existing-db-system`
- [ ] `db data-guard-association create from-existing-vm-cluster`
- [ ] `db data-guard-association create with-new-db-system`
- [ ] `db data-guard-association reinstate`
- [ ] `db database convert-to-new-pdb`
- [ ] `db database convert-to-new-pdb-precheck`
- [ ] `db database convert-to-pdb-sync`
- [ ] `db database convert-to-pdb-sync-rollback`
- [ ] `db database modify-database-management`
- [ ] `db external-cdb scan-pluggable-databases`
- [ ] `db external-db-connector check-connection-status`
- [ ] `db node force-reset`
- [ ] `db node force-stop`
- [ ] `db node reset`
- [ ] `db node soft-reset`
- [ ] `db patch get by-database`
- [ ] `db patch list by-database`
- [ ] `db patch-history get by-database`
- [ ] `db patch-history list by-database`
- [ ] `db pluggable-database convert-to-regular`
- [ ] `db pluggable-database modify-pluggable-database-management`
- [ ] `db pluggable-database refresh`
- [ ] `db pluggable-database relocate-pdb`
- [ ] `dbtools connection validate-mysql-database`
- [ ] `dbtools connection validate-oracle-database`
- [ ] `dbtools connection validate-postgresql`
- [ ] `opsi opsi-data-objects query-data-standard-query`
- [ ] `opsi opsi-data-objects query-data-templatized-query`
- [ ] `opsi opsi-warehouse-data-objects query-warehouse-data-standard-query`
- [ ] `opsi opsi-warehouse-data-objects query-warehouse-data-templatized-query`

</details>

### 4/5 — Specialized development and data operations

<details>
<summary>17 commands</summary>

- [ ] `data-integration task-run-lineage list_taskrun_lineages`
- [ ] `data-science job head-job-artifact`
- [ ] `data-science ml-app-instance trigger`
- [ ] `data-science ml-app-instance-view trigger`
- [ ] `data-science model head-model-artifact`
- [ ] `data-science pipeline head-step-artifact`
- [ ] `devops deployment approve`
- [ ] `fn function create archive-function direct-archive fn-update-runtime-config`
- [ ] `fn function create archive-function direct-archive manual-runtime-config`
- [ ] `fn function create archive-function object-storage fn-update-runtime-config`
- [ ] `fn function create archive-function object-storage manual-runtime-config`
- [ ] `fn function create container-function`
- [ ] `fn function create pbf-function`
- [ ] `fn function invoke`
- [ ] `fn function update archive-function`
- [ ] `fn function update container-function`
- [ ] `fn function update pbf-function`

</details>

### 4/5 — Specialized infrastructure operations

<details>
<summary>18 commands</summary>

- [ ] `compute image export to-object`
- [ ] `compute image export to-object-uri`
- [ ] `compute image import from-object`
- [ ] `compute image import from-object-uri`
- [ ] `compute instance action`
- [ ] `os-management-hub install-all-windows-updates-in-compartment`
- [ ] `os-management-hub lifecycle-stage promote-software-source`
- [ ] `os-management-hub managed-instance install-windows-updates`
- [ ] `os-management-hub managed-instance-group install-module-profile`
- [ ] `os-management-hub managed-instance-group install-packages`
- [ ] `os-management-hub managed-instance-group install-windows-updates`
- [ ] `os-management-hub managed-instance-group refresh-software`
- [ ] `os-management-hub software-source change-availability`
- [ ] `rover device data-sync task-definition change-state`
- [ ] `rover node request-approval`
- [ ] `rover node setup-identity`
- [ ] `rover standalone-cluster request-approval`
- [ ] `rover station-cluster request-approval`

</details>

### 5/5 — Backup, recovery, and migration

<details>
<summary>35 commands</summary>

- [ ] `artifacts container image restore`
- [ ] `data-science ml-app-instance-view recover`
- [ ] `db autonomous-database change-disaster-recovery-configuration`
- [ ] `db autonomous-database create-from-backup-id`
- [ ] `db autonomous-database create-from-backup-timestamp`
- [ ] `db autonomous-database create-from-clone`
- [ ] `db autonomous-database create-refreshable-clone`
- [ ] `db data-guard-association failover`
- [ ] `db data-guard-association switchover`
- [ ] `db database create-from-backup`
- [ ] `db database restore`
- [ ] `db database upgrade-rollback`
- [ ] `db database upgrade-with-database-software-image`
- [ ] `db database upgrade-with-db-home`
- [ ] `db database upgrade-with-db-version`
- [ ] `db pluggable-database create-local-clone`
- [ ] `db pluggable-database create-remote-clone`
- [ ] `db pluggable-database local-clone`
- [ ] `db pluggable-database remote-clone`
- [ ] `db system launch-from-backup`
- [ ] `db system upgrade`
- [ ] `disaster-recovery dr-plan-execution create-failover`
- [ ] `disaster-recovery dr-plan-execution create-failover-precheck`
- [ ] `disaster-recovery dr-plan-execution create-switchover`
- [ ] `disaster-recovery dr-plan-execution create-switchover-precheck`
- [ ] `dns zone migrate-from-dynect`
- [ ] `kms management key backup`
- [ ] `kms management key restore`
- [ ] `kms management vault backup`
- [ ] `kms management vault restore`
- [ ] `mysql db-system clone`
- [ ] `ocvs esxi-host inplace-upgrade`
- [ ] `os object restore`
- [ ] `os object restore-status`
- [ ] `psql db-system upgrade`

</details>

### 5/5 — Bulk and batch operations

<details>
<summary>17 commands</summary>

- [ ] `bds instance install-patch-batching-based-odh-patching-config`
- [ ] `fleet-software-update fsu-cycle update-fifty-batch`
- [ ] `fleet-software-update fsu-cycle update-saf-batch`
- [ ] `fleet-software-update fsu-cycle update-sequential-batch`
- [ ] `network-firewall address-list bulk-upload`
- [ ] `network-firewall application bulk-upload`
- [ ] `network-firewall application-group bulk-upload`
- [ ] `network-firewall decryption-profile bulk-upload`
- [ ] `network-firewall decryption-rule bulk-upload`
- [ ] `network-firewall mapped-secret bulk-upload`
- [ ] `network-firewall nat-rule bulk-upload`
- [ ] `network-firewall security-rule bulk-upload`
- [ ] `network-firewall service bulk-upload`
- [ ] `network-firewall service-list bulk-upload`
- [ ] `network-firewall tunnel-inspection-rule bulk-upload`
- [ ] `network-firewall url-list bulk-upload`
- [ ] `os object bulk-delete-versions`

</details>

### 5/5 — File transfers and streaming

<details>
<summary>29 commands</summary>

- [ ] `artifacts container image-signature sign-upload`
- [ ] `artifacts generic artifact download-by-path`
- [ ] `artifacts generic artifact upload-by-path`
- [ ] `data-science ml-app-implementation download-package`
- [ ] `data-science ml-app-implementation upload-package`
- [ ] `data-science ml-app-implementation-version download-package`
- [ ] `generative-ai-sandbox sandbox-command stream`
- [ ] `generative-ai-sandbox sandbox-command-event stream`
- [ ] `iam user api-key upload`
- [ ] `kms management key restore-from-file`
- [ ] `kms management vault restore-from-file`
- [ ] `log-analytics content-import import-custom-content`
- [ ] `log-analytics entity upload-discovery-data`
- [ ] `log-analytics query export`
- [ ] `log-analytics upload upload-log-events-file`
- [ ] `log-analytics upload upload-log-file`
- [ ] `log-analytics upload upload-otlp-logs`
- [ ] `management-dashboard dashboard export`
- [ ] `model-deployment inference-result predict-with-response-stream`
- [ ] `mysql db-system import`
- [ ] `os-management-hub managed-instance-group disable-module-stream`
- [ ] `os-management-hub managed-instance-group enable-module-stream`
- [ ] `os-management-hub managed-instance-group switch-module-stream`
- [ ] `os-management-hub software-source list-module-streams`
- [ ] `rover device system-upgrade import-bundle`
- [ ] `rover device system-upgrade upload-bundle`
- [ ] `service-catalog private-application-package download-config`
- [ ] `stack-monitoring metric-extension export`
- [ ] `stack-monitoring resource-task import-telemetry-resources`

</details>

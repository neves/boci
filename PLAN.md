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

- [x] `apm-traces scheduled-query get`
- [x] `apm-traces trace log get`
- [x] `apm-traces trace span get`
- [x] `apm-traces trace trace get`
- [x] `ccc infrastructure get`
- [x] `ccc upgrade-schedule get`
- [x] `certificates certificate-authority-bundle get`
- [x] `certificates certificate-bundle get`
- [x] `certs-mgmt certificate-authority-version get`
- [x] `certs-mgmt certificate-version get`
- [x] `compute capacity-topology get`
- [x] `compute global-image-capability-schema get`
- [x] `compute global-image-capability-schema-version get`
- [x] `compute image-capability-schema get`
- [x] `compute pic agreements get`
- [x] `compute-management instance-pool lb-attachment get`
- [x] `data-integration connection-validation get`
- [x] `data-integration data-flow-validation get`
- [x] `data-safe private-endpoint get`
- [x] `data-science ds-private-endpoint get`
- [x] `data-science ml-app get`
- [x] `data-science ml-app-implementation get`
- [x] `data-science ml-app-implementation-version get`
- [x] `data-science ml-app-instance get`
- [x] `data-science ml-app-instance-view get`
- [x] `database-management private-endpoint get`
- [x] `db cloud-exa-infra get`
- [x] `db db-system-upgrade-history get`
- [x] `db external-cdb get`
- [x] `db external-db-connector get`
- [x] `db external-non-cdb get`
- [x] `db external-pdb get`
- [x] `db pdb-conversion-history get`
- [x] `db upgrade-history get`
- [x] `dbtools connection get`
- [x] `dbtools endpoint-service get`
- [x] `dbtools identity get`
- [x] `dbtools private-endpoint get`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec create default`
- [ ] `dbtools-runtime database-api-gateway-config-pool-auto-api-spec update default`
- [x] `devops build-pipeline-stage get`
- [x] `devops deploy-artifact get`
- [x] `devops deploy-environment get`
- [x] `devops deploy-pipeline get`
- [x] `devops deploy-stage get`
- [x] `generative-ai-data enrichment-jobs get`
- [x] `generative-ai-data generate-sql-jobs get`
- [ ] `iam db-token get`
- [x] `instance-agent command get`
- [x] `instance-agent command-execution get`
- [x] `integration integration-instance get`
- [x] `limits-increase item get`
- [x] `limits-increase limits-increase-request get`
- [x] `log-analytics em-bridge get`
- [x] `log-analytics entity get`
- [x] `log-analytics entity-type get`
- [x] `log-analytics log-group get`
- [x] `log-analytics object-collection-rule get`
- [x] `logging agent-configuration get`
- [x] `management-agent agent get`
- [x] `management-agent install-key get`
- [x] `media-services media-asset-distribution-channel-attachment get`
- [x] `network drg-route-distribution get`
- [x] `network nsg get`
- [ ] `network public-ip get`
- [x] `ocvs esxi-host get`
- [x] `opsi awr-hub-objects get`
- [x] `opsi awr-hub-objects head`
- [x] `opsi opsi-private-endpoint get`
- [ ] `os object head`
- [x] `os-management-hub lifecycle-environment get`
- [x] `os-management-hub lifecycle-stage get`
- [x] `os-management-hub managed-instance-group get`
- [ ] `rover device data-sync task get`
- [ ] `rover device data-sync task-definition get`
- [ ] `rover device diagnostics bundle get`
- [ ] `rover node show`
- [ ] `rover standalone-cluster show`
- [ ] `rover station-cluster show`
- [x] `service-catalog private-application-package get`
- [x] `service-catalog service-catalog-association get`
- [x] `stack-monitoring baselineable-metric get`
- [x] `stack-monitoring metric-extension get`
- [x] `stack-monitoring resource get`
- [x] `stack-monitoring resource-task get`
- [x] `stack-monitoring resource-type get`
- [x] `vbstudio instance get`
- [x] `visual-builder vb-instance get`

</details>

### 2/5 — Collection listing and pagination

<details>
<summary>79 commands</summary>

- [x] `apm-traces scheduled-query list`
- [ ] `artifacts container image list`
- [ ] `artifacts container image-signature list`
- [ ] `artifacts container repository list`
- [ ] `artifacts generic artifact list`
- [ ] `artifacts repository list`
- [ ] `audit event list`
- [x] `ccc infrastructure list`
- [x] `ccc upgrade-schedule list`
- [x] `cloud-guard problem list`
- [x] `compute capacity-topology bare-metal-host list`
- [x] `compute capacity-topology hpc-island list`
- [x] `compute capacity-topology network-block list`
- [x] `compute global-image-capability-schema-version list`
- [ ] `compute volume-attachment list`
- [x] `data-science ds-private-endpoint list`
- [x] `data-science ml-app list`
- [x] `data-science ml-app-implementation list`
- [x] `data-science ml-app-implementation-version list`
- [x] `data-science ml-app-instance list`
- [x] `data-science ml-app-instance-view list`
- [ ] `data-science pipeline list`
- [ ] `data-science pipeline-run list`
- [x] `db backup list`
- [x] `db cloud-vm-cluster list`
- [ ] `db database list`
- [x] `db exadb-vm-cluster list`
- [x] `db exascale-db-storage-vault list`
- [x] `db gi-minor-version-summary list`
- [x] `dbtools identity list`
- [x] `dbtools-runtime credential list`
- [x] `devops deploy-stage list`
- [x] `devops deployment list`
- [x] `goldengate ai-model list`
- [ ] `iam compartment list`
- [ ] `identity-domains apps list`
- [ ] `identity-domains groups list`
- [ ] `identity-domains users list`
- [x] `integration work-request list`
- [x] `log-analytics entity list`
- [x] `log-analytics entity-topology list`
- [x] `logging agent-configuration list`
- [x] `logging log-group list`
- [x] `management-agent agent list`
- [x] `media-services media-workflow-task-declaration list`
- [x] `mysql db-system list`
- [x] `network drg-route-distribution-statement list`
- [x] `network drg-route-table list`
- [x] `network nsg rules list`
- [x] `network nsg vnics list`
- [x] `oce oce-instance list`
- [x] `oce work-request list`
- [x] `oce work-request-error list`
- [x] `oce work-request-log-entry list`
- [x] `ocvs esxi-host list`
- [x] `opsi database-insights list`
- [x] `opsi exadata-insights list`
- [x] `opsi host-insights list`
- [ ] `os object list`
- [x] `os-management-hub event list`
- [x] `os-management-hub lifecycle-environment list`
- [x] `os-management-hub lifecycle-stage list`
- [x] `os-management-hub managed-instance list`
- [x] `os-management-hub managed-instance-group list`
- [x] `os-management-hub management-station list`
- [x] `os-management-hub profile list`
- [x] `os-management-hub scheduled-job list`
- [x] `os-management-hub software-source list`
- [x] `os-management-hub work-request list`
- [ ] `rover device data-sync task list`
- [ ] `rover device data-sync task-definition list`
- [ ] `rover device diagnostics bundle list`
- [x] `service-catalog private-application-package list`
- [x] `service-catalog service-catalog-association list`
- [x] `stack-monitoring baselineable-metric list`
- [x] `stack-monitoring metric-extension list`
- [x] `support incident list`
- [x] `visual-builder application list`
- [x] `visual-builder work-request list`

</details>

### 2/5 — Compartment moves

<details>
<summary>37 commands</summary>

- [x] `ccc infrastructure change-compartment`
- [x] `ccc upgrade-schedule change-compartment`
- [x] `compute capacity-topology change-compartment`
- [x] `compute image-capability-schema change-compartment`
- [ ] `compute instance change-compartment`
- [x] `data-safe private-endpoint change-compartment`
- [x] `data-science ds-private-endpoint change-compartment`
- [x] `data-science ml-app change-compartment`
- [x] `data-science ml-app-implementation change-compartment`
- [x] `data-science ml-app-instance change-compartment`
- [x] `data-science ml-app-instance-view change-compartment`
- [x] `database-management private-endpoint change-compartment`
- [x] `db cloud-exa-infra change-compartment`
- [x] `db external-cdb change-compartment`
- [x] `db external-non-cdb change-compartment`
- [x] `db external-pdb change-compartment`
- [x] `dbtools connection change-compartment`
- [x] `dbtools identity change-compartment`
- [x] `dbtools private-endpoint change-compartment`
- [x] `integration integration-instance change-compartment`
- [x] `log-analytics em-bridge change-compartment`
- [x] `log-analytics entity change-compartment`
- [x] `log-analytics log-group change-compartment`
- [x] `log-analytics object-collection-rule change-compartment`
- [x] `logging agent-configuration change-compartment`
- [x] `network nsg change-compartment`
- [x] `opsi opsi-private-endpoint change-compartment`
- [x] `os-management-hub lifecycle-environment change-compartment`
- [x] `os-management-hub managed-instance-group change-compartment`
- [ ] `rover device data-sync task-definition change-compartment`
- [x] `rover node change-compartment`
- [ ] `rover standalone-cluster change-compartment`
- [ ] `rover station-cluster change-compartment`
- [x] `stack-monitoring metric-extension change-compartment`
- [x] `stack-monitoring resource change-compartment`
- [x] `stack-monitoring resource-task change-compartment`
- [x] `visual-builder vb-instance change-compartment`

</details>

### 2/5 — Filtered lookups and summaries

<details>
<summary>55 commands</summary>

- [ ] `artifacts container image-signature get-verify`
- [x] `artifacts generic artifact get-by-path`
- [ ] `compute instance list-vnics`
- [ ] `compute instance-console-connection get-plink-connection-string`
- [x] `data-flow run list-logs`
- [x] `data-integration task-run-lineage list-task-run-lineages`
- [x] `data-science work-request list-work-request-logs`
- [x] `database-management associated-database-summary list-associated-databases`
- [ ] `database-management managed-database get-awr-db-report`
- [x] `db autonomous-database-wallet get-metadata`
- [x] `db external-cdb list-external-pdbs`
- [x] `db pluggable-database get-snapshot`
- [ ] `devops project summarize-project-analytics`
- [ ] `devops repository summarize-repository-analytics`
- [ ] `iam group list-users`
- [ ] `iam user list-groups`
- [x] `log-analytics assoc list-associated-entities`
- [x] `log-analytics assoc list-entity-source-assocs`
- [x] `log-analytics entity list-associations`
- [x] `log-analytics query search`
- [x] `management-agent agent summarize-plugin-counts`
- [x] `marketplace listing-summary search-listings-free-text`
- [x] `marketplace listing-summary search-listings-structured`
- [x] `monitoring metric-data summarize-metrics-data`
- [x] `opsi database-insights list-database-configurations`
- [x] `opsi enterprise-manager-bridges list-importable-enterprise-manager-entities`
- [x] `opsi host-insights list-host-configurations`
- [ ] `os object list-object-versions`
- [x] `os-management-hub lifecycle-stage list-installed-packages`
- [x] `os-management-hub managed-instance get-analytic-content`
- [x] `os-management-hub managed-instance list-modules`
- [x] `os-management-hub managed-instance summarize-analytics`
- [x] `os-management-hub managed-instance-group list-available-modules`
- [x] `os-management-hub managed-instance-group list-available-packages`
- [x] `os-management-hub managed-instance-group list-available-software-sources`
- [x] `os-management-hub managed-instance-group list-installed-packages`
- [x] `os-management-hub managed-instance-group list-managed-instances`
- [x] `os-management-hub managed-instance-group list-modules`
- [x] `os-management-hub software-source list-all-software-packages`
- [x] `os-management-hub software-source list-module-profiles`
- [x] `os-management-hub software-source search-modules`
- [ ] `resource-manager job get-job-logs`
- [ ] `rover device data-sync task get-snapshot`
- [ ] `rover device diagnostics bundle view-summary`
- [ ] `rover device system-upgrade get-import-history`
- [ ] `rover device system-upgrade get-import-status`
- [x] `rover node get-encryption-key`
- [ ] `rover node list-workload`
- [ ] `rover standalone-cluster list-workloads`
- [ ] `rover station-cluster list-workloads`
- [x] `stack-monitoring metric-extension summarize-metrics`
- [x] `stack-monitoring metric-extension summarize-resources`
- [x] `stack-monitoring resource search-members`
- [x] `threat-intelligence indicator summarize`
- [x] `threat-intelligence indicator-summaries list-indicators`

</details>

### 3/5 — Deletion and confirmation

<details>
<summary>66 commands</summary>

- [x] `apm-traces scheduled-query delete`
- [x] `artifacts generic artifact delete-by-path`
- [x] `ccc infrastructure delete`
- [x] `ccc upgrade-schedule delete`
- [x] `compute capacity-topology delete`
- [x] `compute image-capability-schema delete`
- [x] `data-integration connection-validation delete`
- [x] `data-integration data-flow-validation delete`
- [x] `data-safe private-endpoint delete`
- [x] `data-science ds-private-endpoint delete`
- [x] `data-science ml-app delete`
- [x] `data-science ml-app-implementation delete`
- [x] `data-science ml-app-instance delete`
- [x] `database-management private-endpoint delete`
- [ ] `db autonomous-database delete`
- [x] `db cloud-exa-infra delete`
- [ ] `db database delete`
- [x] `db external-cdb delete`
- [x] `db external-db-connector delete`
- [x] `db external-non-cdb delete`
- [x] `db external-pdb delete`
- [x] `db pluggable-database delete-snapshot`
- [x] `dbtools connection delete`
- [x] `dbtools identity delete`
- [x] `dbtools private-endpoint delete`
- [x] `devops build-pipeline-stage delete`
- [x] `devops deploy-artifact delete`
- [x] `devops deploy-environment delete`
- [x] `devops deploy-pipeline delete`
- [x] `devops deploy-stage delete`
- [x] `devops repository delete-ref`
- [ ] `fn function delete`
- [x] `integration integration-instance delete`
- [x] `limits-increase limits-increase-request delete`
- [x] `log-analytics em-bridge delete`
- [x] `log-analytics entity delete`
- [x] `log-analytics entity-type delete`
- [x] `log-analytics log-group delete`
- [x] `log-analytics object-collection-rule delete`
- [x] `logging agent-configuration delete`
- [x] `management-agent agent delete`
- [x] `management-agent install-key delete`
- [x] `media-services media-asset-distribution-channel-attachment delete`
- [x] `network drg-route-distribution delete`
- [x] `network nsg delete`
- [x] `nosql table delete-replica`
- [x] `ocvs esxi-host delete`
- [x] `opsi awr-hub-objects delete`
- [x] `opsi opsi-private-endpoint delete`
- [ ] `os bucket delete`
- [x] `os-management-hub lifecycle-environment delete`
- [x] `os-management-hub managed-instance-group delete`
- [ ] `rover device data-sync task-definition delete`
- [ ] `rover node delete`
- [ ] `rover node delete-workload`
- [ ] `rover standalone-cluster delete`
- [ ] `rover standalone-cluster delete-workload`
- [ ] `rover station-cluster delete`
- [ ] `rover station-cluster delete-workload`
- [x] `service-catalog service-catalog-association delete`
- [x] `stack-monitoring baselineable-metric delete`
- [x] `stack-monitoring metric-extension delete`
- [x] `stack-monitoring resource delete`
- [x] `stack-monitoring resource-type delete`
- [x] `vbstudio instance delete`
- [x] `visual-builder vb-instance delete`

</details>

### 3/5 — Property and association changes

<details>
<summary>57 commands</summary>

- [x] `apm-config data-file put`
- [x] `artifacts container image remove-version`
- [ ] `compute instance attach-vnic`
- [ ] `compute instance detach-vnic`
- [x] `compute-management instance-pool lb-attachment attach`
- [x] `compute-management instance-pool lb-attachment detach`
- [x] `database-management tablespace remove-datafile-with-pwd`
- [x] `db cloud-exa-infra add-storage`
- [ ] `db database patch`
- [ ] `db system patch`
- [x] `dbtools connection add-lock`
- [x] `dbtools connection remove-lock`
- [x] `dbtools identity add-lock`
- [x] `dbtools identity remove-lock`
- [x] `dbtools private-endpoint add-lock`
- [x] `dbtools private-endpoint remove-lock`
- [x] `dif stack add`
- [ ] `iam group add-user`
- [ ] `iam group remove-user`
- [x] `identity-domains app put`
- [x] `identity-domains authentication-factor-setting put`
- [x] `identity-domains dynamic-resource-group put`
- [x] `identity-domains group put`
- [x] `identity-domains identity-provider put`
- [x] `identity-domains me put`
- [x] `identity-domains user put`
- [x] `identity-domains user-capabilities-changer put`
- [x] `identity-domains user-password-changer put`
- [x] `identity-domains user-password-resetter put`
- [x] `identity-domains user-status-changer put`
- [x] `limits-increase limits-increase-request patch`
- [x] `log-analytics entity add-associations`
- [x] `log-analytics entity remove-associations`
- [x] `logging-ingestion put-logs`
- [x] `network drg-route-distribution-statement add`
- [x] `network drg-route-distribution-statement remove`
- [x] `network nsg rules add`
- [x] `network nsg rules remove`
- [ ] `network vnic assign-ipv6`
- [ ] `network vnic assign-private-ip`
- [ ] `network vnic unassign-ipv6`
- [ ] `network vnic unassign-private-ip`
- [ ] `opsi awr-hub-objects put`
- [x] `os-management-hub lifecycle-stage attach-managed-instance`
- [x] `os-management-hub lifecycle-stage detach-managed-instance`
- [x] `os-management-hub managed-instance-group attach-managed-instances`
- [x] `os-management-hub managed-instance-group attach-software-sources`
- [x] `os-management-hub managed-instance-group detach-managed-instances`
- [x] `os-management-hub managed-instance-group detach-software-sources`
- [x] `os-management-hub managed-instance-group remove-module-profile`
- [x] `os-management-hub managed-instance-group remove-packages`
- [x] `os-management-hub profile attach-lifecycle-stage`
- [x] `os-management-hub profile attach-managed-instance-group`
- [ ] `rover node add-workload`
- [ ] `rover standalone-cluster add-workload`
- [ ] `rover station-cluster add-workload`
- [ ] `support incident put-attachment`

</details>

### 3/5 — Resource updates

<details>
<summary>230 commands</summary>

- [x] `analytics analytics-instance update-vanity-url`
- [x] `apm-synthetics dedicated-vantage-point update-with-oracle-rm-stack`
- [x] `apm-synthetics monitor update-browser-monitor`
- [x] `apm-synthetics monitor update-dns-sec-monitor`
- [x] `apm-synthetics monitor update-dns-server-monitor`
- [x] `apm-synthetics monitor update-dns-trace-monitor`
- [x] `apm-synthetics monitor update-ftp-monitor`
- [x] `apm-synthetics monitor update-network-monitor`
- [x] `apm-synthetics monitor update-rest-monitor`
- [x] `apm-synthetics monitor update-scripted-browser-monitor`
- [x] `apm-synthetics monitor update-scripted-rest-monitor`
- [ ] `apm-synthetics monitor update-sql-monitor`
- [x] `apm-traces attributes update-attribute`
- [x] `apm-traces attributes update-auto-activate`
- [x] `apm-traces attributes update-notes`
- [x] `apm-traces scheduled-query update`
- [x] `artifacts container repository update`
- [x] `artifacts generic artifact update-by-path`
- [x] `audit config update`
- [ ] `autoscaling policy update`
- [x] `bastion bastion update`
- [x] `capacity-management demand-signal occm-demand-signal-item update`
- [x] `ccc infrastructure update`
- [x] `ccc upgrade-schedule update`
- [x] `ce node-pool update`
- [x] `certs-mgmt certificate update`
- [x] `certs-mgmt certificate-authority update-root-ca-by-generating-config-details`
- [x] `certs-mgmt certificate-authority update-root-ca-managed-externally`
- [x] `certs-mgmt certificate-authority update-subordinate-ca-issued-by-internal-ca`
- [x] `certs-mgmt certificate-authority update-subordinate-ca-managed-internally-issued-by-external-ca`
- [ ] `cloud-bridge discovery asset-source update`
- [ ] `cloud-bridge inventory asset update`
- [ ] `cloud-guard data-mask-rule update`
- [ ] `cloud-guard data-mask-rule update-for-all-targets`
- [ ] `cloud-guard data-mask-rule update-for-services`
- [ ] `cloud-guard data-mask-rule update-for-targets`
- [ ] `cloud-migrations target-asset update`
- [x] `compute capacity-topology update`
- [x] `compute image-capability-schema update`
- [ ] `data-flow application update`
- [ ] `data-integration connection update`
- [ ] `data-integration data-asset update`
- [x] `data-integration schedule update`
- [x] `data-integration schedule update-custom-frequency`
- [x] `data-integration schedule update-daily-frequency`
- [x] `data-integration schedule update-hourly-frequency`
- [x] `data-integration schedule update-monthly-frequency`
- [x] `data-integration schedule update-monthly-rule-frequency`
- [x] `data-integration schedule update-weekly-frequency`
- [x] `data-integration task update-pipeline-task`
- [x] `data-integration task update-task-from-rest-task`
- [x] `data-integration task update-task-from-sql-task`
- [x] `data-safe private-endpoint update`
- [x] `data-safe registration-policy update`
- [x] `data-science ds-private-endpoint update`
- [x] `data-science job update`
- [x] `data-science ml-app update`
- [x] `data-science ml-app-implementation update`
- [x] `data-science ml-app-implementation-version update`
- [x] `data-science ml-app-instance update`
- [x] `data-science ml-app-instance-view update`
- [x] `data-science notebook-session update`
- [x] `database-management job update-result-location`
- [x] `database-management private-endpoint update`
- [x] `datacc infrastructure update`
- [x] `db autonomous-database update`
- [x] `db backup update`
- [x] `db cloud-exa-infra update`
- [ ] `db cloud-vm-cluster update`
- [ ] `db data-guard-association update`
- [ ] `db database update`
- [x] `db exadb-vm-cluster update`
- [ ] `db exascale-db-storage-vault update`
- [x] `db external-cdb update`
- [x] `db external-db-connector update`
- [x] `db external-db-connector update-macs-connector`
- [x] `db external-non-cdb update`
- [x] `db external-pdb update`
- [x] `db key-store update-oracle-key-vault-details`
- [ ] `db system update`
- [ ] `db vm-cluster update`
- [x] `dbtools connection update-generic-jdbc`
- [x] `dbtools connection update-mysql-database`
- [x] `dbtools connection update-oracle-database`
- [x] `dbtools connection update-postgresql`
- [x] `dbtools identity update-oracle-database-resource-principal`
- [x] `dbtools private-endpoint update`
- [x] `devops build-pipeline-stage update-build-stage`
- [x] `devops build-pipeline-stage update-deliver-artifact-stage`
- [x] `devops build-pipeline-stage update-trigger-deployment-stage`
- [x] `devops build-pipeline-stage update-wait-stage`
- [x] `devops connection update-bitbucket-cloud-connection`
- [x] `devops connection update-bitbucket-server-connection`
- [x] `devops connection update-github-connection`
- [x] `devops connection update-gitlab-connection`
- [x] `devops connection update-gitlab-server-connection`
- [x] `devops deploy-artifact update`
- [x] `devops deploy-artifact update-generic-artifact`
- [x] `devops deploy-artifact update-helm-command-spec`
- [x] `devops deploy-artifact update-helm-repository-artifact`
- [x] `devops deploy-artifact update-inline-artifact`
- [x] `devops deploy-artifact update-ocir-artifact`
- [x] `devops deploy-environment update`
- [x] `devops deploy-environment update-compute-instance-environment`
- [x] `devops deploy-environment update-function-environment`
- [x] `devops deploy-environment update-oke-cluster-environment`
- [x] `devops deploy-pipeline update`
- [x] `devops deploy-stage update`
- [x] `devops deploy-stage update-compute-instance-group-blue-green-traffic-shift-stage`
- [x] `devops deploy-stage update-compute-instance-group-canary-approval-stage`
- [x] `devops deploy-stage update-compute-instance-group-canary-traffic-shift-stage`
- [x] `devops deploy-stage update-deploy-compute-instance-group-blue-green-stage`
- [x] `devops deploy-stage update-deploy-compute-instance-group-canary-stage`
- [x] `devops deploy-stage update-deploy-compute-instance-group-stage`
- [x] `devops deploy-stage update-deploy-function-stage`
- [x] `devops deploy-stage update-deploy-oke-blue-green-stage`
- [x] `devops deploy-stage update-deploy-oke-canary-stage`
- [x] `devops deploy-stage update-deploy-oke-stage`
- [x] `devops deploy-stage update-invoke-function-stage`
- [x] `devops deploy-stage update-load-balancer-traffic-shift-stage`
- [x] `devops deploy-stage update-manual-approval-stage`
- [x] `devops deploy-stage update-oke-blue-green-traffic-shift-stage`
- [x] `devops deploy-stage update-oke-canary-approval-stage`
- [x] `devops deploy-stage update-oke-canary-traffic-shift-stage`
- [x] `devops deploy-stage update-oke-helm-chart-stage`
- [x] `devops deploy-stage update-shell-stage`
- [x] `devops deploy-stage update-wait-stage`
- [x] `devops deployment update`
- [x] `dif stack update`
- [x] `email email-ip-pool update`
- [x] `fleet-software-update fsu-cycle update-image-id-target`
- [x] `fleet-software-update fsu-cycle update-patch`
- [x] `fleet-software-update fsu-cycle update-version-target`
- [x] `fusion-apps fusion-environment update`
- [x] `gdp pipeline update`
- [x] `generative-ai imported-model update`
- [x] `goldengate connection update-amazon-kinesis-connection`
- [x] `goldengate connection update-amazon-s3-connection`
- [x] `goldengate connection update-azure-data-lake-storage-connection`
- [x] `goldengate connection update-google-big-query-connection`
- [x] `goldengate connection update-google-cloud-storage-connection`
- [x] `goldengate connection update-microsoft-fabric-connection`
- [x] `goldengate connection update-object-storage-connection`
- [x] `goldengate connection update-oracle-ai-data-platform-connection`
- [x] `goldengate connection update-oracle-nosql-connection`
- [x] `goldengate deployment update`
- [ ] `iam policy update`
- [x] `iam tag update`
- [ ] `iam tag-namespace update`
- [x] `integration integration-instance update`
- [ ] `iot digital-twin-instance update`
- [x] `jms fleet-agent-configuration update`
- [x] `lb backend-set update`
- [x] `lb listener update`
- [x] `lb nsg update`
- [x] `limits-increase limits-increase-request update`
- [x] `log-analytics em-bridge update`
- [x] `log-analytics entity update`
- [x] `log-analytics entity-type update`
- [x] `log-analytics log-group update`
- [ ] `log-analytics lookup update-data`
- [x] `log-analytics object-collection-rule update`
- [x] `logging agent-configuration update`
- [x] `logging agent-configuration update-log-configuration`
- [x] `logging log-saved-search update`
- [x] `management-agent agent update`
- [x] `management-agent agent update-prometheus-datasource`
- [x] `management-agent install-key update`
- [x] `monitoring alarm update`
- [ ] `mysql channel update-from-mysql`
- [x] `mysql db-system update`
- [x] `network drg-route-distribution update`
- [x] `network drg-route-distribution-statement update`
- [x] `network drg-route-table update`
- [x] `network nsg rules update`
- [x] `network nsg update`
- [x] `network private-ip update`
- [ ] `network-firewall application update`
- [ ] `network-firewall decryption-profile update`
- [x] `network-firewall mapped-secret update`
- [x] `network-firewall nat-rule update`
- [ ] `network-firewall service update`
- [x] `network-firewall tunnel-inspection-rule update`
- [x] `nosql row update`
- [x] `ocvs esxi-host update`
- [x] `ocvs sddc update`
- [x] `opsi database-insights update-autonomous-db`
- [x] `opsi database-insights update-em-external-db`
- [x] `opsi database-insights update-macs-external-db`
- [x] `opsi host-insights update-em-external-host`
- [x] `opsi host-insights update-macs-external-host`
- [x] `opsi opsi-private-endpoint update`
- [ ] `os retention-rule update`
- [x] `os-management-hub dynamic-set update-packages`
- [x] `os-management-hub lifecycle-environment update`
- [x] `os-management-hub managed-instance update`
- [x] `os-management-hub managed-instance update-packages`
- [x] `os-management-hub managed-instance-group update`
- [x] `os-management-hub managed-instance-group update-all-packages`
- [x] `os-management-hub management-station update`
- [x] `os-management-hub software-source update-custom-swsrc`
- [x] `os-management-hub update-all-packages-in-compartment`
- [x] `queue queue-admin consumer-group update`
- [x] `queue queue-admin queue update`
- [ ] `resource-manager stack update`
- [x] `resource-manager template update`
- [ ] `rover device data-sync task-definition update`
- [ ] `rover node update`
- [ ] `rover standalone-cluster update`
- [ ] `rover station-cluster update`
- [x] `stack-monitoring baselineable-metric update`
- [x] `stack-monitoring config update-onboard-config`
- [x] `stack-monitoring metric-extension update`
- [x] `stack-monitoring metric-extension update-http-metric-ext`
- [x] `stack-monitoring metric-extension update-jmx-metric-ext`
- [x] `stack-monitoring metric-extension update-os-cmd-metric-ext`
- [x] `stack-monitoring metric-extension update-sql-metric-ext`
- [x] `stack-monitoring monitoring-template update`
- [x] `stack-monitoring resource update`
- [x] `stack-monitoring resource-task update`
- [x] `stack-monitoring resource-task update-agent-receiver`
- [x] `stack-monitoring resource-task update-resource-type-configs`
- [x] `stack-monitoring resource-type update`
- [x] `stack-monitoring resource-type update-system-format-resource-type`
- [x] `support incident update`
- [x] `vbstudio instance update`
- [x] `visual-builder vb-instance update`
- [x] `waas certificate update-address-list`
- [x] `waas custom-protection-rule update-setting`
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
- [x] `certs-mgmt certificate create-certificate-issued-by-internal-ca`
- [x] `certs-mgmt certificate create-certificate-managed-externally-issued-by-internal-ca`
- [x] `certs-mgmt certificate update-certificate-by-importing-config-details`
- [x] `certs-mgmt certificate update-certificate-managed-externally`
- [x] `certs-mgmt certificate update-certificate-managed-internally`
- [x] `database-management managed-database cfg-auto-capture-filters-with-password`
- [x] `database-management managed-database cfg-auto-capture-filters-with-secret`
- [x] `database-management managed-database cfg-auto-spm-evolve-task-with-password`
- [x] `database-management managed-database cfg-auto-spm-evolve-task-with-secret`
- [x] `database-management managed-database change-plan-retention-with-password`
- [x] `database-management managed-database change-plan-retention-with-secret`
- [x] `database-management managed-database change-space-budget-with-password`
- [x] `database-management managed-database change-space-budget-with-secret`
- [x] `database-management managed-database change-spb-attr-with-password`
- [x] `database-management managed-database change-spb-attr-with-secret`
- [x] `database-management managed-database disable-auto-plan-capture-with-password`
- [x] `database-management managed-database disable-auto-plan-capture-with-secret`
- [x] `database-management managed-database disable-auto-spm-evolve-task-with-password`
- [x] `database-management managed-database disable-auto-spm-evolve-task-with-secret`
- [x] `database-management managed-database disable-hf-auto-spm-evolve-task-with-password`
- [x] `database-management managed-database disable-hf-auto-spm-evolve-task-with-secret`
- [x] `database-management managed-database disable-spb-usage-with-password`
- [x] `database-management managed-database disable-spb-usage-with-secret`
- [x] `database-management managed-database drop-sql-plan-baselines-with-password`
- [x] `database-management managed-database drop-sql-plan-baselines-with-secret`
- [x] `database-management managed-database enable-auto-plan-capture-with-password`
- [x] `database-management managed-database enable-auto-plan-capture-with-secret`
- [x] `database-management managed-database enable-auto-spm-evolve-task-with-password`
- [x] `database-management managed-database enable-auto-spm-evolve-task-with-secret`
- [x] `database-management managed-database enable-hf-auto-spm-evolve-task-with-password`
- [x] `database-management managed-database enable-hf-auto-spm-evolve-task-with-secret`
- [x] `database-management managed-database enable-spb-usage-with-password`
- [x] `database-management managed-database enable-spb-usage-with-secret`
- [x] `database-management managed-database load-spb-from-awr-with-password`
- [x] `database-management managed-database load-spb-from-awr-with-secret`
- [x] `database-management managed-database load-spb-from-cc-with-password`
- [x] `database-management managed-database load-spb-from-cc-with-secret`
- [x] `database-management tablespace drop-with-secret`
- [x] `database-management tablespace remove-datafile-with-secret`
- [x] `dbtools identity refresh-oracle-database-resource-principal-credential`
- [x] `dbtools identity validate-oracle-database-resource-principal-credential`
- [ ] `media-services media-stream stream-distribution-channel generate-session-token`
- [x] `opsi database-insights change-autonomous-database-insight-advanced-features-credential-by-vault`
- [x] `opsi database-insights change-macs-managed-autonomous-database-insight-connection-credential-by-named-credentials`
- [x] `opsi database-insights change-macs-managed-cloud-database-insight-connection-credential-by-vault`
- [x] `opsi database-insights enable-autonomous-database-insight-advanced-features-credential-by-vault`
- [x] `opsi database-insights test-macs-managed-autonomous-database-insight-connection-credential-by-named-credentials`
- [x] `opsi database-insights test-macs-managed-cloud-database-insight-connection-credential-by-vault`
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

- [x] `apm-traces attributes activate`
- [x] `apm-traces attributes deactivate`
- [x] `certs-mgmt certificate-authority-version cancel-deletion`
- [x] `certs-mgmt certificate-authority-version schedule-deletion`
- [x] `certs-mgmt certificate-version cancel-deletion`
- [x] `certs-mgmt certificate-version schedule-deletion`
- [x] `compute instance launch`
- [x] `data-science ml-app-instance-view disable-trigger`
- [x] `data-science ml-app-instance-view enable-trigger`
- [x] `db database enable-database-management`
- [x] `db external-cdb disable-db-management`
- [x] `db external-cdb enable-db-management`
- [x] `db external-non-cdb disable-db-management`
- [x] `db external-non-cdb disable-operations-insights`
- [x] `db external-non-cdb enable-db-management`
- [x] `db external-non-cdb enable-operations-insights`
- [x] `db external-pdb disable-db-management`
- [x] `db external-pdb disable-operations-insights`
- [x] `db external-pdb enable-db-management`
- [x] `db external-pdb enable-operations-insights`
- [x] `db node start`
- [x] `db node stop`
- [x] `db pluggable-database enable-pluggable-database-management`
- [ ] `db system launch`
- [ ] `db system launch-from-database`
- [ ] `db system launch-from-db-system`
- [ ] `generative-ai-data enrichment-jobs cancel`
- [x] `instance-agent command cancel`
- [x] `integration integration-instance start`
- [x] `integration integration-instance stop`
- [ ] `kms management key-version cancel-deletion`
- [ ] `kms management key-version schedule-deletion`
- [x] `limits-increase item cancel`
- [x] `limits-increase limits-increase-request cancel`
- [ ] `mysql db-system start`
- [ ] `mysql db-system stop`
- [x] `opsi database-insights enable-em-external-db`
- [x] `opsi host-insights enable-em-external-host`
- [x] `opsi host-insights enable-macs-external-host`
- [x] `os-management-hub lifecycle-stage reboot`
- [x] `os-management-hub managed-instance-group reboot`
- [ ] `rover device data-sync task cancel`
- [ ] `rover device data-sync task start`
- [ ] `rover device diagnostics bundle cancel`
- [x] `stack-monitoring metric-extension disable`
- [x] `stack-monitoring metric-extension enable`
- [x] `stack-monitoring resource disable-external-database`
- [x] `visual-builder vb-instance start`
- [x] `visual-builder vb-instance stop`

</details>

### 4/5 — Other service-specific actions

<details>
<summary>52 commands</summary>

- [x] `apm-traces attributes pin`
- [x] `apm-traces attributes unpin`
- [x] `apm-traces query query-response run-query`
- [x] `bds instance install-patch`
- [x] `bds instance install-patch-domain-based-odh-patching-config`
- [x] `bds instance install-patch-downtime-based-odh-patching-config`
- [ ] `bv backup copy`
- [ ] `bv boot-volume-backup copy`
- [x] `certs-mgmt certificate-authority-version revoke`
- [x] `certs-mgmt certificate-version revoke`
- [x] `data-catalog search query`
- [ ] `data-flow run submit`
- [ ] `dbtools-runtime connection execute-sql async`
- [ ] `dbtools-runtime connection execute-sql sync`
- [x] `dif stack deploy-artifacts`
- [x] `generative-ai-data enrichment-jobs generate`
- [x] `generative-ai-data enrichment-jobs generate-delta-refresh`
- [x] `generative-ai-data enrichment-jobs generate-full-build`
- [x] `generative-ai-data enrichment-jobs generate-partial-build`
- [x] `generative-ai-data generate-sql-jobs generate`
- [ ] `generative-ai-sandbox sandbox-file read`
- [ ] `generative-ai-sandbox sandbox-file write`
- [ ] `iam tag reactivate`
- [ ] `iam tag retire`
- [ ] `iam tag-namespace reactivate`
- [ ] `iam tag-namespace retire`
- [x] `integration integration-instance change-network-endpoint`
- [ ] `log-analytics lookup append-data`
- [ ] `log-analytics lookup register-lookup`
- [x] `log-analytics parser extract-structured-log-field-paths`
- [x] `log-analytics parser extract-structured-log-header-paths`
- [x] `log-analytics parser test-parser`
- [x] `log-analytics parser upsert-parser`
- [x] `log-analytics source upsert-source`
- [x] `log-analytics source validate-source`
- [x] `log-analytics source validate-source-extfield-details`
- [x] `log-analytics storage recall-archived-data`
- [ ] `model-deployment inference-result predict`
- [ ] `network remote-peering-connection connect`
- [x] `ocvs esxi-host replace-host`
- [x] `ocvs sddc vmware-versions`
- [x] `optimizer resource-action-summary filter-resource-actions`
- [ ] `os multipart abort`
- [ ] `os object copy`
- [ ] `os object reencrypt`
- [ ] `raw-request `
- [ ] `resource-manager stack copy`
- [x] `search resource structured-search`
- [x] `stack-monitoring baselineable-metric evaluate`
- [x] `stack-monitoring metric-extension publish`
- [x] `stack-monitoring metric-extension test`
- [x] `stack-monitoring resource manage-license`

</details>

### 4/5 — Resource creation and variants

<details>
<summary>245 commands</summary>

- [ ] `adm vulnerability-audit create`
- [ ] `adm vulnerability-audit create-vulnerability-audit-external-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-oci-resource-vulnerability-audit-source`
- [ ] `adm vulnerability-audit create-vulnerability-audit-unknown-source-vulnerability-audit-source`
- [x] `analytics analytics-instance create`
- [x] `analytics analytics-instance create-vanity-url`
- [x] `api-gateway certificate create`
- [x] `apm-synthetics dedicated-vantage-point create-with-oracle-rm-stack`
- [x] `apm-synthetics monitor create-browser-monitor`
- [x] `apm-synthetics monitor create-dns-sec-monitor`
- [x] `apm-synthetics monitor create-dns-server-monitor`
- [x] `apm-synthetics monitor create-dns-trace-monitor`
- [x] `apm-synthetics monitor create-ftp-monitor`
- [x] `apm-synthetics monitor create-network-monitor`
- [x] `apm-synthetics monitor create-rest-monitor`
- [x] `apm-synthetics monitor create-scripted-browser-monitor`
- [x] `apm-synthetics monitor create-scripted-rest-monitor`
- [ ] `apm-synthetics monitor create-sql-monitor`
- [x] `apm-synthetics worker create`
- [x] `apm-traces scheduled-query create`
- [ ] `autoscaling policy create`
- [x] `bastion bastion create`
- [x] `bastion session create`
- [x] `bastion session create-managed-ssh`
- [x] `bastion session create-port-forwarding`
- [x] `batch batch-context create-oci-logging-configuration`
- [ ] `bv boot-volume create`
- [ ] `bv volume create`
- [x] `capacity-management demand-signal occm-demand-signal-item create`
- [x] `capacity-management occ-capacity-request create`
- [x] `ccc infrastructure create`
- [x] `ce cluster create`
- [ ] `ce cluster create-kubeconfig`
- [x] `ce node-pool create`
- [x] `certs-mgmt certificate create-by-importing-config`
- [x] `certs-mgmt certificate-authority create-root-ca-by-generating-config-details`
- [x] `certs-mgmt certificate-authority create-root-ca-managed-externally`
- [x] `certs-mgmt certificate-authority create-subordinate-ca-issued-by-internal-ca`
- [x] `certs-mgmt certificate-authority create-subordinate-ca-managed-internally-issued-by-external-ca`
- [ ] `cloud-bridge discovery asset-source create`
- [ ] `cloud-bridge inventory asset create`
- [ ] `cloud-guard data-mask-rule create`
- [ ] `cloud-guard data-mask-rule create-for-all-targets`
- [ ] `cloud-guard data-mask-rule create-for-services`
- [ ] `cloud-guard data-mask-rule create-for-targets`
- [ ] `cloud-migrations target-asset create`
- [x] `compute image-capability-schema create`
- [x] `compute instance-console-connection create`
- [x] `compute pic subscription create`
- [x] `cpg cluster-placement-group create`
- [ ] `data-flow application create`
- [ ] `data-flow run create`
- [ ] `data-integration connection create`
- [ ] `data-integration data-asset create`
- [x] `data-integration schedule create`
- [x] `data-integration schedule create-custom-frequency`
- [x] `data-integration schedule create-daily-frequency`
- [x] `data-integration schedule create-hourly-frequency`
- [x] `data-integration schedule create-monthly-frequency`
- [x] `data-integration schedule create-monthly-rule-frequency`
- [x] `data-integration schedule create-weekly-frequency`
- [x] `data-integration task create-pipeline-task`
- [x] `data-integration task create-task-from-rest-task`
- [x] `data-integration task create-task-from-sql-task`
- [x] `data-integration task-validation create-from-pipeline-task`
- [x] `data-integration workspace create`
- [x] `data-safe registration-policy create`
- [x] `data-science ds-private-endpoint create`
- [x] `data-science job create`
- [ ] `data-science job create-job-artifact`
- [x] `data-science job-run create`
- [x] `data-science ml-app-implementation create`
- [x] `data-science ml-app-instance create`
- [x] `data-science ml-app-instance create-with-iam-auth`
- [ ] `data-science model create-model-artifact`
- [x] `data-science notebook-session create`
- [ ] `data-science pipeline create-step-artifact`
- [ ] `database-migration connection create-oracle-connection`
- [x] `datacc infrastructure create`
- [x] `db autonomous-database create`
- [x] `db autonomous-database create-adb-cross-region-data-guard-details`
- [x] `db backup create`
- [x] `db cloud-vm-cluster create`
- [ ] `db database create`
- [ ] `db database create-database-from-database`
- [ ] `db database create-from-database`
- [ ] `db database create-standby-database`
- [ ] `db db-home create`
- [x] `db exadb-vm-cluster create`
- [ ] `db exascale-db-storage-vault create`
- [x] `db external-pdb create`
- [x] `db key-store create-oracle-key-vault-details`
- [x] `db pluggable-database create`
- [x] `db vm-cluster create`
- [x] `dbtools connection create-generic-jdbc`
- [x] `dbtools connection create-mysql-database`
- [x] `dbtools connection create-oracle-database`
- [x] `dbtools connection create-postgresql`
- [x] `dbtools identity create-oracle-database-resource-principal`
- [x] `devops build-pipeline-stage create-build-stage`
- [x] `devops build-pipeline-stage create-deliver-artifact-stage`
- [x] `devops build-pipeline-stage create-trigger-deployment-stage`
- [x] `devops build-pipeline-stage create-wait-stage`
- [x] `devops connection create-bitbucket-cloud-connection`
- [x] `devops connection create-bitbucket-server-connection`
- [x] `devops connection create-github-connection`
- [x] `devops connection create-gitlab-connection`
- [x] `devops connection create-gitlab-server-connection`
- [x] `devops deploy-artifact create-generic-artifact`
- [x] `devops deploy-artifact create-helm-command-spec`
- [x] `devops deploy-artifact create-helm-repository-artifact`
- [x] `devops deploy-artifact create-inline-artifact`
- [x] `devops deploy-artifact create-ocir-artifact`
- [x] `devops deploy-pipeline create`
- [x] `devops deploy-stage create-compute-instance-group-blue-green-traffic-shift-stage`
- [x] `devops deploy-stage create-compute-instance-group-canary-approval-stage`
- [x] `devops deploy-stage create-compute-instance-group-canary-traffic-shift-stage`
- [x] `devops deploy-stage create-deploy-compute-instance-group-blue-green-stage`
- [x] `devops deploy-stage create-deploy-compute-instance-group-canary-stage`
- [x] `devops deploy-stage create-deploy-compute-instance-group-stage`
- [x] `devops deploy-stage create-deploy-function-stage`
- [x] `devops deploy-stage create-deploy-oke-blue-green-stage`
- [x] `devops deploy-stage create-deploy-oke-canary-stage`
- [x] `devops deploy-stage create-deploy-oke-stage`
- [x] `devops deploy-stage create-invoke-function-stage`
- [x] `devops deploy-stage create-load-balancer-traffic-shift-stage`
- [x] `devops deploy-stage create-manual-approval-stage`
- [x] `devops deploy-stage create-oke-blue-green-traffic-shift-stage`
- [x] `devops deploy-stage create-oke-canary-approval-stage`
- [x] `devops deploy-stage create-oke-canary-traffic-shift-stage`
- [x] `devops deploy-stage create-oke-helm-chart-stage`
- [x] `devops deploy-stage create-shell-stage`
- [x] `devops deploy-stage create-wait-stage`
- [x] `devops deployment create-pipeline-deployment`
- [x] `devops deployment create-pipeline-redeployment`
- [x] `devops deployment create-single-stage-deployment`
- [x] `devops deployment create-single-stage-redeployment`
- [x] `dif stack create`
- [x] `disaster-recovery dr-plan-execution create-start-drill`
- [x] `disaster-recovery dr-plan-execution create-start-drill-precheck`
- [x] `disaster-recovery dr-plan-execution create-stop-drill`
- [x] `disaster-recovery dr-plan-execution create-stop-drill-precheck`
- [x] `dns zone create`
- [x] `email email-ip-pool create`
- [x] `fleet-software-update fsu-cycle create-patch`
- [x] `fusion-apps fusion-environment create`
- [x] `gdp pipeline create`
- [x] `generative-ai imported-model create-from-huggingface`
- [x] `generative-ai imported-model create-from-objectstorage`
- [x] `goldengate connection create-amazon-kinesis-connection`
- [x] `goldengate connection create-amazon-s3-connection`
- [x] `goldengate connection create-azure-data-lake-storage-connection`
- [x] `goldengate connection create-google-big-query-connection`
- [x] `goldengate connection create-google-cloud-storage-connection`
- [x] `goldengate connection create-microsoft-fabric-connection`
- [x] `goldengate connection create-object-storage-connection`
- [x] `goldengate connection create-oracle-ai-data-platform-connection`
- [x] `goldengate connection create-oracle-nosql-connection`
- [x] `goldengate deployment create`
- [x] `goldengate pipeline create-zero-etl-pipeline`
- [ ] `iam compartment create`
- [x] `identity-domains api-key create`
- [x] `identity-domains app create`
- [x] `identity-domains auth-token create`
- [x] `identity-domains customer-secret-key create`
- [x] `identity-domains dynamic-resource-group create`
- [x] `identity-domains group create`
- [x] `identity-domains identity-provider create`
- [x] `identity-domains me create`
- [x] `identity-domains o-auth2-client-credential create`
- [x] `identity-domains smtp-credential create`
- [x] `identity-domains user create`
- [x] `identity-domains user-db-credential create`
- [x] `instance-agent command create`
- [x] `integration integration-instance create`
- [ ] `kms management key-version create`
- [x] `lb backend-set create`
- [x] `lb certificate create`
- [x] `lb listener create`
- [x] `lb load-balancer create`
- [x] `limits-increase limits-increase-request create`
- [x] `log-analytics entity create`
- [x] `logging agent-configuration create-log-configuration`
- [x] `logging log-saved-search create`
- [x] `management-agent agent create-prometheus-datasource`
- [x] `monitoring alarm create`
- [x] `mysql channel create-from-mysql`
- [x] `mysql db-system create`
- [x] `network drg-route-table create`
- [x] `network virtual-circuit create`
- [x] `network-firewall application create`
- [ ] `network-firewall decryption-profile create`
- [x] `network-firewall mapped-secret create`
- [x] `network-firewall nat-rule create`
- [ ] `network-firewall service create`
- [x] `network-firewall tunnel-inspection-rule create`
- [x] `nosql index create`
- [x] `nosql table create-replica`
- [x] `ocvs esxi-host create`
- [x] `ocvs sddc create`
- [x] `oma lockbox create`
- [x] `ons subscription create`
- [x] `opsi database-insights create-em-external-db`
- [x] `opsi exadata-insights create-em-external-exadata`
- [x] `opsi host-insights create-em-external-host`
- [x] `opsi host-insights create-macs-external-host`
- [x] `os replication create-replication-policy`
- [x] `os retention-rule create`
- [x] `os-management-hub management-station create`
- [x] `os-management-hub profile create-group-profile`
- [x] `os-management-hub profile create-lifecycle-profile`
- [x] `os-management-hub scheduled-job create`
- [x] `os-management-hub software-source create-custom-swsrc`
- [x] `os-management-hub software-source create-versioned-custom-swsrc`
- [x] `pss instance create`
- [x] `queue queue-admin consumer-group create`
- [x] `queue queue-admin queue create`
- [x] `resource-manager job create-apply-job`
- [x] `resource-manager job create-apply-rollback-job`
- [x] `resource-manager job create-destroy-job`
- [ ] `resource-manager job create-import-tf-state-job`
- [x] `resource-manager job create-plan-job`
- [ ] `resource-manager job create-plan-rollback-job`
- [ ] `resource-manager stack create`
- [x] `resource-manager stack create-from-template`
- [x] `resource-manager template create`
- [ ] `rover create-master-key-policy`
- [ ] `rover device data-sync task-definition create`
- [ ] `rover device diagnostics bundle create`
- [ ] `rover node create`
- [ ] `rover standalone-cluster create`
- [ ] `rover station-cluster create`
- [x] `stack-monitoring baselineable-metric create`
- [x] `stack-monitoring config create-onboard-config`
- [x] `stack-monitoring metric-extension create`
- [x] `stack-monitoring metric-extension create-http-metric-ext`
- [x] `stack-monitoring metric-extension create-jmx-metric-ext`
- [x] `stack-monitoring metric-extension create-os-cmd-metric-ext`
- [x] `stack-monitoring metric-extension create-sql-metric-ext`
- [x] `stack-monitoring monitoring-template create`
- [x] `stack-monitoring resource create`
- [x] `stack-monitoring resource-type create-system-format-resource-type`
- [x] `support incident create`
- [x] `vault secret create-base64`
- [x] `vbstudio instance create`

</details>

### 4/5 — Specialized database operations

<details>
<summary>34 commands</summary>

- [x] `data-safe target-database manage-privileges`
- [x] `database-management tablespace drop-with-pwd`
- [x] `db autonomous-database-wallet rotate`
- [x] `db cloud-exa-infra configure-exascale`
- [ ] `db data-guard-association create from-existing-db-system`
- [ ] `db data-guard-association create from-existing-vm-cluster`
- [ ] `db data-guard-association create with-new-db-system`
- [ ] `db data-guard-association reinstate`
- [x] `db database convert-to-new-pdb`
- [x] `db database convert-to-new-pdb-precheck`
- [x] `db database convert-to-pdb-sync`
- [x] `db database convert-to-pdb-sync-rollback`
- [x] `db database modify-database-management`
- [x] `db external-cdb scan-pluggable-databases`
- [x] `db external-db-connector check-connection-status`
- [x] `db node force-reset`
- [x] `db node force-stop`
- [x] `db node reset`
- [x] `db node soft-reset`
- [ ] `db patch get by-database`
- [ ] `db patch list by-database`
- [ ] `db patch-history get by-database`
- [ ] `db patch-history list by-database`
- [x] `db pluggable-database convert-to-regular`
- [x] `db pluggable-database modify-pluggable-database-management`
- [x] `db pluggable-database refresh`
- [x] `db pluggable-database relocate-pdb`
- [x] `dbtools connection validate-mysql-database`
- [x] `dbtools connection validate-oracle-database`
- [x] `dbtools connection validate-postgresql`
- [x] `opsi opsi-data-objects query-data-standard-query`
- [x] `opsi opsi-data-objects query-data-templatized-query`
- [x] `opsi opsi-warehouse-data-objects query-warehouse-data-standard-query`
- [x] `opsi opsi-warehouse-data-objects query-warehouse-data-templatized-query`

</details>

### 4/5 — Specialized development and data operations

<details>
<summary>17 commands</summary>

- [x] `data-integration task-run-lineage list_taskrun_lineages`
- [ ] `data-science job head-job-artifact`
- [x] `data-science ml-app-instance trigger`
- [x] `data-science ml-app-instance-view trigger`
- [ ] `data-science model head-model-artifact`
- [ ] `data-science pipeline head-step-artifact`
- [x] `devops deployment approve`
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
- [x] `os-management-hub install-all-windows-updates-in-compartment`
- [x] `os-management-hub lifecycle-stage promote-software-source`
- [x] `os-management-hub managed-instance install-windows-updates`
- [x] `os-management-hub managed-instance-group install-module-profile`
- [x] `os-management-hub managed-instance-group install-packages`
- [x] `os-management-hub managed-instance-group install-windows-updates`
- [x] `os-management-hub managed-instance-group refresh-software`
- [x] `os-management-hub software-source change-availability`
- [ ] `rover device data-sync task-definition change-state`
- [ ] `rover node request-approval`
- [ ] `rover node setup-identity`
- [ ] `rover standalone-cluster request-approval`
- [ ] `rover station-cluster request-approval`

</details>

### 5/5 — Backup, recovery, and migration

<details>
<summary>35 commands</summary>

- [x] `artifacts container image restore`
- [x] `data-science ml-app-instance-view recover`
- [x] `db autonomous-database change-disaster-recovery-configuration`
- [x] `db autonomous-database create-from-backup-id`
- [x] `db autonomous-database create-from-backup-timestamp`
- [x] `db autonomous-database create-from-clone`
- [x] `db autonomous-database create-refreshable-clone`
- [ ] `db data-guard-association failover`
- [ ] `db data-guard-association switchover`
- [ ] `db database create-from-backup`
- [x] `db database restore`
- [x] `db database upgrade-rollback`
- [x] `db database upgrade-with-database-software-image`
- [x] `db database upgrade-with-db-home`
- [x] `db database upgrade-with-db-version`
- [x] `db pluggable-database create-local-clone`
- [x] `db pluggable-database create-remote-clone`
- [x] `db pluggable-database local-clone`
- [x] `db pluggable-database remote-clone`
- [ ] `db system launch-from-backup`
- [x] `db system upgrade`
- [x] `disaster-recovery dr-plan-execution create-failover`
- [x] `disaster-recovery dr-plan-execution create-failover-precheck`
- [x] `disaster-recovery dr-plan-execution create-switchover`
- [x] `disaster-recovery dr-plan-execution create-switchover-precheck`
- [x] `dns zone migrate-from-dynect`
- [ ] `kms management key backup`
- [ ] `kms management key restore`
- [ ] `kms management vault backup`
- [ ] `kms management vault restore`
- [x] `mysql db-system clone`
- [x] `ocvs esxi-host inplace-upgrade`
- [ ] `os object restore`
- [ ] `os object restore-status`
- [x] `psql db-system upgrade`

</details>

### 5/5 — Bulk and batch operations

<details>
<summary>17 commands</summary>

- [x] `bds instance install-patch-batching-based-odh-patching-config`
- [x] `fleet-software-update fsu-cycle update-fifty-batch`
- [x] `fleet-software-update fsu-cycle update-saf-batch`
- [x] `fleet-software-update fsu-cycle update-sequential-batch`
- [x] `network-firewall address-list bulk-upload`
- [x] `network-firewall application bulk-upload`
- [x] `network-firewall application-group bulk-upload`
- [x] `network-firewall decryption-profile bulk-upload`
- [x] `network-firewall decryption-rule bulk-upload`
- [x] `network-firewall mapped-secret bulk-upload`
- [x] `network-firewall nat-rule bulk-upload`
- [x] `network-firewall security-rule bulk-upload`
- [x] `network-firewall service bulk-upload`
- [x] `network-firewall service-list bulk-upload`
- [x] `network-firewall tunnel-inspection-rule bulk-upload`
- [x] `network-firewall url-list bulk-upload`
- [ ] `os object bulk-delete-versions`

</details>

### 5/5 — File transfers and streaming

<details>
<summary>29 commands</summary>

- [ ] `artifacts container image-signature sign-upload`
- [x] `artifacts generic artifact download-by-path`
- [ ] `artifacts generic artifact upload-by-path`
- [x] `data-science ml-app-implementation download-package`
- [ ] `data-science ml-app-implementation upload-package`
- [x] `data-science ml-app-implementation-version download-package`
- [ ] `generative-ai-sandbox sandbox-command stream`
- [ ] `generative-ai-sandbox sandbox-command-event stream`
- [x] `iam user api-key upload`
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
- [x] `mysql db-system import`
- [x] `os-management-hub managed-instance-group disable-module-stream`
- [x] `os-management-hub managed-instance-group enable-module-stream`
- [x] `os-management-hub managed-instance-group switch-module-stream`
- [x] `os-management-hub software-source list-module-streams`
- [ ] `rover device system-upgrade import-bundle`
- [ ] `rover device system-upgrade upload-bundle`
- [x] `service-catalog private-application-package download-config`
- [x] `stack-monitoring metric-extension export`
- [x] `stack-monitoring resource-task import-telemetry-resources`

</details>

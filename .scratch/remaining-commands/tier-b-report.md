# Tier B survey (ticket 10)

Generated from the spec after `bun run extract` (oci-cli 3.96.3). Tiers: **A 791, B 195, C 202** (1,188 Custom commands). The earlier "~234 Tier B" estimate predates tickets 07–09, which moved wrappers with constants, dropped options and helper renames into Tier A.

Every Tier B entry in `spec/<service>.json` now carries `patterns` (names below) and, when anything could be learned statically, `survey`:

- `invokes`: the generated callbacks it `ctx.invoke`s, in source order (deduplicated).
- `checks`: each `raise click.UsageError(msg)` with `when` = the conjunction of its enclosing `if` tests (an `else` branch is `not (<test>)`), the options read by those tests, and the exact `message`.
- `folds`: each flat option assembled into a complex param: `target` (the generated param), `path` (JSON keys inside it), `options` read by the value, `json: true` when the value goes through `cli_util.parse_json_parameter`, or a constant `value`.
- `files`: options read as a file (`click.File` params and options passed to `open()` / `.read()`).
- `helpers`: module helper functions the callback calls; their bodies are surveyed too (e.g. `lb`'s `process_health_checker_kwargs`).

`bun run spec <service> <command…>` prints all of it. Detector: `tools/extract/patterns.py` (AST only, nothing executed).

## Patterns

A command usually has several patterns. Counts are commands, not call sites.

| Pattern           | Commands | Examples                                                                                                                                            | Meaning / declarative data                                                                |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kwargs-del`      | 122      | `analytics analytics-instance create`, `data-science ml-app-instance-view trigger`, `kms management key restore-from-file`                          | `del kwargs[...]`: a rename or drop Tier A does not accept yet                            |
| `json-dumps`      | 59       | `analytics analytics-instance create`, `db exascale-db-storage-vault update`, `mysql channel create-from-mysql`                                     | `json.dumps` re-serializing a built dict or parsed param into a complex param (`folds`)   |
| `file-read`       | 45       | `analytics analytics-instance create`, `data-science ml-app-implementation-version download-package`, `lb certificate create`                       | option names a file: `click.File`, `open()`, `.read()` (`files`)                          |
| `fold-body`       | 43       | `analytics analytics-instance create`, `db exascale-db-storage-vault create`, `lb backend-set update`                                               | flat options assembled into a complex param (`folds`)                                     |
| `parse-json`      | 37       | `ce cluster create`, `lb listener update`, `network-firewall mapped-secret bulk-upload`                                                             | `cli_util.parse_json_parameter` on an option (`folds[].json`)                             |
| `blank-check`     | 35       | `data-science job create-job-artifact`, `data-science ml-app-implementation upload-package`, `data-science ml-app-instance-view change-compartment` | `Parameter --x cannot be whitespace or empty string`, naming the custom option (`checks`) |
| `usage-error`     | 33       | `autoscaling policy create`, `db system update`, `lb backend-set update`                                                                            | other `click.UsageError`: exclusive, required-together, conditional (`checks`)            |
| `helper`          | 19       | `apm-synthetics monitor create-sql-monitor`, `lb backend-set create`, `os object reencrypt`                                                         | logic in a module helper function (`helpers`; bodies surveyed)                            |
| `multi-invoke`    | 16       | `autoscaling policy create`, `data-integration data-asset update`, `log-analytics upload upload-otlp-logs`                                          | several `ctx.invoke` calls: variant selection or several requests (`invokes`)             |
| `raise-other`     | 16       | `data-flow application create`, `goldengate deployment create`, `network-firewall decryption-profile update`                                        | raises something else (`ValueError`, ...)                                                 |
| `output`          | 13       | `apm-synthetics monitor create-sql-monitor`, `network remote-peering-connection connect`, `rover node add-workload`                                 | prints or renders on its own (`click.echo`, `cli_util.render*`)                           |
| `direct-client`   | 13       | `bv boot-volume create`, `db patch list by-database`, `os bucket delete`                                                                            | `cli_util.build_client` + extra SDK calls (lookups before the invoke)                     |
| `base64`          | 7        | `apm-synthetics monitor create-sql-monitor`, `database-migration connection create-oracle-connection`, `os object reencrypt`                        | base64-encodes a value (usually file content)                                             |
| `invoke-not-last` | 4        | `fn function delete`, `generative-ai-sandbox sandbox-file read`, `kms management key restore-from-file`                                             | the invoke result is used, or work follows it                                             |
| `computed-value`  | 2        | `devops deploy-stage create-oke-helm-chart-stage`, `devops deploy-stage update-oke-helm-chart-stage`                                                | a kwarg computed by an expression (e.g. `not kwargs[...]`)                                |
| `wait`            | 1        | `os bucket delete`                                                                                                                                  | its own waiter / polling                                                                  |

Every Tier B command matched at least one pattern; none is untagged.

## Assignment to tickets

Each command goes to exactly one ticket, the first match in this order: own logic → 14 → 12 → 11 → 13 → 16. `kwargs-del` and `blank-check` are handled first (ticket 16) for every command, so later tickets can rely on them. `usage-error` checks are implemented once (ticket 13) and reused by 11/12/14 for their commands that have checks.

| Ticket            | Scope                                                                                                                        | Commands |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| 16 (new)          | only `kwargs-del` / `blank-check`: Tier A modulo `del` and a custom blank check                                              | 61       |
| 13                | `checks` engine (all 33 `usage-error` + 16 `raise-other` commands' error paths); fully owns the 3 commands with nothing else | 3        |
| 11                | `fold-body` / `parse-json` / `json-dumps` / `helper` / `computed-value`, no files, single invoke                             | 57       |
| 12                | `file-read` / `base64`, single invoke                                                                                        | 37       |
| 14                | `multi-invoke`                                                                                                               | 15       |
| 15 (hand-written) | own logic: `direct-client`, `output`, `wait`, `invoke-not-last`                                                              | 22       |

### 16: `del kwargs` and blank checks (61)

- `compute-management instance-pool lb-attachment get` [kwargs-del]
- `data-science job create` [kwargs-del]
- `data-science job update` [kwargs-del]
- `data-science job-run create` [kwargs-del]
- `data-science ml-app change-compartment` [kwargs-del blank-check]
- `data-science ml-app delete` [kwargs-del blank-check]
- `data-science ml-app get` [kwargs-del blank-check]
- `data-science ml-app list` [kwargs-del]
- `data-science ml-app update` [kwargs-del blank-check]
- `data-science ml-app-implementation change-compartment` [kwargs-del blank-check]
- `data-science ml-app-implementation create` [kwargs-del blank-check]
- `data-science ml-app-implementation delete` [kwargs-del blank-check]
- `data-science ml-app-implementation get` [kwargs-del blank-check]
- `data-science ml-app-implementation list` [kwargs-del]
- `data-science ml-app-implementation update` [kwargs-del blank-check]
- `data-science ml-app-implementation-version get` [kwargs-del blank-check]
- `data-science ml-app-implementation-version list` [kwargs-del]
- `data-science ml-app-implementation-version update` [kwargs-del blank-check]
- `data-science ml-app-instance change-compartment` [kwargs-del blank-check]
- `data-science ml-app-instance create` [kwargs-del blank-check]
- `data-science ml-app-instance create-with-iam-auth` [kwargs-del blank-check]
- `data-science ml-app-instance delete` [kwargs-del blank-check]
- `data-science ml-app-instance get` [kwargs-del blank-check]
- `data-science ml-app-instance list` [kwargs-del]
- `data-science ml-app-instance trigger` [kwargs-del blank-check]
- `data-science ml-app-instance update` [kwargs-del blank-check]
- `data-science ml-app-instance-view change-compartment` [kwargs-del blank-check]
- `data-science ml-app-instance-view disable-trigger` [kwargs-del blank-check]
- `data-science ml-app-instance-view enable-trigger` [kwargs-del blank-check]
- `data-science ml-app-instance-view get` [kwargs-del blank-check]
- `data-science ml-app-instance-view list` [kwargs-del]
- `data-science ml-app-instance-view recover` [kwargs-del blank-check]
- `data-science ml-app-instance-view trigger` [kwargs-del blank-check]
- `data-science ml-app-instance-view update` [kwargs-del blank-check]
- `data-science notebook-session create` [kwargs-del]
- `data-science notebook-session update` [kwargs-del]
- `db autonomous-database create` [kwargs-del]
- `db autonomous-database create-from-clone` [kwargs-del]
- `db autonomous-database update` [kwargs-del]
- `db autonomous-database-wallet get-metadata` [kwargs-del]
- `db autonomous-database-wallet rotate` [kwargs-del]
- `db database upgrade-with-database-software-image` [kwargs-del]
- `db database upgrade-with-db-home` [kwargs-del]
- `db database upgrade-with-db-version` [kwargs-del]
- `db db-system-upgrade-history get` [kwargs-del]
- `db pluggable-database create` [kwargs-del]
- `db pluggable-database local-clone` [kwargs-del]
- `db pluggable-database remote-clone` [kwargs-del]
- `db system upgrade` [kwargs-del]
- `db upgrade-history get` [kwargs-del]
- `instance-agent command cancel` [kwargs-del]
- `instance-agent command create` [kwargs-del]
- `instance-agent command get` [kwargs-del]
- `instance-agent command-execution get` [kwargs-del]
- `nosql index create` [kwargs-del]
- `nosql row update` [kwargs-del]
- `resource-manager job create-apply-job` [kwargs-del]
- `resource-manager job create-destroy-job` [kwargs-del]
- `resource-manager job create-plan-job` [kwargs-del]
- `rover node change-compartment` [blank-check]
- `rover node get-encryption-key` [blank-check]

### 13: usage checks only (3)

- `db backup list` [usage-error]
- `network public-ip get` [usage-error]
- `vault secret create-base64` [usage-error]

Commands with `usage-error` checks owned by other tickets: 30; with `raise-other`: 16 (see `bun run spec`).

### 11: options into a JSON body (57)

The 12 `network-firewall * bulk-upload` commands only parse and re-dump one param (identity apart from the parse error); `devops deploy-stage *-oke-helm-chart-stage` are the 2 `computed-value` ones; `data-flow` folds through a helper and raises `ValueError`.

- `ce cluster create` [usage-error fold-body parse-json]
- `ce node-pool create` [usage-error fold-body parse-json json-dumps]
- `ce node-pool update` [usage-error fold-body parse-json]
- `data-flow application create` [raise-other json-dumps helper]
- `data-flow application update` [raise-other json-dumps helper]
- `data-flow run create` [raise-other json-dumps helper]
- `data-flow run submit` [raise-other json-dumps helper]
- `db database enable-database-management` [fold-body json-dumps]
- `db database modify-database-management` [fold-body json-dumps]
- `db database update` [kwargs-del fold-body parse-json json-dumps]
- `db exascale-db-storage-vault create` [fold-body json-dumps]
- `db exascale-db-storage-vault update` [fold-body json-dumps]
- `db key-store create-oracle-key-vault-details` [kwargs-del parse-json]
- `db key-store update-oracle-key-vault-details` [kwargs-del parse-json]
- `db pluggable-database create-remote-clone` [fold-body json-dumps]
- `db pluggable-database enable-pluggable-database-management` [fold-body json-dumps]
- `db pluggable-database modify-pluggable-database-management` [fold-body json-dumps]
- `db system launch-from-database` [kwargs-del fold-body json-dumps]
- `db system launch-from-db-system` [kwargs-del fold-body json-dumps]
- `db vm-cluster update` [kwargs-del usage-error fold-body]
- `devops deploy-stage create-oke-helm-chart-stage` [computed-value]
- `devops deploy-stage update-oke-helm-chart-stage` [computed-value]
- `devops deployment create-pipeline-deployment` [parse-json json-dumps]
- `devops deployment create-single-stage-deployment` [parse-json json-dumps]
- `lb backend-set create` [usage-error fold-body parse-json json-dumps helper]
- `lb backend-set update` [usage-error fold-body parse-json json-dumps helper]
- `lb listener create` [usage-error fold-body parse-json json-dumps helper]
- `lb listener update` [usage-error fold-body parse-json json-dumps helper]
- `log-analytics query search` [fold-body json-dumps]
- `mysql channel create-from-mysql` [fold-body parse-json json-dumps]
- `mysql channel update-from-mysql` [fold-body parse-json json-dumps]
- `mysql db-system clone` [fold-body json-dumps]
- `mysql db-system create` [fold-body json-dumps]
- `mysql db-system import` [fold-body json-dumps]
- `mysql db-system update` [fold-body json-dumps]
- `network-firewall address-list bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall application bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall application-group bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall decryption-profile bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall decryption-rule bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall mapped-secret bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall mapped-secret create` [kwargs-del raise-other parse-json]
- `network-firewall mapped-secret update` [kwargs-del raise-other parse-json]
- `network-firewall nat-rule bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall nat-rule create` [kwargs-del parse-json]
- `network-firewall nat-rule update` [kwargs-del parse-json]
- `network-firewall security-rule bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall service bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall service-list bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall tunnel-inspection-rule bulk-upload` [kwargs-del parse-json json-dumps]
- `network-firewall tunnel-inspection-rule create` [kwargs-del raise-other parse-json]
- `network-firewall tunnel-inspection-rule update` [kwargs-del raise-other parse-json]
- `network-firewall url-list bulk-upload` [kwargs-del parse-json json-dumps]
- `os retention-rule create` [kwargs-del usage-error fold-body]
- `rover node set-secrets` [blank-check helper]
- `support incident create` [fold-body json-dumps]
- `support incident update` [raise-other fold-body json-dumps]

### 12: parameters read from a file (37)

- `analytics analytics-instance create` [kwargs-del fold-body json-dumps file-read]
- `analytics analytics-instance create-vanity-url` [file-read]
- `analytics analytics-instance update-vanity-url` [file-read]
- `api-gateway certificate create` [file-read]
- `artifacts generic artifact upload-by-path` [file-read]
- `bastion session create` [fold-body json-dumps file-read]
- `bastion session create-managed-ssh` [fold-body json-dumps file-read]
- `bastion session create-port-forwarding` [fold-body json-dumps file-read]
- `compute instance launch` [kwargs-del usage-error fold-body parse-json json-dumps file-read]
- `compute instance-console-connection create` [file-read]
- `data-science job create-job-artifact` [kwargs-del blank-check file-read]
- `data-science ml-app-implementation download-package` [kwargs-del blank-check file-read]
- `data-science ml-app-implementation upload-package` [kwargs-del blank-check file-read]
- `data-science ml-app-implementation-version download-package` [kwargs-del blank-check file-read]
- `data-science model create-model-artifact` [kwargs-del blank-check file-read]
- `data-science pipeline create-step-artifact` [kwargs-del blank-check file-read]
- `database-migration connection create-oracle-connection` [raise-other file-read base64]
- `db cloud-vm-cluster update` [kwargs-del usage-error fold-body json-dumps file-read]
- `db system launch` [kwargs-del fold-body json-dumps file-read]
- `db system launch-from-backup` [kwargs-del fold-body json-dumps file-read]
- `db system update` [kwargs-del usage-error fold-body json-dumps file-read]
- `generative-ai-sandbox sandbox-file write` [usage-error file-read]
- `goldengate deployment create` [kwargs-del usage-error raise-other fold-body json-dumps file-read]
- `goldengate deployment update` [kwargs-del usage-error fold-body json-dumps file-read]
- `iam user api-key upload` [raise-other file-read]
- `lb certificate create` [file-read]
- `log-analytics content-import import-custom-content` [kwargs-del file-read]
- `log-analytics entity upload-discovery-data` [kwargs-del file-read]
- `log-analytics lookup append-data` [kwargs-del file-read]
- `log-analytics lookup register-lookup` [kwargs-del file-read]
- `log-analytics lookup update-data` [kwargs-del file-read]
- `log-analytics query export` [fold-body json-dumps file-read]
- `log-analytics upload upload-log-events-file` [kwargs-del file-read]
- `log-analytics upload upload-log-file` [kwargs-del file-read]
- `opsi awr-hub-objects put` [kwargs-del usage-error file-read]
- `os object copy` [kwargs-del file-read base64 helper]
- `os object reencrypt` [kwargs-del file-read base64 helper]

### 14: several operations (15)

Variant selectors: `network-firewall application|decryption-profile create|update` (by `--type`), `data-integration connection|data-asset create|update`, `autoscaling policy create|update`; several requests: `kms management key|vault backup|restore` (bucket vs URI), `log-analytics upload upload-otlp-logs`. `setup instance-principal` also has several invokes but is own logic.

- `autoscaling policy create` [kwargs-del usage-error multi-invoke]
- `autoscaling policy update` [kwargs-del usage-error multi-invoke]
- `data-integration connection create` [multi-invoke]
- `data-integration connection update` [multi-invoke]
- `data-integration data-asset create` [multi-invoke]
- `data-integration data-asset update` [multi-invoke]
- `kms management key backup` [usage-error multi-invoke]
- `kms management key restore` [usage-error multi-invoke]
- `kms management vault backup` [usage-error multi-invoke]
- `kms management vault restore` [usage-error multi-invoke]
- `log-analytics upload upload-otlp-logs` [kwargs-del file-read multi-invoke]
- `network-firewall application create` [kwargs-del raise-other parse-json multi-invoke]
- `network-firewall application update` [kwargs-del raise-other parse-json multi-invoke]
- `network-firewall decryption-profile create` [kwargs-del raise-other parse-json multi-invoke]
- `network-firewall decryption-profile update` [kwargs-del raise-other parse-json multi-invoke]

### Own logic, hand-written like Tier C (22)

These do SDK lookups, print, wait or post-process the invoke result. They stay ordinary Rung 8 Ladder items and are ordered with Tier C by ticket 15.

- `apm-synthetics monitor create-sql-monitor` [fold-body json-dumps file-read base64 output helper]
- `apm-synthetics monitor update-sql-monitor` [fold-body json-dumps file-read base64 output helper]
- `bv boot-volume create` [usage-error json-dumps direct-client]
- `bv volume create` [usage-error json-dumps direct-client]
- `compute volume-attachment list` [usage-error direct-client]
- `db patch get by-database` [kwargs-del direct-client]
- `db patch list by-database` [kwargs-del direct-client]
- `db patch-history get by-database` [kwargs-del direct-client]
- `db patch-history list by-database` [kwargs-del direct-client]
- `fn function delete` [invoke-not-last]
- `generative-ai-sandbox sandbox-file read` [usage-error file-read invoke-not-last]
- `kms management key restore-from-file` [kwargs-del file-read invoke-not-last output]
- `kms management vault restore-from-file` [kwargs-del file-read invoke-not-last output]
- `network remote-peering-connection connect` [usage-error direct-client output]
- `os bucket delete` [usage-error direct-client output wait helper]
- `resource-manager job create-import-tf-state-job` [kwargs-del file-read base64 output helper]
- `resource-manager stack update` [fold-body file-read base64 output helper]
- `rover node add-workload` [blank-check usage-error direct-client output helper]
- `rover node delete-workload` [usage-error direct-client output helper]
- `rover node request-approval` [output]
- `rover node update` [direct-client output helper]
- `setup instance-principal` [json-dumps multi-invoke direct-client output]

## Tier C per service (202)

Tier C never calls `ctx.invoke`; each stays a hand-written Rung 8 item (ordered by ticket 15). Groups that share a shape and could share one handler:

- `cloud-guard data-mask-rule create|update[-for-*]` (8): one model, variants fix the selector.
- `identity-domains apps|groups|users list` (3): same paginated list over an endpoint argument.
- `adm vulnerability-audit create*` (4), `cloud-bridge` create/update (4), `cloud-migrations target-asset create|update` (2), `dbtools-runtime` (4): polymorphic body subtypes chosen by the command.
- `fn function create …` variants (several of 10): same create with different body subtypes.
- `rover` (50): device/node/cluster workflows (likely sharing local-file logic).
- `data-science * head-*-artifact` (3): HEAD request rendered by hand.
- `iam tag|tag-namespace reactivate|retire` (4): likely one update with a fixed `isRetired`.

- **rover** (50): create-master-key-policy, device data-sync task cancel, device data-sync task get, device data-sync task get-snapshot, device data-sync task list, device data-sync task start, device data-sync task-definition change-compartment, device data-sync task-definition change-state, device data-sync task-definition create, device data-sync task-definition delete, device data-sync task-definition get, device data-sync task-definition list, device data-sync task-definition update, device diagnostics bundle cancel, device diagnostics bundle create, device diagnostics bundle get, device diagnostics bundle list, device diagnostics bundle view-summary, device system-upgrade get-import-history, device system-upgrade get-import-status, device system-upgrade import-bundle, device system-upgrade upload-bundle, node create, node delete, node get-certificate, node list-workload, node setup-identity, node show, standalone-cluster add-workload, standalone-cluster change-compartment, standalone-cluster create, standalone-cluster delete, standalone-cluster delete-workload, standalone-cluster get-certificate, standalone-cluster list-workloads, standalone-cluster request-approval, standalone-cluster set-secrets, standalone-cluster show, standalone-cluster update, station-cluster add-workload, station-cluster change-compartment, station-cluster create, station-cluster delete, station-cluster delete-workload, station-cluster get-certificate, station-cluster list-workloads, station-cluster request-approval, station-cluster set-secrets, station-cluster show, station-cluster update
- **db** (18): autonomous-database delete, data-guard-association create from-existing-db-system, data-guard-association create from-existing-vm-cluster, data-guard-association create with-new-db-system, data-guard-association failover, data-guard-association reinstate, data-guard-association switchover, data-guard-association update, database create, database create-database-from-database, database create-from-backup, database create-from-database, database create-standby-database, database delete, database list, database patch, db-home create, system patch
- **os** (15): multipart abort, object bulk-delete, object bulk-delete-versions, object bulk-download, object bulk-upload, object get, object head, object list, object list-object-versions, object put, object restore, object restore-status, object resume-put, object sync, retention-rule update
- **iam** (13): compartment create, compartment list, db-token get, group add-user, group list-users, group remove-user, policy update, tag reactivate, tag retire, tag-namespace reactivate, tag-namespace retire, tag-namespace update, user list-groups
- **compute** (10): image export to-object, image export to-object-uri, image import from-object, image import from-object-uri, instance action, instance attach-vnic, instance change-compartment, instance detach-vnic, instance list-vnics, instance-console-connection get-plink-connection-string
- **fn** (10): function create archive-function direct-archive fn-update-runtime-config, function create archive-function direct-archive manual-runtime-config, function create archive-function object-storage fn-update-runtime-config, function create archive-function object-storage manual-runtime-config, function create container-function, function create pbf-function, function invoke, function update archive-function, function update container-function, function update pbf-function
- **cloud-guard** (8): data-mask-rule create, data-mask-rule create-for-all-targets, data-mask-rule create-for-services, data-mask-rule create-for-targets, data-mask-rule update, data-mask-rule update-for-all-targets, data-mask-rule update-for-services, data-mask-rule update-for-targets
- **setup** (8): autocomplete, bootstrap, config, find-installations, keys, oci-cli-rc, pkcs11-auth, repair-file-permissions
- **artifacts** (7): container image list, container image-signature get-verify, container image-signature list, container image-signature sign-upload, container repository list, generic artifact list, repository list
- **session** (6): authenticate, export, import, refresh, terminate, validate
- **data-science** (5): job head-job-artifact, model head-model-artifact, pipeline head-step-artifact, pipeline list, pipeline-run list
- **network** (4): vnic assign-ipv6, vnic assign-private-ip, vnic unassign-ipv6, vnic unassign-private-ip
- **cloud-bridge** (4): discovery asset-source create, discovery asset-source update, inventory asset create, inventory asset update
- **dbtools-runtime** (4): connection execute-sql async, connection execute-sql sync, database-api-gateway-config-pool-auto-api-spec create default, database-api-gateway-config-pool-auto-api-spec update default
- **adm** (4): vulnerability-audit create, vulnerability-audit create-vulnerability-audit-external-resource-vulnerability-audit-source, vulnerability-audit create-vulnerability-audit-oci-resource-vulnerability-audit-source, vulnerability-audit create-vulnerability-audit-unknown-source-vulnerability-audit-source
- **identity-domains** (3): apps list, groups list, users list
- **resource-manager** (3): job get-job-logs, stack copy, stack create
- **kms** (3): management key-version cancel-deletion, management key-version create, management key-version schedule-deletion
- **profile** (3): current, diagnose, list
- **devops** (2): project summarize-project-analytics, repository summarize-repository-analytics
- **network-firewall** (2): service create, service update
- **mysql** (2): db-system start, db-system stop
- **bv** (2): backup copy, boot-volume-backup copy
- **ce** (2): cluster create-kubeconfig, cluster generate-token
- **cloud-migrations** (2): target-asset create, target-asset update
- **generative-ai-sandbox** (2): sandbox-command stream, sandbox-command-event stream
- **model-deployment** (2): inference-result predict, inference-result predict-with-response-stream
- **database-management** (1): managed-database get-awr-db-report
- **waas** (1): policy-config update
- **media-services** (1): media-stream stream-distribution-channel generate-session-token
- **iot** (1): digital-twin-instance update
- **management-dashboard** (1): dashboard export
- **generative-ai-data** (1): enrichment-jobs cancel
- **audit** (1): event list
- **raw-request** (1): `raw-request` itself

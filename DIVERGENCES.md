# Divergences

Known, recorded differences between boci and the Reference CLI (`oci-cli==3.96.3`). See **Divergence** in [GLOSSARY.md](GLOSSARY.md). `bun run status` counts the `###` entries below.

Every entry needs a reason. An entry marked **unresolved** is one the loop gave up on after three attempts (see CLAUDE.md); it stays here until fixed.

## Entry format

```md
### <leaf command or engine feature>: <one-line summary>

- **Invocation:** `oci ...`
- **Reference CLI:** what oci does
- **boci:** what boci does
- **Why:** why matching it is hard or not worth it
- **State:** accepted | unresolved (tried: ...)
```

## Entries

### `--wait-for-state`: lifecycle state polling is not implemented

- **Invocation:** `oci compute instance update --instance-id <id> --wait-for-state RUNNING`
- **Reference CLI:** waits for the instance to reach one of the requested lifecycle states, polling at `--wait-interval-seconds` until `--max-wait-seconds`.
- **boci:** sends the update request and returns its response without polling.
- **Why:** the command specs contain the wait options, but generated operation metadata does not identify the follow-up resource getter or the response field that identifies the resource. Custom commands with the same options are not dispatched to an operation handler yet. The separate Work-request waiters item addresses a distinct polling flow.
- **State:** unresolved (tried: inspected the generated command and operation metadata, which do not describe a lifecycle polling target; checked CLI dispatch, where custom waiter-bearing commands have no handler; identified that the current rung item spans distinct generated and custom paths without a stated first target)

### Any command with a duplicated parameter: Python UserWarnings on stderr

- **Invocation:** `oci cloud-guard data-mask-rule create-for-services --help` (and the few other commands that register `--from-json` twice)
- **Reference CLI:** prints Click's `UserWarning: The parameter --from-json is used more than once…` to stderr, several times, each prefixed with the local site-packages path of the Python install
- **boci:** prints nothing extra
- **Why:** it reports a bug in oci's own command definitions and embeds a machine-specific path; no script can rely on it. Masked in `test/harness/masks.ts`.
- **State:** accepted

### Datetime options: Unix timestamps beyond year 9999

- **Invocation:** `oci database-management diagnosability managed-database list-alert-logs --time-less-than-or-equal-to 99999999999999999999 ...`
- **Reference CLI:** crashes with a Python `OverflowError: timestamp out of range for platform time_t` traceback, exit 1
- **boci:** usage error `Value … is not a value Unix time.` (the message oci uses for other unparseable timestamps), exit 2
- **Why:** reproducing an interpreter traceback is meaningless; the input is invalid either way
- **State:** accepted

### Any command: OCI_CLI_KEY_FILE pointing to a missing file

- **Invocation:** `OCI_CLI_KEY_FILE=/nonexistent/key.pem oci compute instance list ...`
- **Reference CLI:** crashes in the key-label check with a Python `FileNotFoundError` traceback, exit 1
- **boci:** skips the label check and carries on (the missing key is reported when signing needs it)
- **Why:** reproducing an interpreter traceback is meaningless
- **State:** accepted

### Any command: config key_file pointing to a missing file

- **Invocation:** `oci os ns get` with a profile whose `key_file` points to a nonexistent path
- **Reference CLI:** crashes in the key-label check with a Python `FileNotFoundError` traceback, exit 1
- **boci:** reports the invalid `key_file` path through its config error handling, exit 1
- **Why:** reproducing the interpreter traceback and machine-specific Python paths is not useful; both commands fail before sending a request
- **State:** accepted

### Any command: connection timeout includes waiting for response headers

- **Invocation:** `oci --connection-timeout 1 os ns get` against a local endpoint that accepts TCP and delays its response headers for 1.5 seconds
- **Reference CLI:** completes the request because its connection timeout only covers TCP connection establishment
- **boci:** Bun's fetch abort signal also covers waiting for response headers, so the request times out
- **Why:** Bun's `fetch` API exposes a request signal but no separate TCP connection timeout. The Bun type declarations also expose no separate connection-timeout option; a preflight socket would not govern the actual fetch connection, proxy, or TLS handshake.
- **State:** unresolved (tried: AbortSignal around fetch, delayed-response parity reproduction, checked Bun Fetch API types)

### Generated GET paths: reported operation placeholder substitution failure not reproduced

- **Invocation:** generated request-only parity cases for `compute console-history get-content` and `data-integration user-defined-function-validation get`
- **Reference CLI:** goldens substitute operation path parameters with `test-value` in every segment
- **boci:** the focused parity cases match those goldens; the full generated GET parity run also passes
- **Why:** the earlier reported failing output was unavailable, and three reproduction attempts did not identify a failing case to fix: `bun test test/parity -t 'generated-get-'` (3424 pass, 0 fail), `bun run spec compute console-history get-content` plus `bun test test/parity -t 'generated-get-compute-console-history-get-content'` (1 pass), and `bun run spec data-integration user-defined-function-validation get` plus `bun test test/parity -t 'generated-get-data-integration-user-defined-function-validation-get'` (1 pass). Keep this unresolved until the original failing case ID or another reproducible failure is available.
- **State:** unresolved (tried: generated GET parity suite; focused compute and data-integration path-parameter cases)

### Generated PUT requests: special body signature mismatch not reproduced

- **Invocation:** `bun test test/parity -t 'generated-request-os-ns-update-metadata|generated-request-database-management-tablespace-update'`.
- **Reference CLI:** goldens capture PUT bodies and authorization signatures; the namespace metadata case has an empty body, while the tablespace case exercises a structured generated body.
- **boci:** both focused cases pass, including request body and normalized authorization headers. Inspection of the generated PUT golden requests found no exact mismatch. `src/cli.ts` serializes the generated body before signing; `src/signer.ts` hashes those bytes into `x-content-sha256` and signs `content-length`, `content-type`, and the digest.
- **Why:** no exact signature mismatch could be reproduced to guide a fix.
- **State:** unresolved (tried: broad parity timed out without output; three filtered PUT cases including nested JSON passed; bounded audit inspected empty and structured body goldens and signing implementation without finding a mismatch).

### `os object get` (multipart): part failure omits Python traceback

- **Invocation:** `oci os object get -ns myns -bn mybucket --name fail-big.bin --file out.bin` when a ranged GET part returns an HTTP error
- **Reference CLI:** exits 1 with `RuntimeError: Error downloading parts: Traceback (most recent call last): ... oci.exceptions.ServiceError: {...}` including local Python site-packages paths from `WorkPoolTask`
- **boci:** exits 1 with `RuntimeError: Error downloading parts: ServiceError:\n{...}\n` (no Python stack trace)
- **Why:** reproducing a Python worker-pool traceback with machine-specific site-packages paths is meaningless; both fail with exit 1 and report `RuntimeError: Error downloading parts:` with the service error details.
- **State:** accepted

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

- **Invocation:** `oci --connection-timeout 1 os ns get` against a loopback endpoint that accepts TCP immediately and delays its HTTP response headers for 1.5 seconds
- **Reference CLI:** completes the request (exit 0, one request, expected namespace output); the connection timeout covers connection establishment, not the subsequent wait for response headers
- **boci:** the focused `sendServiceRequest` unit reproduction with `connection_timeout: 1` and `no_retry: true` failed after about 1.01 seconds with `TimeoutError: Connection timed out`, before the endpoint's 1.2-second response headers arrived
- **Why:** Bun 1.4.5 `fetch` has request-wide abort signals and an idle socket timeout, neither of which identifies the TCP/TLS connection phase. Installed Bun declarations expose no connect timeout for `fetch`, `FetchSession`, or `Bun.connect`. `Bun.connect` can create a TCP/TLS socket, but `fetch` cannot use that established socket, so a preflight would open a second connection and would not enforce the timeout on the request's actual proxy/TLS path. Replacing `fetch` with a custom HTTP transport would need to reimplement OCI's current HTTP, TLS, proxy, redirect, decompression, and connection-reuse behavior; no safe low-complexity transport seam is available.
- **State:** unresolved (tried: request-wide AbortSignal; delayed-header test, which confirmed the overbroad abort; pinned OCI 3.96.3 loopback run, which completed; inspected Bun 1.4.5 fetch, FetchSession, and TCP socket APIs; rejected duplicate preflight connection because it cannot enforce the actual request's TCP/TLS connection)

### Generated PUT requests: body bytes now match the Reference CLI

- **Invocation:** generated request-only cases for `os ns update-metadata`, `database-management tablespace update`, `data-safe masking-policy update` with nested `columnSource`, and `data-labeling-service dataplane record update` with numeric image metadata; offline captures used `runCli(CLIS.oci, ...)` and `runInProcess(...)` with the same case argv and fake endpoint.
- **Reference CLI:** Python serializes request JSON with `json.dumps` defaults: comma/colon spaces and ASCII escapes. Parity goldens parse JSON bodies structurally and mask `content-length` and `x-content-sha256`, so the previous focused passes could not detect byte-level differences.
- **boci:** previously emitted compact JSON, which changed body bytes, content length, digest, and therefore the signing string. Generated PUT samples comprise 662 golden requests; their bodies contain 45 nested-object occurrences, 213 booleans and 169 numbers, with no arrays, nulls, or non-ASCII values. The serializer now matches the Reference CLI on four representative captured requests: raw body, `content-length`, `x-content-sha256`, and signing string (after normalizing date/host) match, and both signatures verify with the fixture key. A unit regression additionally covers nested arrays, null, and Unicode ASCII escaping.
- **Why:** the earlier comparison discarded the exact body-signing inputs, so its passing parity checks did not rule out byte-level differences; direct offline captures established the mismatch and the fix.
- **Verification:** `BOCI_PARITY_ALL=1 bun test test/parity -t 'generated-request-'` — 3,180 passed, 0 failed (includes all 662 generated PUT cases, plus generated POST/PATCH cases). `bun test test/unit/operation.test.ts -t 'generated PUT signs Python-compatible JSON bytes'` passes.
- **State:** resolved by serializing generated JSON bodies with Python-compatible separators and ASCII escaping before signing.

### `os object get` (multipart): part failure omits Python traceback

- **Invocation:** `oci os object get -ns myns -bn mybucket --name fail-big.bin --file out.bin` when a ranged GET part returns an HTTP error
- **Reference CLI:** exits 1 with `RuntimeError: Error downloading parts: Traceback (most recent call last): ... oci.exceptions.ServiceError: {...}` including local Python site-packages paths from `WorkPoolTask`
- **boci:** exits 1 with `RuntimeError: Error downloading parts: ServiceError:\n{...}\n` (no Python stack trace)
- **Why:** reproducing a Python worker-pool traceback with machine-specific site-packages paths is meaningless; both fail with exit 1 and report `RuntimeError: Error downloading parts:` with the service error details.
- **State:** accepted

### `setup repair-file-permissions`: missing `--file` omits Python `TypeError` traceback

- **Invocation:** `oci setup repair-file-permissions` (without `--file` and without an `oci_cli_rc` default)
- **Reference CLI:** exits 1 with a Python `TypeError: expected str, bytes or os.PathLike object, not NoneType` traceback in `os.path.expanduser(file)` because `repair_file_permissions` declares `@cli_util.option('--file', required=True)` without `@cli_util.wrap_exceptions`
- **boci:** exits 1 with `Usage: oci setup repair-file-permissions [OPTIONS]\n\nError: Missing option(s) --file.\n` on stderr
- **Why:** reproducing an interpreter traceback with machine-specific paths is meaningless; both fail with exit 1 before touching any files.
- **State:** accepted

### `setup autocomplete`: empty rc file path omits Python `CLIInstallError` traceback

- **Invocation:** `oci setup autocomplete` when no default rc file exists, the user declines creating it, and leaves the rc file path prompt blank
- **Reference CLI:** exits 1 with a Python traceback ending in `oci_cli.cli_setup.CLIInstallError: No suitable profile file found.`
- **boci:** exits 1 with `CLIInstallError: No suitable profile file found.\n` on stderr (no Python stack trace)
- **Why:** reproducing an interpreter traceback with machine-specific paths is meaningless; both fail with exit 1 and report `CLIInstallError: No suitable profile file found.`.
- **State:** accepted

### `session validate`: non-401 service error omits Python traceback

- **Invocation:** `oci session validate --no-retry --endpoint <endpoint>` when `identity.list_regions()` returns a non-401 HTTP error (e.g. 500 or 404)
- **Reference CLI:** exits 1 with a Python traceback ending in `oci_cli.cli_exceptions.ServiceException: <exception str() failed>` because `validate` is wrapped with `@cli_util.wrap_exceptions` without `@json_skeleton_utils.json_skeleton_generation_handler`, so `ServiceException.__str__`'s `sys.exit()` triggers `<exception str() failed>` inside Python 3.12's traceback formatter
- **boci:** exits 1 with the standard `ServiceError:\n{...}\n` JSON envelope on stderr (no Python stack trace)
- **Why:** reproducing an interpreter traceback with `<exception str() failed>` and local site-packages paths is meaningless; both fail with exit 1 after sending the same `GET /20160918/regions` request and report the service error details.
- **State:** accepted

### `session authenticate`: `--no-browser` service error omits Python traceback

- **Invocation:** `oci session authenticate --region us-phoenix-1 --no-browser --no-retry --endpoint <endpoint>` when `identity_data_plane.generate_user_security_token()` returns an HTTP error (e.g. 401 or 500)
- **Reference CLI:** exits 1 with a Python traceback ending in `oci_cli.cli_exceptions.ServiceException: <exception str() failed>` because `authenticate` is wrapped with `@cli_util.wrap_exceptions` without `@json_skeleton_utils.json_skeleton_generation_handler`, so `ServiceException.__str__`'s `sys.exit()` triggers `<exception str() failed>` inside Python 3.12's traceback formatter
- **boci:** exits 1 with the standard `ServiceError:\n{...}\n` JSON envelope on stderr (no Python stack trace)
- **Why:** reproducing an interpreter traceback with `<exception str() failed>` and local site-packages paths is meaningless; both fail with exit 1 after sending the same `POST /v1/token/upst/actions/GenerateUpst` request and report the service error details.
- **State:** accepted

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

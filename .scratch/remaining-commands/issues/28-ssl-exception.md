# 28: TLS certificate failures match the Reference CLI's SSLException

**What to build:** When the HTTPS endpoint's certificate can't be verified, boci prints the Reference CLI's `SSLException` client error (`cli_util.py` `except oci.exceptions.RequestException`, the `SSL: CERTIFICATE_VERIFY_FAILED` branch: "It looks like you are missing some additional certificates…", `--cert-bundle` / `REQUESTS_CA_BUNDLE` tips) and exits 1, instead of an uncaught fetch error.

**Blocked by:** none.

**Status:** done

## Context for the implementer

- Ticket 24 maps other transport failures to `RequestException` (`connectionErrorReport` / `isConnectionError` in `src/core/connection-timeout.ts`, used by `sendServiceRequest`); `isConnectionError` deliberately leaves certificate errors (codes matching CERT/SSL/TLS/SELF_SIGNED/UNABLE_TO_VERIFY) out.
- Offline case: an HTTPS endpoint with a self-signed certificate and no `--cert-bundle` (the harness's fake HTTPS proxy, `test/harness/fake-https-proxy.ts`, has a CA to start from). Use `--no-retry`.

// The central mask list (ADR 0004): everything a Parity comparison ignores.
// Keep it short; each entry needs a reason.

/** Request headers that legitimately differ between two runs or two clients. */
export const IGNORED_REQUEST_HEADERS: Record<string, string> = {
  date: "wall clock at send time",
  host: "fake endpoint port differs per run",
  "opc-request-id": "random per invocation",
  "opc-client-request-id": "random per invocation",
  "opc-retry-token": "random when the command does not supply one",
  "user-agent": "identifies the client (Oracle-PythonCLI vs boci)",
  "opc-client-info": "identifies the client SDK",
  connection: "transport detail",
  "accept-encoding": "transport detail (python-requests vs fetch)",
  "content-length":
    "depends on JSON whitespace; bodies are compared structurally",
  "x-content-sha256":
    "depends on JSON whitespace; signature validity is checked separately",
};

/** Regexes applied to stdout and stderr before comparing. */
export const OUTPUT_MASKS: [RegExp, string, string][] = [
  // [pattern, replacement, reason]
  [
    /^\S+\.py:\d+: \w*Warning: [^\n]*\n {2}[^\n]*\n/gm,
    "",
    "Python warnings from oci's own bugs (e.g. duplicate --from-json), carrying local install paths; see DIVERGENCES.md",
  ],
  [
    /"timestamp": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00"/g,
    '"timestamp": "<timestamp>"',
    "ServiceError timestamp is generated at response time",
  ],
  [
    /File (\\?)"[^"\\]+\/site-packages\/([^"\\]+)\1"/g,
    'File $1"<site-packages>/$2$1"',
    "Python tracebacks from oci worker pools carry the local site-packages install path",
  ],
  [
    /File (\\?)"[^"\\]+\/scripts\/oci-zygote\.py\1"/g,
    'File $1"<scripts>/oci-zygote.py$1"',
    "Python tracebacks captured via the zygote carry the local repo path to oci-zygote.py",
  ],
  [
    /OS Version: [^,]+,/g,
    "OS Version: <os>,",
    "MultipartUploadError embeds the local OS kernel/platform version",
  ],
  [
    /Public key fingerprint: [0-9a-f]{2}(?::[0-9a-f]{2}){15}/g,
    "Public key fingerprint: <fingerprint>",
    "setup keys generates a random RSA key pair per invocation",
  ],
  [
    /^Fingerprint: [0-9a-f]{2}(?::[0-9a-f]{2}){15}$/gm,
    "Fingerprint: <fingerprint>",
    "setup config generates a random RSA key pair per invocation",
  ],
];

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
    /^\S+\.py:\d+: UserWarning: The parameter \S+ is used more than once\. Remove its duplicate as parameters should be unique\.\n {2}[^\n]*\n/gm,
    "",
    "Click's duplicate-parameter warning (e.g. --from-json, -h) carries a local install path; see DIVERGENCES.md",
  ],
  [
    /^\S+\/getpass\.py:\d+: GetPassWarning: Can not control echo on the terminal\.\n {2}[^\n]*\n/gm,
    "",
    "Python's GetPassWarning (a hidden prompt with no terminal) carries the local Python install path; see DIVERGENCES.md",
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
    /File (\\?)"[^"\\]+\/bin\/oci\1"/g,
    'File $1"<bin>/oci$1"',
    "Python tracebacks from spawned oci carry the local entry-script path",
  ],
  [
    /Using tab completion script at: [^\n]+/g,
    "Using tab completion script at: <completion-script>",
    "setup autocomplete prints the local install path to oci_autocomplete.sh",
  ],
  [
    /OS Version: [^,]+,/g,
    "OS Version: <os>,",
    "MultipartUploadError embeds the local OS kernel/platform version",
  ],
  [
    /(&nonce=)[a-f0-9-]{36}(&scope=openid&public_key=)[A-Za-z0-9_%=-]+(&redirect_uri=)/g,
    "$1<nonce>$2<public-key>$3",
    "browser login generates a fresh nonce and RSA key pair",
  ],
  [
    /Uploaded new API key with fingerprint: [0-9a-f]{2}(?::[0-9a-f]{2}){15}/g,
    "Uploaded new API key with fingerprint: <fingerprint>",
    "setup bootstrap uploads a fresh RSA key pair",
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
  [
    /\nboci Extensions\n\n[\s\S]*$/,
    "\n",
    "boci-only Extension commands appended to root --help; see ADR 0005 and DIVERGENCES.md",
  ],
];

/** Only mask the top-level timestamp in recognized exception envelopes and metrics debug logs on stderr. */
export function maskStderr(s: string): string {
  return applyMasks(s)
    .replace(
      /^(?:TransientServiceError|ServiceError|RequestException|SSLException|ConnectTimeout):\n\{\n[\s\S]*?^\}/gm,
      (envelope) =>
        envelope.replace(
          /^( {4}"timestamp": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?(?:\+00:00)?(",?)$/m,
          "$1<timestamp>$2",
        ),
    )
    .replace(
      /^(DEBUG:oci_cli\.cli_metrics: )\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}\+00:00(: )/gm,
      "$1<timestamp>$2",
    );
}

/**
 * Normalize dynamic fields inside an OKE `ExecCredential` JSON envelope while keeping
 * base64url padding, URL structure, region, cluster ID, query encoding, headers, keyId,
 * and opc-obo-token unmasked for exact parity comparison.
 */
function maskExecCredential(s: string): string {
  if (!s.includes('"kind": "ExecCredential"')) return s;
  return s.replace(
    /\{\n {4}"apiVersion": "client\.authentication\.k8s\.io\/v1beta1",\n {4}"kind": "ExecCredential",\n {4}"status": \{\n {8}"token": "([A-Za-z0-9_-]+={0,2})",\n {8}"expirationTimestamp": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?Z"\n {4}\}\n\}/g,
    (match, token: string) => {
      if (token.length % 4 !== 0) return match;
      const decoded = Buffer.from(
        token.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8");
      const maskedUrl = decoded
        .replace(/(signature%3D%22)[A-Za-z0-9%_-]+(%22)/, "$1<signature>$2")
        .replace(
          /(&date=)[A-Za-z]{3}%2C\+\d{2}\+[A-Za-z]{3}\+\d{4}\+\d{2}%3A\d{2}%3A\d{2}\+GMT/,
          "$1<date>",
        );
      return match
        .replace(
          `"token": "${token}"`,
          `"token": "<exec-credential-token:${maskedUrl}>"`,
        )
        .replace(
          /"expirationTimestamp": "[^"]+"/,
          '"expirationTimestamp": "<timestamp>"',
        );
    },
  );
}

/**
 * Normalize a `raw-request` JSON envelope on stdout: mask the server's dynamic `Date`
 * response header and lowercase response header keys (WHATWG Fetch lowercases `Headers`,
 * while Python `requests` preserves wire casing; see DIVERGENCES.md).
 */
function maskRawRequest(s: string): string {
  if (!s.includes('"headers":') || !s.includes('"status":')) return s;
  try {
    const parsed: unknown = JSON.parse(s);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return s;
    }
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "data" ||
      keys[1] !== "headers" ||
      keys[2] !== "status" ||
      typeof obj.status !== "string" ||
      !/^\d{3}\b/.test(obj.status) ||
      typeof obj.headers !== "object" ||
      obj.headers === null ||
      Array.isArray(obj.headers)
    ) {
      return s;
    }
    const normalizedHeaders: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      obj.headers as Record<string, unknown>,
    )) {
      const lower = k.toLowerCase();
      normalizedHeaders[lower] =
        lower === "date" && typeof v === "string"
          ? v.replace(
              /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
              "<http-date>",
            )
          : v;
    }
    const sortedHeaders = Object.fromEntries(
      Object.entries(normalizedHeaders).sort(([a], [b]) => a.localeCompare(b)),
    );
    const trailing = s.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify({ data: obj.data, headers: sortedHeaders, status: obj.status }, null, 2)}${trailing}`;
  } catch {
    return s;
  }
}

export function applyMasks(s: string): string {
  return maskRawRequest(
    maskExecCredential(
      OUTPUT_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), s),
    ),
  );
}

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

/** Only mask the top-level timestamp in recognized exception envelopes on stderr. */
export function maskStderr(s: string): string {
  if (!/^(?:ServiceError|(?:\w+Exception)):\n\{/m.test(s)) return applyMasks(s);
  return applyMasks(s)
    .replace(
      /("timestamp": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00("(?=,?\s*\n))/g,
      "$1<timestamp>$2",
    )
    .replace(
      /("timestamp": ")\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?("(?=,?\s*\n))/g,
      "$1<timestamp>$2",
    );
}

export function applyMasks(s: string): string {
  return OUTPUT_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

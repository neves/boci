// The central mask list (ADR 0004): everything a Parity comparison ignores.
// Keep it short; each entry needs a reason.

/** Request headers that legitimately differ between two runs or two clients. */
export const IGNORED_REQUEST_HEADERS: Record<string, string> = {
  date: "wall clock at send time",
  host: "fake endpoint port differs per run",
  "opc-request-id": "random per invocation",
  "opc-client-request-id": "random per invocation",
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
];

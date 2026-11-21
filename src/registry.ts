// Which Leaf commands and Engine features boci implements. Parity cases for a key
// only run once it is listed here (test/parity/parity.test.ts). Grows rung by rung.
import { GENERATED_GET_COVERAGE } from "./generated-get-coverage.ts";
import { GENERATED_REQUEST_COVERAGE } from "./generated-request-coverage.ts";

const IMPLEMENTED = new Set<string>([
  "--version",
  "generate-full-command-json-input",
  "generate-param-json-input",
  "--query",
  "--output table",
  "--raw-output",
  "rc-canned-queries",
  "help:leaf",
  "help:group",
  "help:root",
  "usage",
  "usage:unknown-option",
  "usage:unknown-command",
  "convert",
  "required",
  "root-callback",
  "rc",
  "rc-defaults",
  "rc-aliases",
  "rc-param-aliases",
  "os ns get",
  "debug",
  "read-timeout",
  "no-retry",
  "max-retries",
  "compute boot-volume-attachment get",
  "compute global-image-capability-schema list",
]);

export function isImplemented(key: string): boolean {
  return (
    IMPLEMENTED.has(key) ||
    GENERATED_GET_COVERAGE.has(key) ||
    GENERATED_REQUEST_COVERAGE.has(key)
  );
}

// Which Leaf commands and Engine features boci implements. Parity cases for a key
// only run once it is listed here (test/parity/parity.test.ts). Grows rung by rung.

const IMPLEMENTED = new Set<string>([
  "--version",
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
]);

export function isImplemented(key: string): boolean {
  return IMPLEMENTED.has(key);
}

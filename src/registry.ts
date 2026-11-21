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
]);

export function isImplemented(key: string): boolean {
  return IMPLEMENTED.has(key);
}

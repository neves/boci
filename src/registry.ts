// Which Leaf commands and Engine features boci implements. Parity cases for a key
// only run once it is implemented (test/parity/parity.test.ts). Grows rung by rung.
// Generated commands are implemented by rule (engineSupports); Custom commands and
// Engine features are listed by hand.
import { loadIndex, loadService, type ServiceSpec } from "./spec.ts";

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
  "debug",
  "read-timeout",
  "no-retry",
  "max-retries",
  // Generated commands outside engineSupports, tested by hand-written cases.
  "email-data-plane email-raw-submitted-response submit-raw-email",
  // Custom commands.
  "os object get",
  "os object put",
  "os object resume-put",
  "os object bulk-upload",
  "os object bulk-download",
  "os object bulk-delete",
  "os object sync",
  "setup repair-file-permissions",
  "setup keys",
  "setup config",
  "setup autocomplete",
]);

// Generated commands the engine would accept by rule but that don't behave like the
// Reference CLI yet. Keep each with a reason.
const EXCLUDED = new Set<string>([]);

export type Command = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

const WRITE_METHODS = ["POST", "PUT", "PATCH"];
const isComplex = (p: { type?: string; typeClass?: string }) =>
  ["complex", "json", "complex type"].includes(String(p.type)) ||
  String(p.typeClass).includes("Complex");

/**
 * Whether the generic engine runs this Generated command: every GET, and POST/PUT/PATCH
 * whose request body is built from at least one simple (non-complex) bound option.
 * Writes with no body, a direct body, or only complex body options aren't supported yet.
 */
export function engineSupports(command: Command): boolean {
  if (command.kind !== "generated") return false;
  const http = command.operation?.http ?? "";
  if (http === "GET") return true;
  if (!WRITE_METHODS.includes(http)) return false;
  return (command.bindings ?? []).some((b) => {
    if (b.target !== "body") return false;
    if (typeof b.value === "string" || typeof b.value === "boolean")
      return true;
    const param = command.params?.find((p) => p.name === b.param);
    return param !== undefined && !isComplex(param);
  });
}

/** `command` is the Leaf command's spec entry, when `key` names one. */
export function isImplemented(key: string, command?: Command): boolean {
  if (IMPLEMENTED.has(key)) return true;
  return command !== undefined && engineSupports(command) && !EXCLUDED.has(key);
}

/** isImplemented over keys from many services, loading each service's spec once (tooling). */
export async function implementedLookup(
  keys: Iterable<string>,
): Promise<(key: string) => boolean> {
  const { services } = await loadIndex();
  const specs = new Map<string, ServiceSpec>();
  for (const key of keys) {
    const service = key.split(" ")[0] ?? "";
    if (services[service] && !specs.has(service))
      specs.set(service, await loadService(service));
  }
  return (key) => {
    const [service = "", ...words] = key.split(" ");
    return isImplemented(key, specs.get(service)?.commands[words.join(" ")]);
  };
}

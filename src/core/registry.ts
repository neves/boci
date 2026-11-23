// Which Leaf commands and Engine features boci implements. Parity cases for a key
// only run once it is implemented (test/parity/parity.test.ts). Grows rung by rung.
// Generated commands are implemented by rule (engineSupports); Custom commands are
// derived from CUSTOM_HANDLERS and Engine features are listed by hand.
import type { Invocation } from "../lib/io.ts";
import type { OutputFileHandle } from "./click-file.ts";
import type { Rc } from "./rc.ts";
import {
  loadIndex,
  loadService,
  type Index,
  type ServiceSpec,
} from "./spec.ts";

export type CustomCommandContext = {
  io: Invocation;
  values: Record<string, unknown>;
  rootValues: Record<string, unknown>;
  settings: { configFile: string; profile: string; auth: string | null };
  rc: Rc;
  index: Index;
  spec: ServiceSpec;
  usageText: () => string;
  usageError: (message: string) => never;
  outputFile?: OutputFileHandle;
};

export type CustomCommandHandler = (
  ctx: CustomCommandContext,
) => Promise<void> | void;

const outputOptions = (ctx: CustomCommandContext) => ({
  query: ctx.rootValues.query,
  output: ctx.rootValues.output,
  rawOutput: ctx.rootValues.raw_output,
  rc: ctx.rc,
});

function lazyOsOutput(
  pick: (m: typeof import("../commands/os.ts")) => (
    io: Invocation,
    opts: {
      values: Record<string, unknown>;
      rootValues: Record<string, unknown>;
      settings: CustomCommandContext["settings"];
      spec: ServiceSpec;
      index: Index;
      usageText: () => string;
      outputOptions: ReturnType<typeof outputOptions>;
    },
  ) => Promise<void>,
): CustomCommandHandler {
  return async (ctx) => {
    const mod = await import("../commands/os.ts");
    await pick(mod)(ctx.io, {
      values: ctx.values,
      rootValues: ctx.rootValues,
      settings: ctx.settings,
      spec: ctx.spec,
      index: ctx.index,
      usageText: ctx.usageText,
      outputOptions: outputOptions(ctx),
    });
  };
}

/** Single source of truth for Custom OCI Leaf command handlers, loaded lazily on dispatch. */
export const CUSTOM_HANDLERS = new Map<string, CustomCommandHandler>([
  [
    "profile current",
    async (ctx) => {
      const { runProfileCurrent } = await import("../commands/profile.ts");
      runProfileCurrent(ctx.io, { settings: ctx.settings });
    },
  ],
  [
    "os object get",
    async (ctx) => {
      const { runOsObjectGet } = await import("../commands/os.ts");
      await runOsObjectGet(ctx.io, {
        values: ctx.values,
        rootValues: ctx.rootValues,
        settings: ctx.settings,
        spec: ctx.spec,
        index: ctx.index,
        usageText: ctx.usageText,
        outputFile: ctx.outputFile,
      });
    },
  ],
  ["os object put", lazyOsOutput((m) => m.runOsObjectPut)],
  ["os object resume-put", lazyOsOutput((m) => m.runOsObjectResumePut)],
  ["os object bulk-upload", lazyOsOutput((m) => m.runOsObjectBulkUpload)],
  ["os object bulk-download", lazyOsOutput((m) => m.runOsObjectBulkDownload)],
  ["os object bulk-delete", lazyOsOutput((m) => m.runOsObjectBulkDelete)],
  ["os object sync", lazyOsOutput((m) => m.runOsObjectSync)],
  [
    "setup repair-file-permissions",
    async (ctx) => {
      const { runSetupRepairFilePermissions } =
        await import("../commands/setup.ts");
      runSetupRepairFilePermissions(ctx.io, {
        values: ctx.values,
        usageError: ctx.usageError,
      });
    },
  ],
  [
    "setup keys",
    async (ctx) => {
      const { runSetupKeys } = await import("../commands/setup.ts");
      await runSetupKeys(ctx.io, {
        values: ctx.values,
        usageError: ctx.usageError,
      });
    },
  ],
  [
    "setup config",
    async (ctx) => {
      const { runSetupConfig } = await import("../commands/setup.ts");
      await runSetupConfig(ctx.io, {
        regions: ctx.index.regions,
        usageError: ctx.usageError,
      });
    },
  ],
  [
    "setup autocomplete",
    async (ctx) => {
      const { runSetupAutocomplete } = await import("../commands/setup.ts");
      await runSetupAutocomplete(ctx.io);
    },
  ],
  [
    "session validate",
    async (ctx) => {
      const { runSessionValidate } = await import("../commands/session.ts");
      await runSessionValidate(ctx.io, {
        values: ctx.values,
        rootValues: ctx.rootValues,
        settings: ctx.settings,
        index: ctx.index,
      });
    },
  ],
  [
    "session refresh",
    async (ctx) => {
      const { runSessionRefresh } = await import("../commands/session.ts");
      await runSessionRefresh(ctx.io, {
        rootValues: ctx.rootValues,
        settings: ctx.settings,
        index: ctx.index,
      });
    },
  ],
  [
    "session export",
    async (ctx) => {
      const { runSessionExport } = await import("../commands/session.ts");
      await runSessionExport(ctx.io, {
        values: ctx.values,
        settings: ctx.settings,
      });
    },
  ],
  [
    "session import",
    async (ctx) => {
      const { runSessionImport } = await import("../commands/session.ts");
      await runSessionImport(ctx.io, {
        values: ctx.values,
        settings: ctx.settings,
      });
    },
  ],
  [
    "session authenticate",
    async (ctx) => {
      const { runSessionAuthenticate } = await import("../commands/session.ts");
      await runSessionAuthenticate(ctx.io, {
        values: ctx.values,
        rootValues: ctx.rootValues,
        settings: ctx.settings,
        rc: ctx.rc,
        index: ctx.index,
        spec: ctx.spec,
      });
    },
  ],
]);

const ENGINE_FEATURES = [
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
  "work-request-waiter",
  "lifecycle-waiter",
  // Generated commands outside engineSupports, tested by hand-written cases.
  "email-data-plane email-raw-submitted-response submit-raw-email",
];

const IMPLEMENTED = new Set<string>([
  ...ENGINE_FEATURES,
  ...CUSTOM_HANDLERS.keys(),
]);

// Generated commands the engine would accept by rule but that don't behave like the
// Reference CLI yet. Keep each with a reason.
const EXCLUDED = new Set<string>([]);

export type Command = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

const WRITE_METHODS = ["POST", "PUT", "PATCH"];

/**
 * Whether the generic engine runs this Generated command: every GET/HEAD, bodyless DELETE,
 * and POST/PUT/PATCH whose request body is built from at least one body option.
 * Bodyless writes and writes with direct bodies aren't supported yet.
 */
export function engineSupports(command: Command): boolean {
  if (command.kind !== "generated") return false;
  const http = command.operation?.http ?? "";
  if (http === "GET" || http === "HEAD") return true;
  if (http === "DELETE") return command.operation?.body === undefined;
  if (!WRITE_METHODS.includes(http)) return false;
  return (command.bindings ?? []).some((b) => {
    if (b.target !== "body") return false;
    if (typeof b.value === "string" || typeof b.value === "boolean")
      return true;
    return command.params?.some((p) => p.name === b.param) ?? false;
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

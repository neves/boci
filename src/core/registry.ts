// Which Leaf commands and Engine features boci implements. Parity cases for a key
// only run once it is implemented (test/parity/parity.test.ts). Grows rung by rung.
// Generated commands are implemented by rule (engineSupports); Custom commands are
// derived from CUSTOM_HANDLERS and Engine features are listed by hand.
import type { Invocation } from "../lib/io.ts";
import type { OutputFileHandle } from "./click-file.ts";
import type { Rc } from "./rc.ts";
import type { OsObjectPutOptions } from "../commands/os/shared.ts";
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

function lazyOsOutput<T>(
  load: () => Promise<T>,
  pick: (m: T) => (io: Invocation, opts: OsObjectPutOptions) => Promise<void>,
): CustomCommandHandler {
  return async (ctx) => {
    const mod = await load();
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
      const { runOsObjectGet } = await import("../commands/os/get.ts");
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
  [
    "os object put",
    lazyOsOutput(
      () => import("../commands/os/put.ts"),
      (m) => m.runOsObjectPut,
    ),
  ],
  [
    "os object resume-put",
    lazyOsOutput(
      () => import("../commands/os/resume_put.ts"),
      (m) => m.runOsObjectResumePut,
    ),
  ],
  [
    "os object bulk-upload",
    lazyOsOutput(
      () => import("../commands/os/bulk_upload.ts"),
      (m) => m.runOsObjectBulkUpload,
    ),
  ],
  [
    "os object bulk-download",
    lazyOsOutput(
      () => import("../commands/os/bulk_download.ts"),
      (m) => m.runOsObjectBulkDownload,
    ),
  ],
  [
    "os object bulk-delete",
    lazyOsOutput(
      () => import("../commands/os/bulk_delete.ts"),
      (m) => m.runOsObjectBulkDelete,
    ),
  ],
  [
    "os object sync",
    lazyOsOutput(
      () => import("../commands/os/sync.ts"),
      (m) => m.runOsObjectSync,
    ),
  ],
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
  // Tier B argument checks (survey.checks) whose happy path is not implemented yet.
  "usage-checks",
  // Generated commands outside engineSupports, tested by hand-written cases.
  "email-data-plane email-raw-submitted-response submit-raw-email",
];

const IMPLEMENTED = new Set<string>([
  ...ENGINE_FEATURES,
  ...CUSTOM_HANDLERS.keys(),
]);

// Generated and Tier A commands that don't match the Reference CLI; each entry includes its reason.
const EXCLUDED = new Set<string>([
  // Reference CLI ignores --operation-name and sends the fixed SDK operation name;
  // the generated path binding cannot represent that command-specific behavior.
  "ocvs sddc retrieve-sddc-operation-status",
  // Tier A wrapper the Reference CLI can't run: the delegated generated command rejects
  // the injected `operation` kwarg with a TypeError before any request.
  "resource-manager job create-plan-rollback-job",
  // Tier B wrappers that fold options into snake_case keys (e.g. `total_size_in_gbs`);
  // the generated command's parse_json_parameter camelizes them by the SDK model
  // (cli_util.make_dict_keys_camel_case), which the Engine doesn't model yet (ticket 19).
  "db database update",
  "db exascale-db-storage-vault create",
  "db exascale-db-storage-vault update",
  "db system launch-from-database",
  "db system launch-from-db-system",
  "db system launch",
  "db system launch-from-backup",
  "db system update",
  // Tier B wrappers that hand a binary file's bytes to the generated command as the raw
  // request body; the Engine doesn't send binary bodies yet (ticket 21).
  "log-analytics content-import import-custom-content",
  "log-analytics lookup append-data",
  "log-analytics lookup register-lookup",
  "log-analytics lookup update-data",
  // Writes the response to `--file` (a lazy click.File); not modeled yet (ticket 22).
  "log-analytics query export",
]);

export type Command = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

const WRITE_METHODS = ["POST", "PUT", "PATCH"];

/**
 * A Tier B wrapper compiled to a program (tickets 11 and 12; `click.File` options reach
 * it as open files).
 */
function programmed(command: Command): boolean {
  return command.kind === "custom" && command.tier === "B" && !!command.program;
}

/**
 * Whether the generic engine runs this Generated command: every GET/HEAD, bodyless DELETE,
 * and POST/PUT/PATCH with either body options, a direct body parameter, or no body.
 */
export function engineSupports(command: Command): boolean {
  if (
    command.kind !== "generated" &&
    !(command.kind === "custom" && command.tier === "A") &&
    !programmed(command)
  )
    return false;
  const http = command.operation?.http ?? "";
  if (http === "GET" || http === "HEAD") return true;
  if (http === "DELETE") return command.operation?.body === undefined;
  if (!WRITE_METHODS.includes(http)) return false;
  const bodyBindings = (command.bindings ?? []).filter(
    (binding) => binding.target === "body",
  );
  if (bodyBindings.length === 0) {
    // Operations with no body options are either bodyless actions or pass a
    // direct body parameter through operation.body.
    return true;
  }
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

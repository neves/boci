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

const computeHandler: CustomCommandHandler = async (ctx) => {
  const { runComputeInstanceListVnics } =
    await import("../commands/compute/list_vnics.ts");
  await runComputeInstanceListVnics(ctx);
};

const computePlinkHandler: CustomCommandHandler = async (ctx) => {
  const { runComputeInstanceConsolePlink } =
    await import("../commands/compute/plink_connection.ts");
  await runComputeInstanceConsolePlink(ctx);
};

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
    "ce cluster generate-token",
    async (ctx) => {
      const { runCeClusterGenerateToken } =
        await import("../commands/ce/cluster_generate_token.ts");
      await runCeClusterGenerateToken(ctx);
    },
  ],
  [
    "ce cluster create-kubeconfig",
    async (ctx) => {
      const { runCeClusterCreateKubeconfig } =
        await import("../commands/ce/cluster_create_kubeconfig.ts");
      await runCeClusterCreateKubeconfig(ctx);
    },
  ],
  ["compute instance list-vnics", computeHandler],
  [
    "compute instance-console-connection get-plink-connection-string",
    computePlinkHandler,
  ],
  [
    "compute instance attach-vnic",
    async (ctx) => {
      const { runComputeInstanceAttachVnic } =
        await import("../commands/compute/attach_vnic.ts");
      await runComputeInstanceAttachVnic(ctx);
    },
  ],
  [
    "compute instance action",
    async (ctx) => {
      const { runComputeInstanceAction } =
        await import("../commands/compute/instance_action.ts");
      await runComputeInstanceAction(ctx);
    },
  ],
  [
    "compute instance change-compartment",
    async (ctx) => {
      const { runComputeInstanceChangeCompartment } =
        await import("../commands/compute/change_compartment.ts");
      await runComputeInstanceChangeCompartment(ctx);
    },
  ],
  [
    "compute instance detach-vnic",
    async (ctx) => {
      const { runComputeInstanceDetachVnic } =
        await import("../commands/compute/detach_vnic.ts");
      await runComputeInstanceDetachVnic(ctx);
    },
  ],
  [
    "compute volume-attachment list",
    async (ctx) => {
      const { runComputeVolumeAttachmentList } =
        await import("../commands/compute/list_volume_attachments.ts");
      await runComputeVolumeAttachmentList(ctx);
    },
  ],
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
  "connection-error",
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
export const EXCLUDED = new Map<string, string>([
  // Reference CLI ignores --operation-name and sends the fixed SDK operation name;
  // the generated path binding cannot represent that command-specific behavior.
  [
    "ocvs sddc retrieve-sddc-operation-status",
    "Reference CLI sends a fixed operation name",
  ],
  // Tier A wrapper the Reference CLI can't run: the delegated generated command rejects
  // the injected `operation` kwarg with a TypeError before any request.
  [
    "resource-manager job create-plan-rollback-job",
    "Reference delegate rejects the injected operation argument",
  ],
]);

export type Command = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

const WRITE_METHODS = ["POST", "PUT", "PATCH"];

/**
 * A Tier B or Tier C wrapper compiled to a program (`click.File` options reach it as
 * open files; Tier C programs call SDK operations directly via `sdkOperations`).
 */
function programmed(command: Command): boolean {
  return (
    command.kind === "custom" &&
    (command.tier === "B" || command.tier === "C") &&
    !!command.program
  );
}

const SDK_METHODS = new Set(["GET", "HEAD", "DELETE", "POST", "PUT", "PATCH"]);

function sdkOperationSupported(operation: Command["operation"]): boolean {
  return Boolean(
    operation &&
    (SDK_METHODS.has(operation.http) || operation.method === "__call_api__"),
  );
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
  if (programmed(command)) {
    const hasInvoke = command.operation !== undefined;
    const sdkOps = command.sdkOperations ?? [];
    if (!hasInvoke && sdkOps.length === 0 && !command.program?.rawRequests)
      return false;
    return (
      (!hasInvoke ||
        requestSupported(
          command.operation,
          command.bindings,
          command.generated?.params ?? command.params,
        )) &&
      (command.variants ?? []).every((v) =>
        requestSupported(v.operation, v.bindings, v.generated.params),
      ) &&
      sdkOps.every(sdkOperationSupported)
    );
  }
  return requestSupported(command.operation, command.bindings, command.params);
}

function requestSupported(
  operation: Command["operation"],
  bindings: Record<string, unknown>[] = [],
  params: { name: string }[] = [],
): boolean {
  const http = operation?.http ?? "";
  if (http === "GET" || http === "HEAD") return true;
  if (http === "DELETE") return operation?.body === undefined;
  if (!WRITE_METHODS.includes(http)) return false;
  const bodyBindings = bindings.filter((binding) => binding.target === "body");
  if (bodyBindings.length === 0) {
    // Operations with no body options are either bodyless actions or pass a
    // direct body parameter through operation.body.
    return true;
  }
  return bindings.some((b) => {
    if (b.target !== "body") return false;
    if (typeof b.value === "string" || typeof b.value === "boolean")
      return true;
    return params.some((p) => p.name === b.param);
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

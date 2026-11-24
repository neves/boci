// Reference: services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py:415 (125 lines)
import type { Models } from "../../core/camelize.ts";
import { printResult, renderModel } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { parseJsonBody } from "../../utils/parseJsonBody.ts";
import { Exit } from "../../lib/io.ts";

const OBJECT_LIST_PAGE_SIZE = 100;
const DEFAULT_FIELDS =
  "name,size,etag,md5,timeCreated,timeModified,storageTier,archivalState";

const OBJECT_SUMMARY_MODELS: Models[string] = {
  ObjectSummary: {
    attributes: [
      ["archival_state", "str", "archivalState"],
      ["etag", "str", "etag"],
      ["md5", "str", "md5"],
      ["name", "str", "name"],
      ["size", "int", "size"],
      ["storage_tier", "str", "storageTier"],
      ["time_created", "datetime", "timeCreated"],
      ["time_modified", "datetime", "timeModified"],
    ],
  },
};

const listObjectsOperation: OperationSpec = {
  client: "object_storage.object_storage",
  method: "list_objects",
  http: "GET",
  path: "/n/{namespaceName}/b/{bucketName}/o",
  pathParams: {
    namespaceName: "namespace_name",
    bucketName: "bucket_name",
  },
  queryParams: {
    prefix: {
      arg: "prefix",
    },
    start: {
      arg: "start",
    },
    end: {
      arg: "end",
    },
    limit: {
      arg: "limit",
    },
    delimiter: {
      arg: "delimiter",
    },
    fields: {
      arg: "fields",
    },
    startAfter: {
      arg: "start_after",
    },
  },
  headerParams: {
    accept: {
      value: "application/json",
    },
    "content-type": {
      value: "application/json",
    },
    "opc-client-request-id": {
      arg: "opc_client_request_id",
    },
  },
  responseType: "ListObjects",
};

type ListObjectsPayload = {
  objects?: Record<string, unknown>[];
  prefixes?: string[] | null;
  nextStartWith?: string | null;
};

export async function runOsObjectList(
  ctx: CustomCommandContext,
): Promise<void> {
  const allPages = ctx.values.all_pages === true;
  let limit = ctx.values.limit as number | undefined;
  const pageSize = ctx.values.page_size as number | undefined;
  const streamOutput = ctx.values.stream_output === true;

  if (allPages && limit !== undefined) {
    ctx.io.err(
      "UsageError: If you provide the --all option you cannot provide the --limit option\n",
    );
    throw new Exit(1);
  }
  if (!allPages && limit === undefined) {
    limit = 100;
  }

  let namespace = ctx.values.namespace as string | undefined;
  if (namespace === undefined) {
    const nsResult = await callCommand(ctx, "os", "ns get", {});
    if (!nsResult.response.ok) {
      ctx.usageError(
        `Unable to retrieve namespace internally. Please provide the namespace using the option "--['namespace']".`,
      );
    }
    try {
      namespace = String(JSON.parse(nsResult.raw));
    } catch {
      namespace = nsResult.raw;
    }
  }

  const fields = (ctx.values.fields as string | undefined) ?? DEFAULT_FIELDS;
  const command = sdkCommand(ctx, "object list", listObjectsOperation);
  const allObjects: unknown[] = [];
  const prefixes: string[] = [];
  let remainingItemCount = limit ?? 0;
  let keepPaginatingForAll = true;
  let fetchedAtLeastOnce = false;
  let start = ctx.values.start as string | undefined;
  let lastNextStartWith: string | null | undefined;
  let firstStreamItem = true;
  let responseModels: Models[string] | undefined;

  if (streamOutput) {
    ctx.io.out('{\n  "data": [');
  }

  while (
    (!allPages && (remainingItemCount > 0 || !fetchedAtLeastOnce)) ||
    (allPages && keepPaginatingForAll)
  ) {
    fetchedAtLeastOnce = true;

    const reqLimit = allPages
      ? pageSize || OBJECT_LIST_PAGE_SIZE
      : Math.min(pageSize || OBJECT_LIST_PAGE_SIZE, remainingItemCount);

    const result = await callCommand(
      ctx,
      "os",
      "object list",
      {
        ...ctx.values,
        namespace_name: namespace,
        fields,
        limit: reqLimit,
        all_pages: false,
        ...(start ? { start } : {}),
      },
      command,
    );

    if (!result.response.ok) {
      printResult(ctx.io, result, outputOptions(ctx));
      return;
    }
    responseModels = result.responseModels;

    const payload = (parseJsonBody(result.raw) ?? {}) as ListObjectsPayload;
    if (Array.isArray(payload.prefixes)) {
      for (const p of payload.prefixes) {
        if (!prefixes.includes(p)) prefixes.push(p);
      }
    }

    const models = responseModels?.ObjectSummary
      ? responseModels
      : OBJECT_SUMMARY_MODELS;
    const objects = Array.isArray(payload.objects) ? payload.objects : [];
    if (streamOutput) {
      const rendered = renderModel(
        objects,
        "list[ObjectSummary]",
        models,
      ) as unknown[];
      for (const obj of rendered) {
        if (!firstStreamItem) ctx.io.out(",");
        const json = JSON.stringify(obj, null, 2);
        const lines = json.split("\n");
        const indented = lines
          .map((line, i) =>
            i === 0
              ? `     ${line}`
              : i === lines.length - 1
                ? `    \n    ${line}`
                : `    ${line}`,
          )
          .join("\n");
        ctx.io.out(`\n${indented}`);
        firstStreamItem = false;
      }
    } else {
      allObjects.push(...objects);
    }

    lastNextStartWith = payload.nextStartWith;
    if (lastNextStartWith) {
      if (remainingItemCount) {
        remainingItemCount -= objects.length;
      }
      start = lastNextStartWith;
    } else {
      keepPaginatingForAll = false;
      remainingItemCount = 0;
    }
  }

  const metadata: Record<string, unknown> = { prefixes };
  if (lastNextStartWith) {
    metadata["next-start-with"] = lastNextStartWith;
  }

  if (streamOutput) {
    ctx.io.out(firstStreamItem ? "],\n" : "\n  ],\n");
    const pyList =
      "[" + prefixes.map((p) => `'${p.replace(/'/g, "\\'")}'`).join(", ") + "]";
    ctx.io.out(`  "prefixes": ${pyList}\n}\n`);
    return;
  }

  const renderedObjects = renderModel(
    allObjects,
    "list[ObjectSummary]",
    responseModels?.ObjectSummary ? responseModels : OBJECT_SUMMARY_MODELS,
  );
  ctx.io.out(
    `${JSON.stringify({ data: renderedObjects, ...metadata }, null, 2)}\n`,
  );
}

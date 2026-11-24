import {
  sendServiceRequest,
  type ServiceClient,
  type ServiceRequestOptions,
  type ServiceResponse,
} from "../core/operation.ts";
import { confirmUnderWrapExceptions } from "../core/operation.ts";
import { formatServiceError } from "../core/output.ts";
import type { CustomCommandContext } from "../core/registry.ts";
import {
  formatBulkProgressLabel,
  OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS,
} from "../commands/os/shared.ts";
import { Exit } from "./io.ts";

export const bucketPath = "/n/{namespaceName}/b/{bucketName}";
const pageSize = OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS;

export function bucketRequest(
  ctx: CustomCommandContext,
  client: ServiceClient,
  namespaceName: string,
  bucketName: string,
) {
  return (
    method: string,
    suffix = "",
    queryParams: [string, string][] = [],
    pathParams: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) =>
    sendServiceRequest(ctx.io, client, {
      method,
      pathTemplate: bucketPath + suffix,
      pathParams: { namespaceName, bucketName, ...pathParams },
      queryParams,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      },
    } satisfies ServiceRequestOptions);
}

export function bucketServiceError(
  result: ServiceResponse,
  http: string,
  method: string,
) {
  return formatServiceError(
    { http, method },
    result.url.origin + result.url.pathname,
    result.response,
    result.raw,
    "object_storage",
  );
}

export function checkBucketResponse(
  ctx: CustomCommandContext,
  result: ServiceResponse,
  http: string,
  method: string,
) {
  if (result.response.ok) return;
  ctx.io.err(bucketServiceError(result, http, method));
  throw new Exit(1);
}

type DeleteJob = {
  name: string;
  suffix: string;
  pathParams: Record<string, string>;
  query?: [string, string][];
};

type BucketRequest = ReturnType<typeof bucketRequest>;

export class BulkDeleteOperationOutput {
  deleted: string[] = [];
  failures = new Map<string, string>();

  constructor(readonly type = "object") {}

  json() {
    return {
      "delete-failures": Object.fromEntries(this.failures),
      "deleted-objects": this.deleted,
    };
  }

  rows(dryRun: boolean) {
    return [
      ...Array.from(this.failures, ([name, failure]) => ({
        action: "Failed",
        [this.type]: name,
        "error-message": failure,
      })),
      ...this.deleted.map((name) => ({
        action: dryRun ? "Dry Run" : "Deleted",
        type: this.type,
        name,
      })),
    ];
  }
}

export async function deletePage(
  ctx: CustomCommandContext,
  request: BucketRequest,
  jobs: DeleteJob[],
  method: string,
  output: BulkDeleteOperationOutput,
  count: number,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs.length, count) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const debug = ctx.rootValues.debug === true;
        if (debug) ctx.io.err(`Deleting object name ${job.name}\n`);
        try {
          const result = await request(
            "DELETE",
            job.suffix,
            job.query,
            job.pathParams,
          );
          if (result.response.ok) output.deleted.push(job.name);
          else
            output.failures.set(
              job.name,
              bucketServiceError(result, "DELETE", method).trimEnd(),
            );
        } catch (error) {
          output.failures.set(job.name, String(error));
        }
        if (!debug) {
          ctx.io.err(
            `${formatBulkProgressLabel(ctx.io, job.name, `Deleted ${output.type}`)}\n`,
          );
          ctx.io.out("\n");
        }
      }
    }),
  );
}

export async function confirmDeletion(
  ctx: CustomCommandContext,
  message: string,
) {
  if (await confirmUnderWrapExceptions(ctx.io, message, false)) return;
  ctx.io.err("Abort: \n");
  throw new Exit(1);
}

export function deletionConcurrency(ctx: CustomCommandContext) {
  const count = Number(ctx.values.parallel_operations_count ?? 10);
  if (count > 0) return count;
  ctx.io.err("ValueError: max_workers must be greater than 0\n");
  throw new Exit(1);
}

type ObjectDeleteOptions = {
  versioned: boolean;
  dryRun: boolean;
  force: boolean;
  bucketName: string;
  objectName?: string;
  prefix?: string;
  delimiter?: string;
  filter?: (name: string) => boolean;
};

export async function deleteBucketObjects(
  ctx: CustomCommandContext,
  request: BucketRequest,
  opts: ObjectDeleteOptions,
) {
  const output = new BulkDeleteOperationOutput();
  const {
    versioned,
    dryRun,
    force,
    bucketName,
    objectName,
    prefix,
    delimiter,
    filter,
  } = opts;
  const count = dryRun ? 0 : deletionConcurrency(ctx);
  let page: string | null = null;
  let firstPage = true;
  do {
    const query: [string, string][] = [];
    if (prefix !== undefined) query.push(["prefix", prefix]);
    const start = versioned ? objectName : page;
    if (start != null) query.push(["start", start]);
    query.push(["limit", String(pageSize)]);
    if (delimiter !== undefined) query.push(["delimiter", delimiter]);
    query.push(["fields", "name"]);
    if (versioned && page !== null) query.push(["page", page]);

    const result = await request(
      "GET",
      versioned ? "/objectversions" : "/o",
      query,
    );
    checkBucketResponse(
      ctx,
      result,
      "GET",
      versioned ? "list_object_versions" : "list_objects",
    );
    const body = JSON.parse(result.raw) as {
      items?: { name: string; versionId: string }[];
      objects?: { name: string; versionId?: string }[];
      nextStartWith?: string;
    };
    const jobs = (versioned ? (body.items ?? []) : (body.objects ?? []))
      .filter(
        ({ name }) =>
          (!objectName || name === objectName) && (!filter || filter(name)),
      )
      .map(({ name, versionId }): DeleteJob => ({
        name: versioned ? `${name},${versionId}` : name,
        suffix: "/o/{objectName}",
        pathParams: { objectName: name },
        query: versioned ? [["versionId", String(versionId)]] : undefined,
      }));
    const nextPage: string | null = versioned
      ? result.response.headers.get("opc-next-page")
      : (body.nextStartWith ?? null);

    if (dryRun) {
      output.deleted.push(...jobs.map(({ name }) => name));
      page = nextPage;
    } else {
      const type = versioned ? "object versions" : "objects";
      if (!force && !filter && jobs.length === 0) {
        if (firstPage) {
          ctx.io.err(`There are no objects to delete in ${bucketName}\n`);
          throw new Exit(0);
        }
        break;
      }
      if (!force && firstPage)
        await confirmDeletion(
          ctx,
          filter
            ? `WARNING: This command will delete all matching ${type} in the bucket. Please use --dry-run to list the objects which would be deleted. Are you sure you wish to continue?`
            : `WARNING: This command will delete at least ${jobs.length} ${type}. Are you sure you wish to continue?`,
        );
      await deletePage(ctx, request, jobs, "delete_object", output, count);
      // The Reference CLI lists the same page again after deleting its contents.
      if (jobs.length === 0) {
        if (!filter) break;
        page = nextPage;
      }
      if (!nextPage) break;
    }
    firstPage = false;
  } while (!dryRun || page);
  return output;
}

type BucketComponent = {
  type: string;
  suffix: string;
  listMethod: string;
  deleteMethod: string;
};

export async function deleteBucketComponent(
  ctx: CustomCommandContext,
  request: BucketRequest,
  component: BucketComponent,
  dryRun: boolean,
) {
  const { type, suffix, listMethod, deleteMethod } = component;
  const output = new BulkDeleteOperationOutput(type);
  const count = dryRun ? 0 : deletionConcurrency(ctx);
  let page: string | null = null;
  do {
    let limit = pageSize;
    const jobs: DeleteJob[] = [];
    do {
      const query: [string, string][] = [["limit", String(limit)]];
      if (page) query.push(["page", page]);
      const result = await request("GET", suffix, query);
      checkBucketResponse(ctx, result, "GET", listMethod);
      const items = JSON.parse(result.raw) as {
        name: string;
        id: string;
        object: string;
        uploadId: string;
      }[];
      for (const item of items) {
        const upload = type === "multipart-upload";
        jobs.push({
          name: upload ? item.object : item.name,
          suffix: suffix + "/{id}",
          pathParams: { id: upload ? item.object : item.id },
          query: upload ? [["uploadId", item.uploadId]] : undefined,
        });
      }
      page = result.response.headers.get("opc-next-page");
      limit -= items.length;
    } while (!dryRun && page && limit > 0);
    if (dryRun) output.deleted.push(...jobs.map(({ name }) => name));
    else {
      await deletePage(ctx, request, jobs, deleteMethod, output, count);
      if (!page) break;
      page = null;
    }
  } while (!dryRun || page);
  return output;
}

import { createServiceClient } from "../../core/operation.ts";
import { renderCliData, renderDocument } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { outputOptions } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";
import {
  bucketRequest,
  checkBucketResponse,
  confirmDeletion,
  deleteBucketComponent,
  deleteBucketObjects,
} from "../../lib/os-bulk-delete.ts";
import {
  OBJECT_STORAGE_CLIENT,
  resolveOsNamespace,
  usageError,
} from "./shared.ts";

const replication = {
  type: "replication-policy",
  suffix: "/replicationPolicies",
  listMethod: "list_replication_policies",
  deleteMethod: "delete_replication_policy",
};
const preauth = {
  type: "preauth-request",
  suffix: "/p",
  listMethod: "list_preauthenticated_requests",
  deleteMethod: "delete_preauthenticated_request",
};
const uploads = {
  type: "multipart-upload",
  suffix: "/u",
  listMethod: "list_multipart_uploads",
  deleteMethod: "abort_multipart_upload",
};

export async function runOsBucketDelete(ctx: CustomCommandContext) {
  const { io, values, spec } = ctx;
  const makeClient = () =>
    createServiceClient(io, {
      ...ctx,
      client: spec.clients[OBJECT_STORAGE_CLIENT] as Record<string, unknown>,
    });
  let client;
  const namespace =
    (values.namespace_name as string | undefined) ??
    (await resolveOsNamespace(
      io,
      (client = await makeClient()),
      ctx.usageText,
      "namespace-name",
    ));
  const bucketName = String(values.bucket_name);
  const dryRun = values.dry_run === true;
  const empty = values.empty === true;
  if (dryRun && !empty)
    usageError(
      io,
      "The option --dry-run is applicable only when the --empty option is specified",
    );
  if (values.force !== true && !dryRun) {
    await confirmDeletion(
      ctx,
      empty
        ? "This command will delete the bucket as well as all replication policies, pre-authenticated requests, objects and uncommitted multipart uploads associated with it. Are you sure you wish to continue?"
        : "Are you sure you want to delete this bucket?",
    );
  }
  if (!bucketName.trim())
    usageError(
      io,
      "Parameter --bucket-name cannot be whitespace or empty string",
    );

  const request = bucketRequest(
    ctx,
    client ?? (await makeClient()),
    namespace,
    bucketName,
  );
  if (empty) {
    const result = await request("GET");
    checkBucketResponse(ctx, result, "GET", "get_bucket");
    const { versioning } = JSON.parse(result.raw);
    if (typeof versioning !== "string") {
      io.err("AttributeError: 'NoneType' object has no attribute 'lower'\n");
      throw new Exit(1);
    }
    const output = [
      await deleteBucketComponent(ctx, request, replication, dryRun),
      await deleteBucketComponent(ctx, request, preauth, dryRun),
      await deleteBucketObjects(ctx, request, {
        versioned: versioning.toLowerCase() !== "disabled",
        dryRun,
        force: true,
        bucketName,
      }),
      await deleteBucketComponent(ctx, request, uploads, dryRun),
    ];
    const options = outputOptions(ctx);
    const data =
      options.output === "table"
        ? output.flatMap((part) => part.rows(dryRun))
        : Object.fromEntries(output.map((part) => [part.type, part.json()]));
    renderDocument(io, data, options);
    if (dryRun) return;
    if (output.some((part) => part.failures.size)) throw new Exit(1);
  }
  const ifMatch = values.if_match as string | undefined;
  const result = await request(
    "DELETE",
    "",
    [],
    {},
    ifMatch === undefined ? {} : { "if-match": ifMatch },
  );
  checkBucketResponse(ctx, result, "DELETE", "delete_bucket");
  renderCliData(io, null, result.response.headers, outputOptions(ctx));
}

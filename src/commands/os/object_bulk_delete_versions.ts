import { createServiceClient } from "../../core/operation.ts";
import { renderDocument } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { outputOptions } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";
import {
  bucketRequest,
  deleteBucketObjects,
} from "../../lib/os-bulk-delete.ts";
import {
  buildBulkDownloadFilter,
  normalizeStringArray,
  OBJECT_STORAGE_CLIENT,
  pyPathJoin,
  resolveOsNamespace,
  usageError,
} from "./shared.ts";

export async function runOsObjectBulkDeleteVersions(ctx: CustomCommandContext) {
  const { io, values, spec } = ctx;
  const client = await createServiceClient(io, {
    ...ctx,
    client: spec.clients[OBJECT_STORAGE_CLIENT] as Record<string, unknown>,
  });
  const namespace =
    (values.namespace as string | undefined) ??
    (await resolveOsNamespace(io, client, ctx.usageText));
  const bucketName = String(values.bucket_name);
  const objectName = values.object_name as string | undefined;
  const prefix = values.prefix as string | undefined;
  const include = normalizeStringArray(values.include);
  const exclude = normalizeStringArray(values.exclude);
  const filtered = include.length > 0 || exclude.length > 0;
  if (include.length && exclude.length)
    usageError(
      io,
      "The --include and --exclude parameters cannot both be provided",
    );
  if (objectName && (prefix || filtered))
    usageError(
      io,
      "The --object-name parameter cannot be combined with either --prefix or --include or --exclude",
    );

  const dryRun = values.dry_run === true;
  const matches = buildBulkDownloadFilter(bucketName, include, exclude, prefix);
  const output = await deleteBucketObjects(
    ctx,
    bucketRequest(ctx, client, namespace, bucketName),
    {
      versioned: true,
      dryRun,
      force: values.force === true,
      bucketName,
      objectName,
      prefix,
      delimiter: values.delimiter as string | undefined,
      filter: filtered
        ? (name) => matches(pyPathJoin(bucketName, name))
        : undefined,
    },
  );
  const options = outputOptions(ctx);
  renderDocument(
    io,
    options.output === "table" ? output.rows(dryRun) : output.json(),
    options,
  );
  if (output.failures.size) throw new Exit(1);
}

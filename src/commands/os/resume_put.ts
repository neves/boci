// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import { closeSync, openSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Exit, type Invocation } from "../../lib/io.ts";
import {
  createServiceClient,
  sendServiceRequest,
} from "../../core/operation.ts";
import { formatServiceError } from "../../core/output.ts";

import {
  DEFAULT_PARALLEL_UPLOAD_COUNT,
  MEBIBYTE,
  OBJECT_STORAGE_CLIENT,
  type OsObjectPutOptions,
  buildMultipartPutParts,
  pyFloatRepr,
  readPartFromFile,
  renderObjectPutHeaders,
  resolveMultipartPartSize,
  resolveOsNamespace,
  stripQuery,
  usageError,
} from "./shared.ts";
export async function runOsObjectResumePut(
  io: Invocation,
  opts: OsObjectPutOptions,
): Promise<void> {
  const {
    values,
    rootValues,
    settings,
    spec,
    index,
    usageText,
    outputOptions,
  } = opts;
  const client = spec.clients[OBJECT_STORAGE_CLIENT] as Record<string, unknown>;
  const sc = await createServiceClient(io, {
    client,
    values,
    rootValues,
    settings,
    index,
  });

  const namespace =
    typeof values.namespace === "string" && values.namespace.length > 0
      ? values.namespace
      : await resolveOsNamespace(io, sc, usageText, "namespace");
  const bucketName = String(values.bucket_name);
  const filePath = String(values.file);
  const uploadId = String(values.upload_id);
  const disableParallelUploads = values.disable_parallel_uploads === true;
  const parallelUploadCount =
    typeof values.parallel_upload_count === "number"
      ? values.parallel_upload_count
      : undefined;
  const partSizeMib =
    typeof values.part_size === "number" ? values.part_size : undefined;

  if (filePath === "-") {
    usageError(io, "Stdin is not supported by resume-put");
  }
  if (parallelUploadCount !== undefined && disableParallelUploads) {
    usageError(
      io,
      "The option --parallel-upload-count is not applicable when using the --disable-parallel-uploads flag.",
    );
  }

  const objectName =
    typeof values.name === "string" && values.name.length > 0
      ? values.name
      : basename(filePath);
  const pathParams = {
    namespaceName: namespace,
    bucketName,
    objectName,
  };

  const resolvedFilePath = resolve(io.cwd, filePath);
  const totalSize = statSync(resolvedFilePath).size;
  if (totalSize === 0) return;

  const { partSizeBytes } = resolveMultipartPartSize(totalSize, partSizeMib);
  const parts = buildMultipartPutParts(totalSize, partSizeBytes);

  io.err("Uploading object\n");

  type UploadedPartSummary = {
    partNumber?: number;
    etag?: string;
    md5?: string;
    size?: number;
  };
  const uploadedParts: UploadedPartSummary[] = [];
  let nextPage: string | null = null;
  do {
    const queryParams: [string, string][] = [["uploadId", uploadId]];
    if (nextPage !== null) queryParams.push(["page", nextPage]);
    const listRes = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
      pathParams,
      queryParams,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    if (!listRes.response.ok) {
      io.err(
        formatServiceError(
          { http: "GET", method: "list_multipart_upload_parts" },
          stripQuery(listRes.url),
          listRes.response,
          listRes.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }
    const pageItems = JSON.parse(listRes.raw) as UploadedPartSummary[];
    if (Array.isArray(pageItems)) {
      uploadedParts.push(...pageItems);
    }
    nextPage = listRes.response.headers.get("opc-next-page");
  } while (nextPage);

  if (uploadedParts.length > parts.length) {
    io.err(
      "ValueError: There are more parts on the server than parts to resume, please check the upload ID.\n",
    );
    throw new Exit(1);
  }

  const partResults: ({ partNum: number; etag: string } | undefined)[] =
    new Array(parts.length);
  for (const up of uploadedParts) {
    const partNum = up.partNumber;
    if (typeof partNum !== "number" || partNum < 1 || partNum > parts.length) {
      io.err(
        "ValueError: There are more parts on the server than parts to resume, please check the upload ID.\n",
      );
      throw new Exit(1);
    }
    const idx = partNum - 1;
    const expected = parts[idx];
    if (expected && typeof up.size === "number" && up.size !== expected.size) {
      io.err(
        `ValueError: Cannot resume upload with different part size. Parts were uploaded with a part size of ${pyFloatRepr(up.size / MEBIBYTE)} MiB\n`,
      );
      throw new Exit(1);
    }
    partResults[idx] = {
      partNum,
      etag: typeof up.etag === "string" ? up.etag : "",
    };
  }

  const pendingIndices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (partResults[i] === undefined) pendingIndices.push(i);
  }

  let firstError: string | undefined;
  if (pendingIndices.length > 0) {
    let nextPos = 0;
    const fd = openSync(resolvedFilePath, "r");
    try {
      const workerCount = disableParallelUploads
        ? 1
        : Math.max(
            1,
            Math.min(
              parallelUploadCount ?? DEFAULT_PARALLEL_UPLOAD_COUNT,
              pendingIndices.length,
            ),
          );
      const workers = Array.from({ length: workerCount }, async () => {
        while (firstError === undefined) {
          const pos = nextPos++;
          const idx = pendingIndices[pos];
          if (idx === undefined) break;
          const part = parts[idx];
          if (!part) break;
          const partBytes = readPartFromFile(fd, part.offset, part.size);
          const partRes = await sendServiceRequest(io, sc, {
            method: "PUT",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
            pathParams,
            queryParams: [
              ["uploadId", uploadId],
              ["uploadPartNum", String(part.partNum)],
            ],
            headers: {
              accept: "application/json",
              "content-type": "application/octet-stream",
              expect: "100-continue",
            },
            body: partBytes,
            enforceContentHeaders: false,
          });
          if (!partRes.response.ok) {
            if (firstError === undefined) {
              firstError = formatServiceError(
                { http: "PUT", method: "upload_part" },
                stripQuery(partRes.url),
                partRes.response,
                partRes.raw,
                sc.targetService,
              );
            }
            return;
          }
          partResults[idx] = {
            partNum: part.partNum,
            etag: partRes.response.headers.get("etag") ?? "",
          };
        }
      });
      await Promise.all(workers);
    } finally {
      closeSync(fd);
    }
  }

  if (firstError !== undefined) {
    io.err(firstError);
    throw new Exit(1);
  }

  const partsToCommit: { partNum: number; etag: string }[] = [];
  const partsToExclude: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const r = partResults[i];
    if (r) {
      partsToCommit.push({ partNum: r.partNum, etag: r.etag });
    } else {
      partsToExclude.push(i + 1);
    }
  }

  const commitRes = await sendServiceRequest(io, sc, {
    method: "POST",
    pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
    pathParams,
    queryParams: [["uploadId", uploadId]],
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ partsToCommit, partsToExclude }),
  });
  if (!commitRes.response.ok) {
    io.err(
      formatServiceError(
        { http: "POST", method: "commit_multipart_upload" },
        stripQuery(commitRes.url),
        commitRes.response,
        commitRes.raw,
        sc.targetService,
      ),
    );
    throw new Exit(1);
  }

  renderObjectPutHeaders(io, commitRes.response.headers, outputOptions);
}

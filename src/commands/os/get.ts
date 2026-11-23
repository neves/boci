// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";
import { expandUser } from "../../core/config.ts";
import {
  type OutputFileHandle,
  openClickFileForWrite,
} from "../../core/click-file.ts";
import { Exit, type Invocation } from "../../lib/io.ts";
import { parseJsonParameter } from "../../core/json-input.ts";
import {
  type ClientSettings,
  type ServiceClient,
  createServiceClient,
  sendServiceRequest,
} from "../../core/operation.ts";
import {
  type OutputOptions,
  formatServiceError,
  renderDocument,
} from "../../core/output.ts";
import { expandVars } from "../../core/rc.ts";
import type { Index, ServiceSpec } from "../../core/spec.ts";

import {
  BULK_PUT_DISPLAY_HEADERS,
  type BottomUpDirEntry,
  CRC32C_TABLE,
  DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB,
  DEFAULT_PARALLEL_DELETE_COUNT,
  DEFAULT_PARALLEL_DOWNLOAD_COUNT,
  DEFAULT_PARALLEL_UPLOAD_COUNT,
  DEFAULT_PART_SIZE_BYTES,
  type ListedObject,
  MAX_MULTIPART_PARTS,
  MEBIBYTE,
  MULTIPART_UPLOAD_ERROR_MESSAGE,
  OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS,
  OBJECT_PUT_DISPLAY_HEADERS,
  OBJECT_STORAGE_CLIENT,
  OCTET_STREAM_EXTENSIONS,
  type OsObjectGetOptions,
  type OsObjectPutOptions,
  PROGRESS_BAR_GRANULARITY,
  SSE_ALGORITHM,
  STREAMING_DEFAULT_PART_SIZE_BYTES,
  type SyncWalkEntry,
  type WalkEntry,
  buildBulkDownloadFilter,
  buildMultipartGetRanges,
  buildMultipartPutParts,
  computeCrc32cBase64,
  computeMultipartMd5,
  computePartChecksum,
  confirmPrompt,
  confirmPromptWithReader,
  createChunkWriter,
  createLineReader,
  createNonTtyProgressTracker,
  filterBulkPutHeaders,
  fnmatchToRegex,
  formatBulkProgressLabel,
  guessContentType,
  guessContentTypeOptional,
  normalizeStringArray,
  parseIsoTimeTruncatedToSeconds,
  promptOverwriteChoice,
  pyDirname,
  pyFloatRepr,
  pyPathJoin,
  readEncryptionKeyHeaders,
  readPartFromFile,
  readResponseBytes,
  readStdinParts,
  renderBulkDeleteOutput,
  renderObjectPutHeaders,
  requiresSync,
  resolveMultipartPartSize,
  resolveOsNamespace,
  stripQuery,
  usageError,
  walkDirectoryBottomUpForDelete,
  walkDirectoryForBulkUpload,
  walkDirectoryForSyncUpload,
  writeAllToFd,
} from "./shared.ts";
export async function runOsObjectGet(
  io: Invocation,
  opts: OsObjectGetOptions,
): Promise<void> {
  const { values, rootValues, settings, spec, index, usageText } = opts;
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
  const objectName = String(values.name);
  const ownedOutputFile = opts.outputFile === undefined;
  const outputFile =
    opts.outputFile ?? openClickFileForWrite(io, String(values.file));
  try {
    const sseHeaders =
      typeof values.encryption_key_file === "string"
        ? readEncryptionKeyHeaders(io, values.encryption_key_file)
        : {};

    const pathParams = {
      namespaceName: namespace,
      bucketName,
      objectName,
    };

    // 1. HEAD object to check existence and size.
    const headQuery: [string, string][] = [];
    if (typeof values.version_id === "string")
      headQuery.push(["versionId", values.version_id]);
    const head = await sendServiceRequest(io, sc, {
      method: "HEAD",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
      pathParams,
      queryParams: headQuery,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...sseHeaders,
      },
    });
    if (!head.response.ok) {
      io.err(
        formatServiceError(
          { http: "HEAD", method: "head_object" },
          head.url,
          head.response,
          head.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }

    const contentLengthHeader = head.response.headers.get("content-length");
    const objectSizeBytes =
      contentLengthHeader !== null
        ? Number.parseInt(contentLengthHeader, 10) || 0
        : 0;
    const partSizeBytes =
      typeof values.part_size === "number"
        ? values.part_size * MEBIBYTE
        : DEFAULT_PART_SIZE_BYTES;
    const multipartDownloadThreshold =
      typeof values.multipart_download_threshold === "number"
        ? values.multipart_download_threshold
        : DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB;
    const parallelDownloadCount =
      typeof values.parallel_download_count === "number"
        ? values.parallel_download_count
        : DEFAULT_PARALLEL_DOWNLOAD_COUNT;
    const noMultipart = values.no_multipart === true;
    const hasRange =
      typeof values.range === "string" && values.range.length > 0;
    const useSinglePart =
      hasRange ||
      noMultipart ||
      (multipartDownloadThreshold > 0 && partSizeBytes >= objectSizeBytes) ||
      objectSizeBytes <= multipartDownloadThreshold;

    const writeChunk = createChunkWriter(io, outputFile);
    const progress = createNonTtyProgressTracker(
      io,
      objectSizeBytes,
      "Downloading object",
      !outputFile.isStdout,
    );

    if (useSinglePart) {
      // 2a. Single-part GET object.
      const getQuery: [string, string][] = [];
      if (typeof values.version_id === "string")
        getQuery.push(["versionId", values.version_id]);
      const responseHeaderQueryMap: [string, string][] = [
        ["http_response_content_disposition", "httpResponseContentDisposition"],
        ["http_response_cache_control", "httpResponseCacheControl"],
        ["http_response_content_type", "httpResponseContentType"],
        ["http_response_content_language", "httpResponseContentLanguage"],
        ["http_response_content_encoding", "httpResponseContentEncoding"],
        ["http_response_expires", "httpResponseExpires"],
      ];
      for (const [paramKey, queryName] of responseHeaderQueryMap) {
        if (typeof values[paramKey] === "string")
          getQuery.push([queryName, values[paramKey] as string]);
      }

      const getHeaders: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json",
        ...sseHeaders,
      };
      if (typeof values.if_match === "string")
        getHeaders["if-match"] = values.if_match;
      if (typeof values.if_none_match === "string")
        getHeaders["if-none-match"] = values.if_none_match;
      if (typeof values.range === "string") getHeaders.range = values.range;

      const get = await sendServiceRequest(io, sc, {
        method: "GET",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
        pathParams,
        queryParams: getQuery,
        headers: getHeaders,
        rawResponse: true,
        decompress: false,
      });
      if (!get.response.ok) {
        io.err(
          formatServiceError(
            { http: "GET", method: "get_object" },
            get.url,
            get.response,
            get.raw,
            sc.targetService,
          ),
        );
        throw new Exit(1);
      }

      if (get.response.body) {
        const reader = get.response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              progress.update(value.length);
              writeChunk.write(value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        const bytes = new Uint8Array(await get.response.arrayBuffer());
        if (bytes.length > 0) {
          progress.update(bytes.length);
          writeChunk.write(bytes);
        }
      }
      writeChunk.finish();
      return;
    }

    // 2b. Multipart ranged GET object (mirrors GetObjectMultipartTask).
    const ranges = buildMultipartGetRanges(objectSizeBytes, partSizeBytes);
    const multipartQuery: [string, string][] = [];
    if (typeof values.version_id === "string")
      multipartQuery.push(["versionId", values.version_id]);

    const baseHeaders: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      ...sseHeaders,
    };
    if (typeof values.if_match === "string")
      baseHeaders["if-match"] = values.if_match;
    if (typeof values.if_none_match === "string")
      baseHeaders["if-none-match"] = values.if_none_match;

    const reportProgress = !outputFile.isStdout && rootValues.debug !== true;
    if (reportProgress) progress.update(1);

    const pendingWrites = new Map<number, Uint8Array>();
    let nextWritePos = 0;
    const errors: string[] = [];
    let nextPartPos = 0;

    const flushPendingWrites = () => {
      while (nextWritePos < ranges.length) {
        const expected = ranges[nextWritePos];
        if (!expected || !pendingWrites.has(expected.index)) break;
        const data = pendingWrites.get(expected.index) as Uint8Array;
        pendingWrites.delete(expected.index);
        if (data.length > 0) writeChunk.write(data);
        nextWritePos += 1;
      }
    };

    const workerCount = Math.max(
      1,
      Math.min(parallelDownloadCount, ranges.length),
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (errors.length === 0) {
        const pos = nextPartPos;
        if (pos >= ranges.length) break;
        nextPartPos += 1;
        const part = ranges[pos];
        if (!part) break;
        try {
          const res = await sendServiceRequest(io, sc, {
            method: "GET",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
            pathParams,
            queryParams: multipartQuery,
            headers: {
              ...baseHeaders,
              range: part.range,
            },
            rawResponse: true,
            decompress: false,
          });
          if (!res.response.ok) {
            errors.push(
              formatServiceError(
                { http: "GET", method: "get_object" },
                res.url,
                res.response,
                res.raw,
                sc.targetService,
              ).trimEnd(),
            );
            return;
          }
          const bytes = await readResponseBytes(
            res.response,
            reportProgress ? (n) => progress.update(n) : undefined,
          );
          if (errors.length > 0) return;
          pendingWrites.set(part.index, bytes);
          flushPendingWrites();
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
          return;
        }
      }
    });

    await Promise.all(workers);
    if (errors.length > 0) {
      io.err(`RuntimeError: Error downloading parts: ${errors.join("\n")}\n`);
      throw new Exit(1);
    }
    flushPendingWrites();
    writeChunk.finish();
  } finally {
    if (ownedOutputFile && outputFile.fd !== undefined) {
      try {
        closeSync(outputFile.fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
  }
}

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
  downloadSinglePartToFile as downloadSinglePartToFileShared,
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
type SyncDownloadTransferContext = {
  io: Invocation;
  sc: ServiceClient;
  namespace: string;
  bucketName: string;
  sseHeaders: Record<string, string>;
  partSizeBytes: number;
  parallelOperationsCount: number;
  multipartDownloadThreshold: number;
  debug: boolean;
};

export function createSyncDownloadTransferHelpers(
  ctx: SyncDownloadTransferContext,
) {
  const {
    io,
    sc,
    namespace,
    bucketName,
    sseHeaders,
    partSizeBytes,
    parallelOperationsCount,
    multipartDownloadThreshold,
    debug,
  } = ctx;
  const downloadSinglePartToFile = (
    objectName: string,
    resolvedFilePath: string,
  ): Promise<void> =>
    downloadSinglePartToFileShared(
      io,
      sc,
      namespace,
      bucketName,
      sseHeaders,
      objectName,
      resolvedFilePath,
    );

  const downloadMultipartToFile = async (
    objectName: string,
    objectSize: number | undefined,
    resolvedFilePath: string,
  ): Promise<void> => {
    const pathParams = { namespaceName: namespace, bucketName, objectName };
    const fd = openSync(resolvedFilePath, "w");
    let printedPartLabel = false;
    const emitPartProgress = () => {
      if (!debug && !printedPartLabel) {
        printedPartLabel = true;
        io.err(
          `${formatBulkProgressLabel(io, objectName, "Downloading part for")}\n`,
        );
      }
    };

    try {
      let contentLength: number;
      if (objectSize !== undefined && objectSize > 0) {
        contentLength = objectSize;
      } else {
        const headRes = await sendServiceRequest(io, sc, {
          method: "HEAD",
          pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
          pathParams,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...sseHeaders,
          },
        });
        if (headRes.response.status === 404) {
          throw new Error("Cannot download object as it does not exist");
        }
        if (!headRes.response.ok) {
          throw new Error(
            formatServiceError(
              { http: "HEAD", method: "head_object" },
              stripQuery(headRes.url),
              headRes.response,
              headRes.raw,
              sc.targetService,
            ).trimEnd(),
          );
        }
        contentLength =
          Number.parseInt(
            headRes.response.headers.get("content-length") ?? "0",
            10,
          ) || 0;
        emitPartProgress();
      }

      if (contentLength <= multipartDownloadThreshold) {
        const getRes = await sendServiceRequest(io, sc, {
          method: "GET",
          pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
          pathParams,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...sseHeaders,
          },
          rawResponse: true,
          decompress: false,
        });
        if (!getRes.response.ok) {
          throw new Error(
            formatServiceError(
              { http: "GET", method: "get_object" },
              stripQuery(getRes.url),
              getRes.response,
              getRes.raw,
              sc.targetService,
            ).trimEnd(),
          );
        }
        if (getRes.response.body) {
          const reader = getRes.response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.length > 0) writeAllToFd(fd, value);
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          const bytes = new Uint8Array(await getRes.response.arrayBuffer());
          if (bytes.length > 0) writeAllToFd(fd, bytes);
        }
        return;
      }

      const ranges = buildMultipartGetRanges(contentLength, partSizeBytes);
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
          if (data.length > 0) writeAllToFd(fd, data);
          nextWritePos += 1;
        }
      };

      const workerCount = Math.max(
        1,
        Math.min(parallelOperationsCount, ranges.length),
      );
      const workers = Array.from({ length: workerCount }, async () => {
        while (errors.length === 0) {
          const pos = nextPartPos++;
          const part = ranges[pos];
          if (!part) break;
          try {
            const res = await sendServiceRequest(io, sc, {
              method: "GET",
              pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
              pathParams,
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                ...sseHeaders,
                range: part.range,
              },
              rawResponse: true,
              decompress: false,
            });
            if (!res.response.ok) {
              errors.push(
                formatServiceError(
                  { http: "GET", method: "get_object" },
                  stripQuery(res.url),
                  res.response,
                  res.raw,
                  sc.targetService,
                ).trimEnd(),
              );
              return;
            }
            const bytes = await readResponseBytes(res.response, () => {
              emitPartProgress();
            });
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
        throw new Error(`Error downloading parts: ${errors.join("\n")}`);
      }
      flushPendingWrites();
    } finally {
      closeSync(fd);
    }
  };

  return { downloadSinglePartToFile, downloadMultipartToFile };
}

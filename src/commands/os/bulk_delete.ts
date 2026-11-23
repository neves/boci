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
export async function runOsObjectBulkDelete(
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
  const prefix = typeof values.prefix === "string" ? values.prefix : undefined;
  const delimiter =
    typeof values.delimiter === "string" ? values.delimiter : undefined;
  const include = normalizeStringArray(values.include);
  const exclude = normalizeStringArray(values.exclude);
  const dryRun = values.dry_run === true;
  const force = values.force === true;
  const parallelOperationsCount = Math.max(
    1,
    typeof values.parallel_operations_count === "number"
      ? values.parallel_operations_count
      : DEFAULT_PARALLEL_DELETE_COUNT,
  );
  const debug = rootValues.debug === true;

  if (include.length > 0 && exclude.length > 0) {
    usageError(
      io,
      "The --include and --exclude parameters cannot both be provided",
    );
  }

  const hasFilter = include.length > 0 || exclude.length > 0;
  const shouldInclude = buildBulkDownloadFilter(
    bucketName,
    include,
    exclude,
    prefix,
  );

  const deletedObjects: string[] = [];
  const deleteFailures: Record<string, string> = {};

  const listPage = async (start: string | undefined) => {
    const queryParams: [string, string][] = [];
    if (prefix !== undefined) queryParams.push(["prefix", prefix]);
    if (start !== undefined) queryParams.push(["start", start]);
    queryParams.push(["limit", String(OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS)]);
    if (delimiter !== undefined) queryParams.push(["delimiter", delimiter]);
    queryParams.push(["fields", "name"]);

    const listRes = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/o",
      pathParams: { namespaceName: namespace, bucketName },
      queryParams,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    if (!listRes.response.ok) {
      io.err(
        formatServiceError(
          { http: "GET", method: "list_objects" },
          stripQuery(listRes.url),
          listRes.response,
          listRes.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }

    const body = JSON.parse(listRes.raw) as {
      objects?: ListedObject[];
      nextStartWith?: string | null;
    };
    return {
      objects: Array.isArray(body.objects) ? body.objects : [],
      nextStartWith:
        typeof body.nextStartWith === "string" && body.nextStartWith.length > 0
          ? body.nextStartWith
          : undefined,
    };
  };

  if (dryRun) {
    let nextStart: string | undefined;
    while (true) {
      const page = await listPage(nextStart);
      for (const obj of page.objects) {
        const objectName = String(obj.name ?? "");
        if (hasFilter && !shouldInclude(pyPathJoin(bucketName, objectName))) {
          continue;
        }
        deletedObjects.push(objectName);
      }
      if (page.nextStartWith === undefined) break;
      nextStart = page.nextStartWith;
    }
    renderBulkDeleteOutput(
      io,
      deletedObjects,
      deleteFailures,
      outputOptions,
      true,
    );
    return;
  }

  const readLine = createLineReader(io);
  const deleteOneObject = async (objectName: string): Promise<void> => {
    try {
      if (debug) io.err(`Deleting object name ${objectName}\n`);
      const delRes = await sendServiceRequest(io, sc, {
        method: "DELETE",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
        pathParams: { namespaceName: namespace, bucketName, objectName },
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      });
      if (!delRes.response.ok) {
        throw new Error(
          formatServiceError(
            { http: "DELETE", method: "delete_object" },
            stripQuery(delRes.url),
            delRes.response,
            delRes.raw,
            sc.targetService,
          ).trimEnd(),
        );
      }
      deletedObjects.push(objectName);
    } catch (e) {
      deleteFailures[objectName] = e instanceof Error ? e.message : String(e);
      if (debug) io.err(`Failed to delete object name ${objectName} \n`);
    } finally {
      if (debug) {
        io.err(`Deleted object ${objectName}\n`);
      } else {
        io.err(
          `${formatBulkProgressLabel(io, objectName, "Deleted object")}\n`,
        );
        io.out("\n");
      }
    }
  };

  let currPage: string | undefined;
  let firstPage = true;
  while (true) {
    const page = await listPage(currPage);
    const nextPage = page.nextStartWith;
    const objectsToDelete: string[] = [];

    for (const obj of page.objects) {
      const objectName = String(obj.name ?? "");
      if (hasFilter && !shouldInclude(pyPathJoin(bucketName, objectName))) {
        continue;
      }
      objectsToDelete.push(objectName);
    }

    if (!force) {
      let confirmPrompt: string;
      if (hasFilter) {
        confirmPrompt =
          "WARNING: This command will delete all matching objects in the bucket. Please use --dry-run to list the objects which would be deleted. Are you sure you wish to continue?";
      } else {
        if (objectsToDelete.length === 0) {
          if (firstPage) {
            io.err(`There are no objects to delete in ${bucketName}\n`);
            return;
          }
          break;
        }
        confirmPrompt = `WARNING: This command will delete at least ${objectsToDelete.length} objects. Are you sure you wish to continue?`;
      }
      if (firstPage) {
        const confirmed = await confirmPromptWithReader(
          io,
          readLine,
          confirmPrompt,
        );
        if (!confirmed) {
          io.err("Abort: \n");
          throw new Exit(1);
        }
      }
    }

    const inFlight = new Set<Promise<void>>();
    for (const objectName of objectsToDelete) {
      const p = deleteOneObject(objectName);
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
      if (inFlight.size >= parallelOperationsCount) {
        await Promise.race(inFlight);
      }
    }
    await Promise.all(inFlight);

    if (objectsToDelete.length === 0) {
      if (hasFilter) {
        currPage = nextPage;
      } else {
        break;
      }
    }

    if (nextPage === undefined) break;
    firstPage = false;
  }

  renderBulkDeleteOutput(
    io,
    deletedObjects,
    deleteFailures,
    outputOptions,
    false,
  );

  if (Object.keys(deleteFailures).length > 0) {
    throw new Exit(1);
  }
}

/** Parses an ISO-8601 timestamp and truncates sub-second precision, matching Python's `.replace(microsecond=0)`. */

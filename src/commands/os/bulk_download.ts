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
export async function runOsObjectBulkDownload(
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
  const destDir = String(values.download_dir);
  const prefix = typeof values.prefix === "string" ? values.prefix : undefined;
  const delimiter =
    typeof values.delimiter === "string" ? values.delimiter : undefined;
  const include = normalizeStringArray(values.include);
  const exclude = normalizeStringArray(values.exclude);
  let overwrite = values.overwrite === true;
  const noOverwrite = values.no_overwrite === true;
  const noMultipart = values.no_multipart === true;
  const dryRun = values.dry_run === true;
  const partSizeMib =
    typeof values.part_size === "number" ? values.part_size : 128;
  const partSizeBytes = partSizeMib * MEBIBYTE;
  const multipartDownloadThreshold =
    typeof values.multipart_download_threshold === "number"
      ? values.multipart_download_threshold
      : DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB;
  const parallelOperationsCount =
    typeof values.parallel_operations_count === "number"
      ? values.parallel_operations_count
      : DEFAULT_PARALLEL_DOWNLOAD_COUNT;
  const debug = rootValues.debug === true;

  if (include.length > 0 && exclude.length > 0) {
    usageError(
      io,
      "The --include and --exclude parameters cannot both be provided.",
    );
  }
  if (overwrite && noOverwrite) {
    usageError(
      io,
      "The options --overwrite and --no-overwrite cannot be used together.",
    );
  }

  const expandedDirectory = expandVars(expandUser(destDir, io.env), io.env);
  const resolvedDestDir = resolve(io.cwd, expandedDirectory);
  if (!existsSync(resolvedDestDir)) {
    mkdirSync(resolvedDestDir, { recursive: true });
  } else {
    try {
      accessSync(resolvedDestDir, fsConstants.W_OK);
    } catch {
      usageError(
        io,
        `The specified --dest-dir ${destDir} (expanded to: ${expandedDirectory}) does not have write permissions`,
      );
    }
  }

  const sseHeaders =
    typeof values.encryption_key_file === "string"
      ? readEncryptionKeyHeaders(io, values.encryption_key_file)
      : {};

  const shouldInclude = buildBulkDownloadFilter(
    expandedDirectory,
    include,
    exclude,
    prefix,
  );

  const downloadedObjects: string[] = [];
  const downloadFailures: Record<string, string> = {};
  const skippedObjects: string[] = [];

  const readLine = createLineReader(io);
  const inFlight = new Set<Promise<void>>();

  const downloadSinglePartToFile = async (
    objectName: string,
    resolvedFilePath: string,
  ): Promise<void> => {
    const getRes = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
      pathParams: { namespaceName: namespace, bucketName, objectName },
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

    let fd: number;
    try {
      fd = openSync(resolvedFilePath, "w");
    } catch (e) {
      const err = e as NodeJS.ErrnoException | null;
      if (
        err?.code === "EISDIR" ||
        (err?.code === "EACCES" &&
          existsSync(resolvedFilePath) &&
          statSync(resolvedFilePath).isDirectory())
      ) {
        await readResponseBytes(getRes.response);
        return;
      }
      throw e;
    }

    try {
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
    } finally {
      closeSync(fd);
    }
  };

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

  const downloadOneObject = async (task: {
    objectName: string;
    objectSize: number | undefined;
    fullFilePath: string;
    resolvedFilePath: string;
  }) => {
    const { objectName, objectSize, fullFilePath, resolvedFilePath } = task;
    try {
      if (debug) io.err(`Downloading ${objectName} to ${fullFilePath}\n`);
      const useSinglePart =
        noMultipart ||
        (multipartDownloadThreshold > 0 &&
          objectSize !== undefined &&
          partSizeBytes >= objectSize);
      if (useSinglePart) {
        await downloadSinglePartToFile(objectName, resolvedFilePath);
      } else {
        await downloadMultipartToFile(objectName, objectSize, resolvedFilePath);
      }
      downloadedObjects.push(objectName);
    } catch (e) {
      downloadFailures[objectName] = e instanceof Error ? e.message : String(e);
      if (debug) io.err(`Failed to download ${objectName}\n`);
    } finally {
      if (debug) {
        io.err(`Downloaded ${objectName}\n`);
      } else {
        io.err(`${formatBulkProgressLabel(io, objectName, "Downloaded")}\n`);
        io.out("\n");
      }
    }
  };

  let nextStart: string | undefined;
  let keepPaginating = true;
  let askOverwrite = !(overwrite || noOverwrite || dryRun);

  while (keepPaginating) {
    const queryParams: [string, string][] = [];
    if (prefix !== undefined) queryParams.push(["prefix", prefix]);
    if (nextStart !== undefined) queryParams.push(["start", nextStart]);
    queryParams.push(["limit", String(OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS)]);
    if (delimiter !== undefined) queryParams.push(["delimiter", delimiter]);
    queryParams.push(["fields", "name,size,timeModified,archivalState"]);

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
    const pageObjects = Array.isArray(body.objects) ? body.objects : [];
    const pageNextStart =
      typeof body.nextStartWith === "string" ? body.nextStartWith : undefined;

    if (pageNextStart !== undefined && askOverwrite) {
      if (
        await confirmPromptWithReader(
          io,
          readLine,
          `You are downloading more than ${OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS} objects, do you want to overwrite all?`,
        )
      ) {
        overwrite = true;
      }
      askOverwrite = false;
    }

    const toDownload: {
      objectName: string;
      objectSize: number | undefined;
      fullFilePath: string;
      resolvedFilePath: string;
    }[] = [];

    for (const obj of pageObjects) {
      const rawName = String(obj.name ?? "");
      let relativeName = rawName;
      if (relativeName.startsWith("/")) relativeName = relativeName.slice(1);
      const fullFilePath = pyPathJoin(expandedDirectory, relativeName);
      if (!shouldInclude(fullFilePath)) continue;

      const resolvedFilePath = resolve(io.cwd, fullFilePath);
      if (existsSync(resolvedFilePath)) {
        if (statSync(resolvedFilePath).isDirectory()) {
          skippedObjects.push(rawName);
          continue;
        }
        if (!overwrite && noOverwrite) {
          skippedObjects.push(rawName);
          continue;
        }
        if (!overwrite && !dryRun) {
          const choice = await promptOverwriteChoice(
            io,
            readLine,
            relativeName,
          );
          if (choice === "N") {
            skippedObjects.push(rawName);
            continue;
          }
          if (choice === "A") {
            overwrite = true;
          }
        }
      }

      const objectSize =
        typeof obj.size === "number" && Number.isFinite(obj.size)
          ? obj.size
          : undefined;
      toDownload.push({
        objectName: rawName,
        objectSize,
        fullFilePath,
        resolvedFilePath,
      });
    }

    if (dryRun) {
      for (const obj of toDownload) {
        io.out(`${obj.objectName}\n`);
      }
    } else {
      for (const obj of toDownload) {
        const dirForFile = pyDirname(obj.fullFilePath);
        if (dirForFile) {
          const resolvedDirForFile = resolve(io.cwd, dirForFile);
          if (!existsSync(resolvedDirForFile)) {
            mkdirSync(resolvedDirForFile, { recursive: true });
          }
        }
        const p = downloadOneObject(obj);
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
        if (inFlight.size >= parallelOperationsCount) {
          await Promise.race(inFlight);
        }
      }
    }

    nextStart = pageNextStart;
    keepPaginating = pageNextStart !== undefined;
  }

  if (dryRun) return;

  await Promise.all(inFlight);

  const outputFormat = outputOptions.output ?? "json";
  if (outputFormat === "table") {
    const rows: Record<string, unknown>[] = [];
    for (const downloadedObj of downloadedObjects) {
      rows.push({ action: "Downloaded", name: downloadedObj, type: "object" });
    }
    for (const [name, failure] of Object.entries(downloadFailures)) {
      rows.push({
        action: "Failed",
        name,
        type: "object",
        "error-message": failure,
      });
    }
    for (const skip of skippedObjects) {
      rows.push({ action: "Skipped", name: skip, type: "object" });
    }
    renderDocument(io, rows, outputOptions);
  } else {
    renderDocument(
      io,
      {
        "downloaded-objects": downloadedObjects,
        "download-failures": downloadFailures,
        "skipped-objects": skippedObjects,
      },
      outputOptions,
    );
  }

  if (Object.keys(downloadFailures).length > 0) {
    throw new Exit(1);
  }
}

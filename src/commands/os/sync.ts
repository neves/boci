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
import { getPosixMode } from "../../lib/posixMode.ts";
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
import { createSyncDownloadTransferHelpers } from "./sync_download_transfers.ts";
export async function runOsObjectSync(
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
  const srcDir =
    typeof values.src_dir === "string" && values.src_dir.length > 0
      ? values.src_dir
      : undefined;
  const destDir =
    typeof values.dest_dir === "string" && values.dest_dir.length > 0
      ? values.dest_dir
      : undefined;
  const prefix = typeof values.prefix === "string" ? values.prefix : undefined;
  const include = normalizeStringArray(values.include);
  const exclude = normalizeStringArray(values.exclude);
  const deleteFlag = values.delete === true;
  const dryRun = values.dry_run === true;
  const noFollowSymlinks = values.no_follow_symlinks === true;
  const noMultipart = values.no_multipart === true;
  const partSizeMib =
    typeof values.part_size === "number" ? values.part_size : 128;
  const partSizeBytes = partSizeMib * MEBIBYTE;
  const parallelOperationsCount = Math.max(
    1,
    typeof values.parallel_operations_count === "number"
      ? values.parallel_operations_count
      : DEFAULT_PARALLEL_DOWNLOAD_COUNT,
  );
  const debug = rootValues.debug === true;
  const outputFormat = outputOptions.output ?? "json";

  if (srcDir && destDir) {
    usageError(
      io,
      "Only one of --src-dir or --dest-dir options can be specified at a time",
    );
  }
  if (!srcDir && !destDir) {
    usageError(io, "Either --src-dir or --dest-dir options must be specified");
  }

  if (srcDir) {
    if (include.length > 0 && exclude.length > 0) {
      usageError(
        io,
        "The --include and --exclude parameters cannot both be provided.",
      );
    }

    const expandedDirectory = expandVars(expandUser(srcDir, io.env), io.env);
    const resolvedSrcDir = resolve(io.cwd, expandedDirectory);
    if (!existsSync(resolvedSrcDir)) {
      usageError(
        io,
        `The specified --src-dir ${srcDir} (expanded to: ${expandedDirectory}) does not exist`,
      );
    }
    try {
      accessSync(resolvedSrcDir, fsConstants.R_OK);
      if (
        process.platform === "win32" &&
        (getPosixMode(resolvedSrcDir) & 0o400) === 0
      ) {
        throw new Error("EACCES");
      }
    } catch {
      usageError(
        io,
        `The specified --src-dir ${srcDir} (expanded to: ${expandedDirectory}) does not have read permissions`,
      );
    }

    const bucketRes = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}",
      pathParams: { namespaceName: namespace, bucketName },
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    if (!bucketRes.response.ok) {
      io.err(
        formatServiceError(
          { http: "GET", method: "get_bucket" },
          stripQuery(bucketRes.url),
          bucketRes.response,
          bucketRes.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }

    let parsedMetadata: Record<string, string> | undefined;
    if (values.metadata !== undefined) {
      const rawMeta = parseJsonParameter(io, "metadata", values.metadata);
      if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
        parsedMetadata = {};
        for (const [k, v] of Object.entries(
          rawMeta as Record<string, unknown>,
        )) {
          parsedMetadata[k] = String(v);
        }
      }
    }

    const autoContentType = values.content_type === "auto";
    const fixedContentType =
      typeof values.content_type === "string" && !autoContentType
        ? values.content_type
        : undefined;
    const sseHeaders =
      typeof values.encryption_key_file === "string"
        ? readEncryptionKeyHeaders(io, values.encryption_key_file)
        : {};

    const shouldIncludeUpload = buildBulkDownloadFilter(
      expandedDirectory,
      include,
      exclude,
      undefined,
    );

    const uploadedObjects: Record<string, Record<string, string>> = {};
    const uploadFailures: Record<string, string | Record<string, string>> = {};
    const skippedObjects: string[] = [];
    const uploadTransfers = new Set<string>();
    const uploadSkipped = new Set<string>();

    const walked = walkDirectoryForSyncUpload(
      io,
      expandedDirectory,
      noFollowSymlinks,
    );
    const inFlight = new Set<Promise<void>>();

    const uploadOneEntry = async (task: {
      objectName: string;
      fullFilePath: string;
      resolvedFilePath: string;
      emptyFolder: boolean;
      contentType?: string;
      ifMatch?: string;
      ifNoneMatch?: string;
    }) => {
      const {
        objectName,
        fullFilePath,
        resolvedFilePath,
        emptyFolder,
        contentType,
        ifMatch,
        ifNoneMatch,
      } = task;
      const pathParams = {
        namespaceName: namespace,
        bucketName,
        objectName,
      };

      try {
        if (debug) io.err(`Uploading ${fullFilePath}\n`);
        const fileSize = emptyFolder ? 0 : statSync(resolvedFilePath).size;

        let responseHeaders: Headers;
        if (emptyFolder || noMultipart || fileSize <= partSizeBytes) {
          const fileBytes = emptyFolder
            ? new Uint8Array(0)
            : new Uint8Array(readFileSync(resolvedFilePath));
          const putHeaders: Record<string, string> = {
            accept: "application/json",
            "content-type": contentType ?? "application/octet-stream",
            expect: "100-continue",
            "opc-client-retries": "true",
            ...sseHeaders,
          };
          if (ifMatch !== undefined) putHeaders["if-match"] = ifMatch;
          if (ifNoneMatch !== undefined)
            putHeaders["if-none-match"] = ifNoneMatch;
          if (parsedMetadata) {
            for (const [k, v] of Object.entries(parsedMetadata)) {
              putHeaders[`opc-meta-${k}`] = v;
            }
          }
          if (typeof values.content_language === "string")
            putHeaders["content-language"] = values.content_language;
          if (typeof values.content_encoding === "string")
            putHeaders["content-encoding"] = values.content_encoding;
          if (typeof values.content_disposition === "string")
            putHeaders["content-disposition"] = values.content_disposition;
          if (typeof values.cache_control === "string")
            putHeaders["cache-control"] = values.cache_control;
          if (typeof values.storage_tier === "string")
            putHeaders["storage-tier"] = values.storage_tier;

          const putRes = await sendServiceRequest(io, sc, {
            method: "PUT",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
            pathParams,
            headers: putHeaders,
            body: fileBytes,
            enforceContentHeaders: false,
          });
          if (!putRes.response.ok) {
            throw new Error(
              formatServiceError(
                { http: "PUT", method: "put_object" },
                stripQuery(putRes.url),
                putRes.response,
                putRes.raw,
                sc.targetService,
              ).trimEnd(),
            );
          }
          responseHeaders = putRes.response.headers;
        } else {
          const createBody: Record<string, unknown> = { object: objectName };
          if (contentType) createBody.contentType = contentType;
          if (
            typeof values.content_language === "string" &&
            values.content_language
          )
            createBody.contentLanguage = values.content_language;
          if (
            typeof values.content_encoding === "string" &&
            values.content_encoding
          )
            createBody.contentEncoding = values.content_encoding;
          if (
            typeof values.content_disposition === "string" &&
            values.content_disposition
          )
            createBody.contentDisposition = values.content_disposition;
          if (typeof values.cache_control === "string" && values.cache_control)
            createBody.cacheControl = values.cache_control;
          if (typeof values.storage_tier === "string" && values.storage_tier)
            createBody.storageTier = values.storage_tier;
          if (parsedMetadata && Object.keys(parsedMetadata).length > 0) {
            const prefixed: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsedMetadata)) {
              prefixed[k.startsWith("opc-meta-") ? k : `opc-meta-${k}`] = v;
            }
            createBody.metadata = prefixed;
          }
          const createHeaders: Record<string, string> = {
            accept: "application/json",
            "content-type": "application/json",
            ...sseHeaders,
          };
          if (ifMatch !== undefined) createHeaders["if-match"] = ifMatch;
          if (ifNoneMatch !== undefined)
            createHeaders["if-none-match"] = ifNoneMatch;

          const createRes = await sendServiceRequest(io, sc, {
            method: "POST",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/u",
            pathParams: { namespaceName: namespace, bucketName },
            headers: createHeaders,
            body: JSON.stringify(createBody),
          });
          if (!createRes.response.ok) {
            throw new Error(
              formatServiceError(
                { http: "POST", method: "create_multipart_upload" },
                stripQuery(createRes.url),
                createRes.response,
                createRes.raw,
                sc.targetService,
              ).trimEnd(),
            );
          }
          const uploadId = String(
            (JSON.parse(createRes.raw) as { uploadId?: string }).uploadId ?? "",
          );
          const { partSizeBytes: resolvedPartBytes } = resolveMultipartPartSize(
            fileSize,
            partSizeMib,
          );
          const parts = buildMultipartPutParts(fileSize, resolvedPartBytes);
          const partResults: ({ partNum: number; etag: string } | undefined)[] =
            new Array(parts.length);
          let firstPartErr: string | undefined;
          let nextPartIdx = 0;

          const fd = openSync(resolvedFilePath, "r");
          try {
            const partWorkers = Array.from(
              {
                length: Math.max(
                  1,
                  Math.min(parallelOperationsCount, parts.length),
                ),
              },
              async () => {
                while (firstPartErr === undefined) {
                  const idx = nextPartIdx++;
                  const part = parts[idx];
                  if (!part) break;
                  const partBytes = readPartFromFile(
                    fd,
                    part.offset,
                    part.size,
                  );
                  const partRes = await sendServiceRequest(io, sc, {
                    method: "PUT",
                    pathTemplate:
                      "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
                    pathParams,
                    queryParams: [
                      ["uploadId", uploadId],
                      ["uploadPartNum", String(part.partNum)],
                    ],
                    headers: {
                      accept: "application/json",
                      "content-type": "application/octet-stream",
                      expect: "100-continue",
                      ...sseHeaders,
                    },
                    body: partBytes,
                    enforceContentHeaders: false,
                  });
                  if (!partRes.response.ok) {
                    if (firstPartErr === undefined) {
                      firstPartErr = formatServiceError(
                        { http: "PUT", method: "upload_part" },
                        stripQuery(partRes.url),
                        partRes.response,
                        partRes.raw,
                        sc.targetService,
                      ).trimEnd();
                    }
                    return;
                  }
                  partResults[idx] = {
                    partNum: part.partNum,
                    etag: partRes.response.headers.get("etag") ?? "",
                  };
                }
              },
            );
            await Promise.all(partWorkers);
          } finally {
            closeSync(fd);
          }
          if (firstPartErr !== undefined) throw new Error(firstPartErr);

          const partsToCommit: { partNum: number; etag: string }[] = [];
          const partsToExclude: number[] = [];
          for (let i = 0; i < parts.length; i++) {
            const r = partResults[i];
            if (r) partsToCommit.push(r);
            else partsToExclude.push(i + 1);
          }
          const commitRes = await sendServiceRequest(io, sc, {
            method: "POST",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
            pathParams,
            queryParams: [["uploadId", uploadId]],
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "opc-client-retries": "true",
            },
            body: JSON.stringify({ partsToCommit, partsToExclude }),
          });
          if (!commitRes.response.ok) {
            throw new Error(
              formatServiceError(
                { http: "POST", method: "commit_multipart_upload" },
                stripQuery(commitRes.url),
                commitRes.response,
                commitRes.raw,
                sc.targetService,
              ).trimEnd(),
            );
          }
          responseHeaders = commitRes.response.headers;
        }

        uploadedObjects[objectName] = filterBulkPutHeaders(responseHeaders);
      } catch (e) {
        uploadFailures[objectName] = e instanceof Error ? e.message : String(e);
        if (debug) io.err(`Failed to upload ${objectName}\n`);
      } finally {
        if (debug) {
          io.err(`Uploaded ${objectName}\n`);
        } else {
          io.err(`${formatBulkProgressLabel(io, objectName, "Uploaded")}\n`);
          io.out("\n");
        }
      }
    };

    for (const entry of walked) {
      if (!shouldIncludeUpload(entry.fullFilePath)) continue;

      let objectName = entry.fullFilePath.slice(expandedDirectory.length);
      if (objectName.startsWith("/")) objectName = objectName.slice(1);
      if (prefix) objectName = `${prefix}${objectName}`;

      const contentType = autoContentType
        ? guessContentTypeOptional(objectName)
        : fixedContentType;

      let ifMatch: string | undefined;
      let ifNoneMatch: string | undefined;

      try {
        const headRes = await sendServiceRequest(io, sc, {
          method: "HEAD",
          pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
          pathParams: {
            namespaceName: namespace,
            bucketName,
            objectName,
          },
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
        });
        if (headRes.response.status === 404) {
          ifNoneMatch = "*";
        } else if (!headRes.response.ok) {
          uploadFailures[objectName] = formatServiceError(
            { http: "HEAD", method: "head_object" },
            stripQuery(headRes.url),
            headRes.response,
            headRes.raw,
            sc.targetService,
          ).trimEnd();
          if (debug) io.err(`Failed to upload ${objectName}\n`);
          continue;
        } else {
          if (entry.emptyFolder) {
            skippedObjects.push(objectName);
            uploadSkipped.add(objectName);
            continue;
          }
          const rawLen = headRes.response.headers.get("content-length");
          const rFileSize =
            rawLen !== null ? Number.parseInt(rawLen, 10) : Number.NaN;
          const rawMtime = headRes.response.headers.get("last-modified");
          const rFileMtimeMs =
            rawMtime !== null ? Date.parse(rawMtime) : Number.NaN;
          if (
            !requiresSync(
              entry.resolvedFilePath,
              Number.isFinite(rFileSize) ? rFileSize : undefined,
              Number.isFinite(rFileMtimeMs) ? rFileMtimeMs : undefined,
              true,
            )
          ) {
            skippedObjects.push(objectName);
            uploadSkipped.add(objectName);
            continue;
          }
          ifMatch = headRes.response.headers.get("etag") ?? undefined;
        }
      } catch (e) {
        if (e instanceof Exit) throw e;
        uploadFailures[objectName] = e instanceof Error ? e.message : String(e);
        if (debug) io.err(`Failed to upload ${objectName}\n`);
        continue;
      }

      uploadTransfers.add(objectName);
      if (dryRun) {
        io.out(`Uploading file: ${entry.fullFilePath}\n`);
        continue;
      }

      const p = uploadOneEntry({
        objectName,
        fullFilePath: entry.fullFilePath,
        resolvedFilePath: entry.resolvedFilePath,
        emptyFolder: entry.emptyFolder,
        contentType,
        ifMatch,
        ifNoneMatch,
      });
      inFlight.add(p);
      p.finally(() => inFlight.delete(p));
      if (inFlight.size >= parallelOperationsCount) {
        await Promise.race(inFlight);
      }
    }

    if (!dryRun) {
      await Promise.all(inFlight);
    }

    if (dryRun) {
      for (const skippedName of uploadSkipped) {
        const rel =
          prefix !== undefined ? skippedName.slice(prefix.length) : skippedName;
        io.out(`Skipping file: ${pyPathJoin(expandedDirectory, rel)}\n`);
      }
    }

    const deletedObjects: string[] = [];
    const deleteFailures: Record<string, string> = {};

    if (deleteFlag) {
      const excludedObjectSet = new Set<string>([
        ...uploadTransfers,
        ...uploadSkipped,
      ]);
      const hasDeleteFilter = include.length > 0 || exclude.length > 0;
      const shouldIncludeDelete = buildBulkDownloadFilter(
        bucketName,
        include,
        exclude,
        prefix,
      );

      const listDeletePage = async (start: string | undefined) => {
        const queryParams: [string, string][] = [];
        if (prefix !== undefined) queryParams.push(["prefix", prefix]);
        if (start !== undefined) queryParams.push(["start", start]);
        queryParams.push([
          "limit",
          String(OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS),
        ]);
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
            typeof body.nextStartWith === "string" &&
            body.nextStartWith.length > 0
              ? body.nextStartWith
              : undefined,
        };
      };

      if (dryRun) {
        let nextStart: string | undefined;
        while (true) {
          const page = await listDeletePage(nextStart);
          for (const obj of page.objects) {
            const objectName = String(obj.name ?? "");
            if (
              hasDeleteFilter &&
              !shouldIncludeDelete(pyPathJoin(bucketName, objectName))
            ) {
              continue;
            }
            if (excludedObjectSet.has(objectName)) continue;
            deletedObjects.push(objectName);
          }
          if (page.nextStartWith === undefined) break;
          nextStart = page.nextStartWith;
        }
        for (const o of deletedObjects) {
          io.out(`Deleting object: ${o}\n`);
        }
      } else {
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
            deleteFailures[objectName] =
              e instanceof Error ? e.message : String(e);
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
        while (true) {
          const page = await listDeletePage(currPage);
          const nextPage = page.nextStartWith;
          const objectsToDelete: string[] = [];

          for (const obj of page.objects) {
            const objectName = String(obj.name ?? "");
            if (
              hasDeleteFilter &&
              !shouldIncludeDelete(pyPathJoin(bucketName, objectName))
            ) {
              continue;
            }
            if (excludedObjectSet.has(objectName)) continue;
            objectsToDelete.push(objectName);
          }

          const delInFlight = new Set<Promise<void>>();
          for (const objectName of objectsToDelete) {
            const p = deleteOneObject(objectName);
            delInFlight.add(p);
            p.finally(() => delInFlight.delete(p));
            if (delInFlight.size >= parallelOperationsCount) {
              await Promise.race(delInFlight);
            }
          }
          await Promise.all(delInFlight);

          if (objectsToDelete.length === 0) {
            if (hasDeleteFilter) {
              currPage = nextPage;
            } else {
              break;
            }
          }
          if (nextPage === undefined) break;
        }

        if (Object.keys(deleteFailures).length > 0) {
          throw new Exit(1);
        }
      }
    }

    if (dryRun) return;

    if (outputFormat === "table") {
      const rows: Record<string, unknown>[] = [];
      for (const [name, result] of Object.entries(uploadedObjects)) {
        rows.push({ action: "Uploaded", name, type: "file", ...result });
      }
      for (const [name, failure] of Object.entries(uploadFailures)) {
        rows.push({
          action: "Failed",
          name,
          type: "file",
          "error-message": failure,
        });
      }
      for (const skip of skippedObjects) {
        rows.push({ action: "Skipped", name: skip, type: "file" });
      }
      if (deleteFlag) {
        for (const deleted of deletedObjects) {
          rows.push({ action: "Deleted", type: "object", name: deleted });
        }
      }
      renderDocument(io, rows, outputOptions);
    } else {
      const doc: Record<string, unknown> = {
        "uploaded-objects": uploadedObjects,
        "upload-failures": uploadFailures,
        "skipped-objects": skippedObjects,
      };
      if (deleteFlag) {
        doc["delete-failures"] = deleteFailures;
        doc["deleted-objects"] = deletedObjects;
      }
      renderDocument(io, doc, outputOptions);
    }

    if (Object.keys(uploadFailures).length > 0) {
      throw new Exit(1);
    }
    return;
  }

  // destDir branch (download sync)
  const disallowedFlags: [string, unknown][] = [
    ["cache-control", values.cache_control],
    ["content-disposition", values.content_disposition],
    ["content-encoding", values.content_encoding],
    ["content-language", values.content_language],
    ["content-type", values.content_type],
    ["metadata", values.metadata],
    ["storage-tier", values.storage_tier],
  ];
  for (const [flagName, flagVal] of disallowedFlags) {
    if (
      flagVal !== undefined &&
      flagVal !== null &&
      flagVal !== "" &&
      flagVal !== false
    ) {
      usageError(
        io,
        `Option --${flagName} cannot be specified with --dest-dir`,
      );
    }
  }

  if (include.length > 0 && exclude.length > 0) {
    usageError(
      io,
      "The --include and --exclude parameters cannot both be provided.",
    );
  }

  const destDirStr = destDir as string;
  const expandedDirectory = expandVars(expandUser(destDirStr, io.env), io.env);
  const resolvedDestDir = resolve(io.cwd, expandedDirectory);
  if (!existsSync(resolvedDestDir)) {
    mkdirSync(resolvedDestDir, { recursive: true });
  } else {
    try {
      accessSync(resolvedDestDir, fsConstants.W_OK);
      if (
        process.platform === "win32" &&
        (getPosixMode(resolvedDestDir) & 0o200) === 0
      ) {
        throw new Error("EACCES");
      }
    } catch {
      usageError(
        io,
        `The specified --dest-dir ${destDirStr} (expanded to: ${expandedDirectory}) does not have write permissions`,
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
  const downloadTransfers = new Set<string>();
  const downloadSkipped = new Set<string>();
  const filesToProcess: {
    lastModifiedSec: number;
    resolvedFilePath: string;
  }[] = [];
  const inFlight = new Set<Promise<void>>();
  const multipartDownloadThreshold = DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB;

  const { downloadSinglePartToFile, downloadMultipartToFile } =
    createSyncDownloadTransferHelpers({
      io,
      sc,
      namespace,
      bucketName,
      sseHeaders,
      partSizeBytes,
      parallelOperationsCount,
      multipartDownloadThreshold,
      debug,
    });

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

  try {
    let nextStart: string | undefined;
    let keepPaginating = true;

    while (keepPaginating) {
      const queryParams: [string, string][] = [];
      if (prefix !== undefined) queryParams.push(["prefix", prefix]);
      if (nextStart !== undefined) queryParams.push(["start", nextStart]);
      queryParams.push([
        "limit",
        String(OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS),
      ]);
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
        typeof body.nextStartWith === "string" && body.nextStartWith.length > 0
          ? body.nextStartWith
          : undefined;

      const toDownload: {
        objectName: string;
        objectSize: number | undefined;
        fullFilePath: string;
        resolvedFilePath: string;
      }[] = [];

      for (const obj of pageObjects) {
        const rawName = String(obj.name ?? "");
        let relativeName =
          prefix !== undefined ? rawName.slice(prefix.length) : rawName;
        if (relativeName.startsWith("/")) relativeName = relativeName.slice(1);
        const fullFilePath = pyPathJoin(expandedDirectory, relativeName);
        if (!shouldInclude(fullFilePath)) continue;

        const archivalState =
          typeof obj.archivalState === "string" ? obj.archivalState : undefined;
        if (archivalState && archivalState.toLowerCase() !== "restored") {
          skippedObjects.push(rawName);
          downloadSkipped.add(fullFilePath);
          continue;
        }

        const lastModifiedMs =
          typeof obj.timeModified === "string"
            ? parseIsoTimeTruncatedToSeconds(obj.timeModified)
            : undefined;
        const objectSize =
          typeof obj.size === "number" && Number.isFinite(obj.size)
            ? obj.size
            : undefined;
        const resolvedFilePath = resolve(io.cwd, fullFilePath);

        if (existsSync(resolvedFilePath)) {
          if (statSync(resolvedFilePath).isDirectory()) {
            skippedObjects.push(rawName);
            downloadSkipped.add(fullFilePath);
            continue;
          }
          if (
            !requiresSync(resolvedFilePath, objectSize, lastModifiedMs, false)
          ) {
            skippedObjects.push(rawName);
            downloadSkipped.add(fullFilePath);
            continue;
          }
        }

        toDownload.push({
          objectName: rawName,
          objectSize,
          fullFilePath,
          resolvedFilePath,
        });
        downloadTransfers.add(fullFilePath);
        if (lastModifiedMs !== undefined && Number.isFinite(lastModifiedMs)) {
          filesToProcess.push({
            lastModifiedSec: lastModifiedMs / 1000,
            resolvedFilePath,
          });
        }
      }

      if (dryRun) {
        for (const obj of toDownload) {
          io.out(`Downloading object: ${obj.objectName}\n`);
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

    if (!dryRun) {
      await Promise.all(inFlight);
    }
  } finally {
    if (!dryRun) {
      for (const file of filesToProcess) {
        try {
          utimesSync(
            file.resolvedFilePath,
            file.lastModifiedSec,
            file.lastModifiedSec,
          );
        } catch {
          // File may not have been written (e.g. failed download).
        }
      }
    }
  }

  if (dryRun) {
    for (const skippedPath of downloadSkipped) {
      let rel = skippedPath.slice(expandedDirectory.length).replace(/^\/+/, "");
      if (prefix !== undefined) rel = `${prefix}${rel}`;
      io.out(`Skipping object: ${rel}\n`);
    }
  }

  const deletedFiles: string[] = [];
  if (deleteFlag) {
    const excludedLocalObjects = new Set<string>([
      ...downloadTransfers,
      ...downloadSkipped,
    ]);
    const walkedBottomUp = walkDirectoryBottomUpForDelete(
      io,
      expandedDirectory,
      noFollowSymlinks,
    );
    for (const dir of walkedBottomUp) {
      let remainingFiles = dir.files.length;
      for (const file of dir.files) {
        if (noFollowSymlinks && file.isLink) continue;
        if (!shouldInclude(file.fullFilePath)) continue;
        if (excludedLocalObjects.has(file.fullFilePath)) continue;

        io.out(`Deleting : ${file.fullFilePath}\n`);
        if (!dryRun) {
          unlinkSync(file.resolvedFilePath);
        }
        remainingFiles -= 1;
        deletedFiles.push(file.fullFilePath);
      }

      if (remainingFiles === 0 && dir.dirDisplay !== expandedDirectory) {
        const emptyFolderObject = `${dir.dirDisplay}/`;
        if (!excludedLocalObjects.has(emptyFolderObject)) {
          if (!dryRun) {
            try {
              rmdirSync(dir.dirResolved);
              io.out(`Deleting : ${emptyFolderObject}\n`);
              deletedFiles.push(emptyFolderObject);
            } catch {
              // Ignore if directory still has subdirectories.
            }
          } else {
            io.out(`Deleting : ${emptyFolderObject}\n`);
            deletedFiles.push(emptyFolderObject);
          }
        }
      }
    }
  }

  if (dryRun) return;

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
    if (deleteFlag) {
      for (const delFile of deletedFiles) {
        rows.push({ action: "Deleted", name: delFile, type: "file" });
      }
    }
    renderDocument(io, rows, outputOptions);
  } else {
    const doc: Record<string, unknown> = {
      "downloaded-objects": downloadedObjects,
      "download-failures": downloadFailures,
      "skipped-objects": skippedObjects,
    };
    if (deleteFlag) {
      doc["deleted-files"] = deletedFiles;
    }
    renderDocument(io, doc, outputOptions);
  }

  if (Object.keys(downloadFailures).length > 0) {
    throw new Exit(1);
  }
}

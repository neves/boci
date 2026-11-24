// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import {
  closeSync,
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
import { checkDirectoryReadable } from "../../lib/accessibility.ts";
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
export async function runOsObjectBulkUpload(
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
  const srcDir = String(values.src_dir);
  const include = normalizeStringArray(values.include);
  const exclude = normalizeStringArray(values.exclude);
  const overwrite = values.overwrite === true;
  const noOverwrite = values.no_overwrite === true;
  const noMultipart = values.no_multipart === true;
  const dryRun = values.dry_run === true;
  const verifyChecksum = values.verify_checksum === true;
  const noFollowSymlinks = values.no_follow_symlinks === true;
  const objectPrefix =
    typeof values.object_prefix === "string" && values.object_prefix.length > 0
      ? values.object_prefix
      : undefined;
  const partSizeMib =
    typeof values.part_size === "number" ? values.part_size : 128;
  const partSizeBytes = partSizeMib * MEBIBYTE;
  const parallelUploadCount =
    typeof values.parallel_upload_count === "number"
      ? values.parallel_upload_count
      : DEFAULT_PARALLEL_UPLOAD_COUNT;
  const debug = rootValues.debug === true;

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
    checkDirectoryReadable(resolvedSrcDir);
  } catch {
    usageError(
      io,
      `The specified --src-dir ${srcDir} (expanded to: ${expandedDirectory}) does not have read permissions`,
    );
  }

  if (overwrite && noOverwrite) {
    usageError(
      io,
      "The options --overwrite and --no-overwrite cannot be used together.",
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
      for (const [k, v] of Object.entries(rawMeta as Record<string, unknown>)) {
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

  const includeRegexes = include.map((pat) =>
    fnmatchToRegex(pyPathJoin(expandedDirectory, pat)),
  );
  const excludeRegexes = exclude.map((pat) =>
    fnmatchToRegex(pyPathJoin(expandedDirectory, pat)),
  );
  const shouldIncludeFile = (fullFilePath: string): boolean => {
    if (includeRegexes.length > 0) {
      return includeRegexes.some((re) => re.test(fullFilePath));
    }
    if (excludeRegexes.length > 0) {
      return !excludeRegexes.some((re) => re.test(fullFilePath));
    }
    return true;
  };

  const uploadedObjects: Record<string, Record<string, string>> = {};
  const uploadFailures: Record<string, string | Record<string, string>> = {};
  const skippedObjects: string[] = [];

  const walked = walkDirectoryForBulkUpload(
    io,
    expandedDirectory,
    noFollowSymlinks,
  );
  const inFlight = new Set<Promise<void>>();

  const uploadOneFile = async (task: {
    objectName: string;
    fullFilePath: string;
    resolvedFilePath: string;
    contentType?: string;
    ifMatch?: string;
    ifNoneMatch?: string;
  }) => {
    const {
      objectName,
      fullFilePath,
      resolvedFilePath,
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
      const fileSize = statSync(resolvedFilePath).size;

      let responseHeaders: Headers;
      let localChecksum: string | undefined;

      if (noMultipart || fileSize <= partSizeBytes) {
        const fileBytes = new Uint8Array(readFileSync(resolvedFilePath));
        if (verifyChecksum) {
          localChecksum = new Bun.CryptoHasher("md5")
            .update(fileBytes)
            .digest("base64");
        }
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
        if (typeof values.opc_sse_kms_key_id === "string")
          putHeaders["opc-sse-kms-key-id"] = values.opc_sse_kms_key_id;

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
        if (typeof values.opc_sse_kms_key_id === "string")
          createHeaders["opc-sse-kms-key-id"] = values.opc_sse_kms_key_id;

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
        const partResults: (
          { partNum: number; etag: string; opcMd5: string } | undefined
        )[] = new Array(parts.length);
        let firstPartErr: string | undefined;
        let nextPartIdx = 0;

        const fd = openSync(resolvedFilePath, "r");
        try {
          const partWorkers = Array.from(
            {
              length: Math.max(1, Math.min(parallelUploadCount, parts.length)),
            },
            async () => {
              while (firstPartErr === undefined) {
                const idx = nextPartIdx++;
                const part = parts[idx];
                if (!part) break;
                const partBytes = readPartFromFile(fd, part.offset, part.size);
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
                  opcMd5: partRes.response.headers.get("opc-content-md5") ?? "",
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
        const partMd5s: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const r = partResults[i];
          if (r) {
            partsToCommit.push({ partNum: r.partNum, etag: r.etag });
            partMd5s.push(r.opcMd5);
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
        if (verifyChecksum) {
          localChecksum = computeMultipartMd5(partMd5s);
        }
      }

      const filtered = filterBulkPutHeaders(responseHeaders);
      if (verifyChecksum && localChecksum !== undefined) {
        const serverMd5 =
          responseHeaders.get("opc-content-md5") ??
          responseHeaders.get("opc-multipart-md5");
        const match = localChecksum === serverMd5;
        filtered["verify-md5-checksum"] =
          `md5 checksum ${match ? "matches" : "does not match"} [Local: ${localChecksum}]`;
        if (match) {
          uploadedObjects[objectName] = filtered;
        } else {
          uploadFailures[objectName] = filtered;
        }
      } else {
        uploadedObjects[objectName] = filtered;
      }
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
    if (!shouldIncludeFile(entry.fullFilePath)) continue;

    let objectName = entry.fullFilePath.slice(expandedDirectory.length);
    if (objectName.startsWith("/")) objectName = objectName.slice(1);
    if (objectPrefix) objectName = `${objectPrefix}${objectName}`;

    const contentType = autoContentType
      ? guessContentTypeOptional(objectName)
      : fixedContentType;

    let ifMatch: string | undefined;
    let ifNoneMatch: string | undefined;

    if (!overwrite) {
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
          if (noOverwrite) {
            skippedObjects.push(objectName);
            continue;
          }
          const confirmed = await confirmPrompt(
            io,
            `WARNING: ${objectName} already exists. Are you sure you want to overwrite it?`,
          );
          if (!confirmed) {
            skippedObjects.push(objectName);
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
    }

    if (dryRun) {
      io.out(`${entry.fullFilePath}\n`);
      continue;
    }

    const p = uploadOneFile({
      objectName,
      fullFilePath: entry.fullFilePath,
      resolvedFilePath: entry.resolvedFilePath,
      contentType,
      ifMatch,
      ifNoneMatch,
    });
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    if (inFlight.size >= parallelUploadCount) {
      await Promise.race(inFlight);
    }
  }

  if (dryRun) return;

  await Promise.all(inFlight);

  const outputFormat = outputOptions.output ?? "json";
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
    renderDocument(io, rows, outputOptions);
  } else {
    renderDocument(
      io,
      {
        "uploaded-objects": uploadedObjects,
        "upload-failures": uploadFailures,
        "skipped-objects": skippedObjects,
      },
      outputOptions,
    );
  }

  if (Object.keys(uploadFailures).length > 0) {
    throw new Exit(1);
  }
}

// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Exit, type Invocation } from "../../lib/io.ts";
import { parseJsonParameter } from "../../core/json-input.ts";
import {
  createServiceClient,
  sendServiceRequest,
} from "../../core/operation.ts";
import { formatServiceError } from "../../core/output.ts";

import {
  DEFAULT_PARALLEL_UPLOAD_COUNT,
  DEFAULT_PART_SIZE_BYTES,
  MEBIBYTE,
  MULTIPART_UPLOAD_ERROR_MESSAGE,
  OBJECT_STORAGE_CLIENT,
  type OsObjectPutOptions,
  STREAMING_DEFAULT_PART_SIZE_BYTES,
  buildMultipartPutParts,
  computeMultipartMd5,
  computePartChecksum,
  confirmPrompt,
  guessContentTypeOptional,
  readEncryptionKeyHeaders,
  readPartFromFile,
  readStdinParts,
  renderObjectPutHeaders,
  resolveMultipartPartSize,
  resolveOsNamespace,
  stripQuery,
  usageError,
} from "./shared.ts";
export async function runOsObjectPut(
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
  const isStdin = filePath === "-";
  const force = values.force === true;
  const noOverwrite = values.no_overwrite === true;
  const noMultipart = values.no_multipart === true;
  const disableParallelUploads = values.disable_parallel_uploads === true;
  const parallelUploadCount =
    typeof values.parallel_upload_count === "number"
      ? values.parallel_upload_count
      : undefined;
  const partSizeMib =
    typeof values.part_size === "number" ? values.part_size : undefined;

  if (parallelUploadCount !== undefined) {
    if (disableParallelUploads) {
      usageError(
        io,
        "The option --parallel-upload-count is not applicable when using the --disable-parallel-uploads flag.",
      );
    }
    if (noMultipart) {
      usageError(
        io,
        "The option --parallel-upload-count is not applicable when using the --no-multipart flag.",
      );
    }
  }

  let objectName =
    typeof values.name === "string" && values.name.length > 0
      ? values.name
      : undefined;
  if (!objectName) {
    if (isStdin) {
      usageError(
        io,
        'Option "--name" must be provided when reading object from stdin',
      );
    }
    objectName = basename(filePath);
  }

  if (partSizeMib !== undefined && noMultipart) {
    usageError(
      io,
      "The option --part-size is not applicable when using the --no-multipart flag.",
    );
  }

  const pathParams = {
    namespaceName: namespace,
    bucketName,
    objectName,
  };

  let resolvedIfMatch: string | undefined;
  let ifNoneMatch: string | undefined;

  if (!force) {
    const headHeaders: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (typeof values.if_match === "string") {
      headHeaders["if-match"] = values.if_match;
    }
    const head = await sendServiceRequest(io, sc, {
      method: "HEAD",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
      pathParams,
      headers: headHeaders,
    });
    if (head.response.status === 404) {
      ifNoneMatch = "*";
    } else if (!head.response.ok) {
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
    } else {
      const etag = head.response.headers.get("etag");
      if (etag !== null) resolvedIfMatch = etag;
      if (noOverwrite) {
        io.err("The object already exists and was not overwritten\n");
        return;
      }
      const confirmed = await confirmPrompt(
        io,
        "WARNING: This object already exists. Are you sure you want to overwrite it?",
      );
      if (!confirmed) {
        io.err("Abort: \n");
        throw new Exit(1);
      }
    }
  }

  const finalIfMatch =
    typeof values.if_match === "string" ? values.if_match : resolvedIfMatch;

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

  const resolvedContentType =
    typeof values.content_type === "string"
      ? values.content_type === "auto"
        ? guessContentTypeOptional(isStdin ? objectName : filePath)
        : values.content_type
      : undefined;

  const sseHeaders =
    typeof values.encryption_key_file === "string"
      ? readEncryptionKeyHeaders(io, values.encryption_key_file)
      : {};

  const algo =
    typeof values.opc_checksum_algorithm === "string"
      ? values.opc_checksum_algorithm.toUpperCase()
      : undefined;

  const buildCreateMultipartDetails = (): string => {
    const body: Record<string, unknown> = { object: objectName };
    if (resolvedContentType) body.contentType = resolvedContentType;
    if (typeof values.content_language === "string" && values.content_language)
      body.contentLanguage = values.content_language;
    if (typeof values.content_encoding === "string" && values.content_encoding)
      body.contentEncoding = values.content_encoding;
    if (
      typeof values.content_disposition === "string" &&
      values.content_disposition
    )
      body.contentDisposition = values.content_disposition;
    if (typeof values.cache_control === "string" && values.cache_control)
      body.cacheControl = values.cache_control;
    if (typeof values.storage_tier === "string" && values.storage_tier)
      body.storageTier = values.storage_tier;
    if (parsedMetadata && Object.keys(parsedMetadata).length > 0) {
      const prefixed: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsedMetadata)) {
        prefixed[k.startsWith("opc-meta-") ? k : `opc-meta-${k}`] = v;
      }
      body.metadata = prefixed;
    }
    return JSON.stringify(body);
  };

  const buildCreateMultipartHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      ...sseHeaders,
    };
    if (finalIfMatch !== undefined) headers["if-match"] = finalIfMatch;
    if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch;
    if (typeof values.opc_sse_kms_key_id === "string")
      headers["opc-sse-kms-key-id"] = values.opc_sse_kms_key_id;
    if (typeof values.opc_checksum_algorithm === "string")
      headers["opc-checksum-algorithm"] = values.opc_checksum_algorithm;
    return headers;
  };

  const buildSinglePartHeaders = (defaultContentType: string) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      expect: "100-continue",
      "content-type": resolvedContentType ?? defaultContentType,
      ...sseHeaders,
    };
    if (finalIfMatch !== undefined) headers["if-match"] = finalIfMatch;
    if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch;
    if (typeof values.content_md5 === "string")
      headers["content-md5"] = values.content_md5;
    if (typeof values.opc_checksum_algorithm === "string")
      headers["opc-checksum-algorithm"] = values.opc_checksum_algorithm;
    if (typeof values.opc_content_crc32c === "string")
      headers["opc-content-crc32c"] = values.opc_content_crc32c;
    if (typeof values.opc_content_sha256 === "string")
      headers["opc-content-sha256"] = values.opc_content_sha256;
    if (typeof values.opc_content_sha384 === "string")
      headers["opc-content-sha384"] = values.opc_content_sha384;
    if (parsedMetadata) {
      for (const [k, v] of Object.entries(parsedMetadata)) {
        headers[`opc-meta-${k}`] = v;
      }
    }
    if (typeof values.content_language === "string")
      headers["content-language"] = values.content_language;
    if (typeof values.content_encoding === "string")
      headers["content-encoding"] = values.content_encoding;
    if (typeof values.content_disposition === "string")
      headers["content-disposition"] = values.content_disposition;
    if (typeof values.cache_control === "string")
      headers["cache-control"] = values.cache_control;
    if (typeof values.storage_tier === "string")
      headers["storage-tier"] = values.storage_tier;
    if (typeof values.opc_sse_kms_key_id === "string")
      headers["opc-sse-kms-key-id"] = values.opc_sse_kms_key_id;
    return headers;
  };

  // Branch 1: STDIN streaming multipart upload (UploadManager.upload_stream).
  if (isStdin) {
    if (noMultipart) {
      usageError(
        io,
        "The --no-multipart flag is not valid when taking input from STDIN.",
      );
    }

    const createRes = await sendServiceRequest(io, sc, {
      method: "POST",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/u",
      pathParams: { namespaceName: namespace, bucketName },
      headers: buildCreateMultipartHeaders(),
      body: buildCreateMultipartDetails(),
      noRetry: true,
    });
    if (!createRes.response.ok) {
      io.err(
        formatServiceError(
          { http: "POST", method: "create_multipart_upload" },
          stripQuery(createRes.url),
          createRes.response,
          createRes.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }
    const uploadId = String(
      (JSON.parse(createRes.raw) as { uploadId?: string }).uploadId ?? "",
    );

    const streamPartSizeBytes =
      partSizeMib !== undefined
        ? partSizeMib * MEBIBYTE
        : STREAMING_DEFAULT_PART_SIZE_BYTES;
    const workerCount = disableParallelUploads
      ? 1
      : (parallelUploadCount ?? DEFAULT_PARALLEL_UPLOAD_COUNT);

    const uploadedParts: { partNum: number; etag: string; opcMd5: string }[] =
      [];
    let failed = false;
    const inFlight = new Set<Promise<void>>();
    let nextPartNum = 1;

    for await (const partBytes of readStdinParts(io, streamPartSizeBytes)) {
      if (failed) break;
      const partNum = nextPartNum++;
      const task = (async () => {
        try {
          const partMd5 = new Bun.CryptoHasher("md5")
            .update(partBytes)
            .digest("base64");
          const partRes = await sendServiceRequest(io, sc, {
            method: "PUT",
            pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
            pathParams,
            queryParams: [
              ["uploadId", uploadId],
              ["uploadPartNum", String(partNum)],
            ],
            headers: {
              accept: "application/json",
              "content-md5": partMd5,
              "content-type": "application/octet-stream",
              expect: "100-continue",
            },
            body: partBytes,
            enforceContentHeaders: false,
            noRetry: true,
          });
          if (!partRes.response.ok) {
            failed = true;
            return;
          }
          uploadedParts.push({
            partNum,
            etag: partRes.response.headers.get("etag") ?? "",
            opcMd5: partRes.response.headers.get("opc-content-md5") ?? "",
          });
        } catch {
          failed = true;
        }
      })();
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
      if (inFlight.size >= workerCount) {
        await Promise.race(inFlight);
      }
    }
    await Promise.all(inFlight);

    if (failed) {
      await sendServiceRequest(io, sc, {
        method: "DELETE",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
        pathParams,
        queryParams: [["uploadId", uploadId]],
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        noRetry: true,
      });
      io.err(MULTIPART_UPLOAD_ERROR_MESSAGE);
      throw new Exit(1);
    }

    let finalResponse: Response;
    if (uploadedParts.length > 0) {
      uploadedParts.sort((a, b) => a.partNum - b.partNum);
      const commitRes = await sendServiceRequest(io, sc, {
        method: "POST",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
        pathParams,
        queryParams: [["uploadId", uploadId]],
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          partsToCommit: uploadedParts.map((p) => ({
            partNum: p.partNum,
            etag: p.etag,
          })),
          partsToExclude: [],
        }),
        noRetry: true,
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
      io.err("Uploading object part\n");
      finalResponse = commitRes.response;
    } else {
      const abortRes = await sendServiceRequest(io, sc, {
        method: "DELETE",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
        pathParams,
        queryParams: [["uploadId", uploadId]],
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        noRetry: true,
      });
      if (!abortRes.response.ok) {
        io.err(
          formatServiceError(
            { http: "DELETE", method: "abort_multipart_upload" },
            stripQuery(abortRes.url),
            abortRes.response,
            abortRes.raw,
            sc.targetService,
          ),
        );
        throw new Exit(1);
      }
      const emptyPutHeaders = buildSinglePartHeaders("application/json");
      const putRes = await sendServiceRequest(io, sc, {
        method: "PUT",
        pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
        pathParams,
        headers: emptyPutHeaders,
        body: new Uint8Array(0),
        enforceContentHeaders: false,
        noRetry: true,
      });
      if (!putRes.response.ok) {
        io.err(
          formatServiceError(
            { http: "PUT", method: "put_object" },
            stripQuery(putRes.url),
            putRes.response,
            putRes.raw,
            sc.targetService,
          ),
        );
        throw new Exit(1);
      }
      finalResponse = putRes.response;
    }

    renderObjectPutHeaders(io, finalResponse.headers, outputOptions);
    if (values.verify_checksum === true) {
      io.out("Cannot open file to generate hash\n");
      throw new Exit(1);
    }
    return;
  }

  const resolvedFilePath = resolve(io.cwd, filePath);
  const totalSize = statSync(resolvedFilePath).size;
  const { effectivePartSizeMib, partSizeBytes } = resolveMultipartPartSize(
    totalSize,
    partSizeMib,
  );
  // Matches `objectstorage_cli_extended.py`: when --part-size is given, oci passes the
  // MiB integer to UploadManager._use_multipart(total_size, part_size).
  const sizeQualifiesForMultipart = effectivePartSizeMib
    ? effectivePartSizeMib < totalSize
    : DEFAULT_PART_SIZE_BYTES < totalSize;

  // Branch 2: File single-part upload.
  if (totalSize === 0 || noMultipart || !sizeQualifiesForMultipart) {
    if (parallelUploadCount !== undefined) {
      io.err(
        "Warning: File is being uploaded as a single part so --parallel-upload-count will be ignored.\n",
      );
    }

    const fileBytes = new Uint8Array(readFileSync(resolvedFilePath));
    const putHeaders = buildSinglePartHeaders("application/octet-stream");
    const userProvidedChecksum =
      values.opc_content_crc32c !== undefined ||
      values.opc_content_sha256 !== undefined ||
      values.opc_content_sha384 !== undefined;
    if (algo && !userProvidedChecksum) {
      if (totalSize > 0) {
        io.err(
          "WARNING:oci.util:Reading the stream to calculate its content-length. Process may freeze for very big streams. Consider passing in content length for big objects\n",
        );
      }
      const computed = computePartChecksum(algo, fileBytes);
      if (computed) putHeaders[computed.header] = computed.value;
    }

    const put = await sendServiceRequest(io, sc, {
      method: "PUT",
      pathTemplate: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
      pathParams,
      headers: putHeaders,
      body: fileBytes,
      enforceContentHeaders: false,
    });

    if (totalSize > 0) {
      io.err("Uploading object\n");
    }

    if (!put.response.ok) {
      io.err(
        formatServiceError(
          { http: "PUT", method: "put_object" },
          put.url,
          put.response,
          put.raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }

    renderObjectPutHeaders(io, put.response.headers, outputOptions);

    if (values.verify_checksum === true) {
      const localMd5 = new Bun.CryptoHasher("md5")
        .update(fileBytes)
        .digest("base64");
      const serverMd5 =
        put.response.headers.get("opc-content-md5") ??
        put.response.headers.get("opc-multipart-md5");
      const match = localMd5 === serverMd5;
      io.err(
        `md5 checksum ${match ? "matches" : "does not match"} [Local: ${localMd5}]\n`,
      );
      if (!match) throw new Exit(1);
    }
    return;
  }

  // Branch 3: File multipart upload (MultipartObjectAssembler).
  if (typeof values.content_md5 === "string") {
    io.err(
      "Warning: The --content-md5 option cannot be used with multipart uploads. It will be ignored.\n",
    );
  }
  if (typeof values.opc_content_sha256 === "string") {
    io.err(
      "Warning: The --opc_content_sha256 option cannot be used with multipart uploads. It will be ignored.\n",
    );
  }
  if (typeof values.opc_content_sha384 === "string") {
    io.err(
      "Warning: The --opc_content_sha384 option cannot be used with multipart uploads. It will be ignored.\n",
    );
  }
  if (typeof values.opc_content_crc32c === "string") {
    io.err(
      "Warning: The --opc_content_crc32c option cannot be used with multipart uploads. It will be ignored.\n",
    );
  }

  const createRes = await sendServiceRequest(io, sc, {
    method: "POST",
    pathTemplate: "/n/{namespaceName}/b/{bucketName}/u",
    pathParams: { namespaceName: namespace, bucketName },
    headers: buildCreateMultipartHeaders(),
    body: buildCreateMultipartDetails(),
  });
  if (!createRes.response.ok) {
    io.err(
      formatServiceError(
        { http: "POST", method: "create_multipart_upload" },
        stripQuery(createRes.url),
        createRes.response,
        createRes.raw,
        sc.targetService,
      ),
    );
    throw new Exit(1);
  }
  const uploadId = String(
    (JSON.parse(createRes.raw) as { uploadId?: string }).uploadId ?? "",
  );
  io.err(`Upload ID: ${uploadId}\n`);

  const parts = buildMultipartPutParts(totalSize, partSizeBytes);
  io.err(`Split file into ${parts.length} parts for upload.\n`);

  const partResults: (
    { partNum: number; etag: string; opcMd5: string } | undefined
  )[] = new Array(parts.length);
  let firstError: string | undefined;
  let nextIdx = 0;

  const fd = openSync(resolvedFilePath, "r");
  try {
    const workerCount = disableParallelUploads
      ? 1
      : Math.max(
          1,
          Math.min(
            parallelUploadCount ?? DEFAULT_PARALLEL_UPLOAD_COUNT,
            parts.length,
          ),
        );
    const workers = Array.from({ length: workerCount }, async () => {
      while (firstError === undefined) {
        const idx = nextIdx++;
        const part = parts[idx];
        if (!part) break;
        const partBytes = readPartFromFile(fd, part.offset, part.size);
        const partHeaders: Record<string, string> = {
          accept: "application/json",
          "content-type": "application/octet-stream",
          expect: "100-continue",
          ...sseHeaders,
        };
        if (algo) {
          partHeaders["opc-checksum-algorithm"] = String(
            values.opc_checksum_algorithm,
          );
          const computed = computePartChecksum(algo, partBytes);
          if (computed) partHeaders[computed.header] = computed.value;
        }
        const partRes = await sendServiceRequest(io, sc, {
          method: "PUT",
          pathTemplate: "/n/{namespaceName}/b/{bucketName}/u/{objectName}",
          pathParams,
          queryParams: [
            ["uploadId", uploadId],
            ["uploadPartNum", String(part.partNum)],
          ],
          headers: partHeaders,
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
          opcMd5: partRes.response.headers.get("opc-content-md5") ?? "",
        };
      }
    });
    await Promise.all(workers);
  } finally {
    closeSync(fd);
  }

  io.err("Uploading object\n");
  if (firstError !== undefined) {
    io.err(firstError);
    throw new Exit(1);
  }

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

  if (values.verify_checksum === true) {
    const localMd5 = computeMultipartMd5(partMd5s);
    const serverMd5 =
      commitRes.response.headers.get("opc-content-md5") ??
      commitRes.response.headers.get("opc-multipart-md5");
    const match = localMd5 === serverMd5;
    io.err(
      `md5 checksum ${match ? "matches" : "does not match"} [Local: ${localMd5}]\n`,
    );
    if (!match) throw new Exit(1);
  }
}

/** Matches Python 3 `str(float)` formatting (e.g. `1.0`, `4.76837158203125e-06`). */

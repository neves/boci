// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { BadParameter, pyRepr } from "./convert.ts";
import { Exit, type Invocation } from "./io.ts";
import { parseJsonParameter } from "./json-input.ts";
import {
  type ClientSettings,
  type ServiceClient,
  createServiceClient,
  sendServiceRequest,
} from "./operation.ts";
import {
  type OutputOptions,
  formatServiceError,
  renderDocument,
} from "./output.ts";
import type { Index, ServiceSpec } from "./spec.ts";

const NAMESPACE_HOST_LABEL_PATTERN = /^[/A-Za-z0-9_.-]+$/;
const NAMESPACE_VALIDATION_ERROR =
  "must contain only letters, digits, underscores, hyphens, forward slashes and periods";
const SSE_ALGORITHM = "AES256";
const OBJECT_STORAGE_CLIENT = "object_storage.object_storage";
const OBJECT_PUT_DISPLAY_HEADERS = [
  "etag",
  "opc-content-md5",
  "last-modified",
  "opc-multipart-md5",
  "opc-content-crc32c",
  "opc-content-sha256",
  "opc-content-sha384",
  "opc-multipart-sha256",
  "opc-multipart-sha384",
] as const;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function computeCrc32cBase64(data: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc =
      (CRC32C_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^
      (crc >>> 8);
  }
  const value = (crc ^ 0xffffffff) >>> 0;
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return Buffer.from(out).toString("base64");
}

function guessContentType(filePath: string): string {
  const mime = Bun.file(filePath).type;
  if (!mime) return "application/octet-stream";
  const semi = mime.indexOf(";");
  return (
    (semi === -1 ? mime : mime.slice(0, semi)).trim() ||
    "application/octet-stream"
  );
}

export type OutputFileHandle = {
  rawPath: string;
  isStdout: boolean;
  fd?: number;
};

const ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: "No such file or directory",
  EISDIR: "Is a directory",
  EACCES: "Permission denied",
  ENOTDIR: "Not a directory",
  EROFS: "Read-only file system",
  EMFILE: "Too many open files",
  ENAMETOOLONG: "File name too long",
};

function osErrorReason(err: unknown): string {
  const e = err as NodeJS.ErrnoException | null;
  if (e?.code && ERRNO_MESSAGES[e.code])
    return ERRNO_MESSAGES[e.code] as string;
  const msg = e?.message ?? String(err);
  const stripped = msg.replace(/^[A-Z]+:\s*/, "").replace(/,\s*open\s+.*$/, "");
  return stripped || msg;
}

/** `validate_namespace_name` in objectstorage_cli_extended.py. */
export function validateOsNamespace(value: unknown): void {
  if (typeof value !== "string") return;
  if (
    !value ||
    value !== value.trim() ||
    !NAMESPACE_HOST_LABEL_PATTERN.test(value)
  ) {
    throw new BadParameter(NAMESPACE_VALIDATION_ERROR);
  }
}

/** Eager `click.File(mode='wb', lazy=False)`: opens the file during option conversion. */
export function openClickFileForWrite(
  io: Invocation,
  rawPath: string,
): OutputFileHandle {
  if (rawPath === "-") return { rawPath, isStdout: true };
  try {
    const fd = openSync(resolve(io.cwd, rawPath), "w");
    return { rawPath, isStdout: false, fd };
  } catch (e) {
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
  }
}

/** Eager `click.File(mode='r')`: checks the file can be opened during option conversion. */
export function validateClickFileForRead(
  io: Invocation,
  rawPath: string,
): void {
  if (rawPath === "-") return;
  let fd: number | undefined;
  try {
    fd = openSync(resolve(io.cwd, rawPath), "r");
    if (fstatSync(fd).isDirectory()) {
      throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
    }
  } catch (e) {
    if (e instanceof BadParameter) throw e;
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/** `_get_encryption_key_params`: read base64 AES-256 key and compute its SHA-256 header. */
export function readEncryptionKeyHeaders(
  io: Invocation,
  rawPath: string,
): Record<string, string> {
  const raw =
    rawPath === "-"
      ? (io.stdin ?? "")
      : readFileSync(resolve(io.cwd, rawPath), "utf8");
  const keyBase64 = raw.trim();
  const keyBytes = Buffer.from(keyBase64, "base64");
  const sha256Base64 = new Bun.CryptoHasher("sha256")
    .update(keyBytes)
    .digest("base64");
  return {
    "opc-sse-customer-algorithm": SSE_ALGORITHM,
    "opc-sse-customer-key": keyBase64,
    "opc-sse-customer-key-sha256": sha256Base64,
  };
}

/** Resolve omitted Object Storage namespace internally via `GET /n`. */
export async function resolveOsNamespace(
  io: Invocation,
  sc: ServiceClient,
  usageText: () => string,
  paramName = "namespace",
): Promise<string> {
  try {
    const res = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/n",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    if (!res.response.ok) throw new Error(`HTTP ${res.response.status}`);
    let ns: unknown;
    try {
      ns = JSON.parse(res.raw);
    } catch {
      ns = res.raw.trim();
    }
    if (typeof ns === "string" && ns.length > 0) return ns;
    throw new Error("empty namespace");
  } catch (e) {
    if (e instanceof Exit) throw e;
    io.err(
      `${usageText()}\n\nError: Unable to retrieve namespace internally. Please provide the namespace using the option "--['${paramName}']".\n`,
    );
    throw new Exit(1);
  }
}

export type OsObjectGetOptions = {
  values: Record<string, unknown>;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  spec: Pick<ServiceSpec, "clients">;
  index: Pick<Index, "regions">;
  usageText: () => string;
  outputFile?: OutputFileHandle;
};

const MEBIBYTE = 1024 * 1024;
const DEFAULT_PART_SIZE_BYTES = 128 * MEBIBYTE;
const DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB = 128;
const DEFAULT_PARALLEL_DOWNLOAD_COUNT = 10;
const PROGRESS_BAR_GRANULARITY = 10000;

function createChunkWriter(io: Invocation, outputFile: OutputFileHandle) {
  if (outputFile.isStdout) {
    if (io.outBytes) {
      return {
        write: (chunk: Uint8Array) => io.outBytes?.(chunk),
        finish: () => {},
      };
    }
    const decoder = new TextDecoder();
    return {
      write: (chunk: Uint8Array) =>
        io.out(decoder.decode(chunk, { stream: true })),
      finish: () => {
        const tail = decoder.decode();
        if (tail) io.out(tail);
      },
    };
  }
  const fd = outputFile.fd as number;
  return {
    write: (chunk: Uint8Array) => {
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
    },
    finish: () => {},
  };
}

function createNonTtyProgressTracker(
  io: Invocation,
  totalBytes: number,
  label: string,
  enabled: boolean,
) {
  const denom = totalBytes === 0 ? 1 : totalBytes;
  let progressBytes = 0;
  let printed = false;
  return {
    update(bytes: number) {
      if (!enabled || bytes <= 0) return;
      progressBytes += bytes;
      if (!printed && PROGRESS_BAR_GRANULARITY * (progressBytes / denom) >= 1) {
        io.err(`${label}\n`);
        printed = true;
      }
    },
  };
}

/** Matches `GetObjectMultipartTask` byte-range partitioning in object_storage_transfer_manager. */
export function buildMultipartGetRanges(
  contentLength: number,
  partSizeBytes: number,
): { index: number; range: string }[] {
  const ranges: { index: number; range: string }[] = [];
  let startByte = 0;
  let endByte = partSizeBytes - 1;
  let index = 0;
  while (endByte < contentLength) {
    if (startByte !== endByte) {
      ranges.push({ index, range: `bytes=${startByte}-${endByte}` });
    }
    index += 1;
    startByte += partSizeBytes;
    endByte += partSizeBytes;
    if (startByte >= contentLength) break;
    if (endByte >= contentLength) endByte = contentLength - 1;
  }
  return ranges;
}

async function readResponseBytes(
  response: Response,
  onChunk?: (byteLength: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 0) onChunk?.(bytes.length);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
        onChunk?.(value.length);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** `oci os object get` (single-part and multipart). */
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

export type OsObjectPutOptions = {
  values: Record<string, unknown>;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  spec: Pick<ServiceSpec, "clients">;
  index: Pick<Index, "regions">;
  usageText: () => string;
  outputOptions: OutputOptions;
};

async function confirmPrompt(io: Invocation, prompt: string): Promise<boolean> {
  const stdinLines =
    io.readLine === undefined && io.stdin !== undefined
      ? io.stdin.split(/\r?\n/)
      : null;
  let lineIndex = 0;
  while (true) {
    io.out(`${prompt} [y/N]: `);
    const line = io.readLine
      ? await io.readLine()
      : stdinLines !== null && lineIndex < stdinLines.length
        ? (stdinLines[lineIndex++] as string)
        : null;
    if (line === null) {
      io.err("Abort: \n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes" || normalized === "1")
      return true;
    if (
      normalized === "" ||
      normalized === "n" ||
      normalized === "no" ||
      normalized === "0"
    )
      return false;
    io.err("Error: invalid input\n");
  }
}

function usageError(io: Invocation, message: string): never {
  io.err(`UsageError: ${message}\n`);
  throw new Exit(1);
}

/** `oci os object put` (single-part). */
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

  const putHeaders: Record<string, string> = {
    accept: "application/json",
    expect: "100-continue",
  };

  const finalIfMatch =
    typeof values.if_match === "string" ? values.if_match : resolvedIfMatch;
  if (finalIfMatch !== undefined) putHeaders["if-match"] = finalIfMatch;
  if (ifNoneMatch !== undefined) putHeaders["if-none-match"] = ifNoneMatch;

  if (typeof values.content_md5 === "string")
    putHeaders["content-md5"] = values.content_md5;
  if (typeof values.opc_checksum_algorithm === "string")
    putHeaders["opc-checksum-algorithm"] = values.opc_checksum_algorithm;
  if (typeof values.opc_content_crc32c === "string")
    putHeaders["opc-content-crc32c"] = values.opc_content_crc32c;
  if (typeof values.opc_content_sha256 === "string")
    putHeaders["opc-content-sha256"] = values.opc_content_sha256;
  if (typeof values.opc_content_sha384 === "string")
    putHeaders["opc-content-sha384"] = values.opc_content_sha384;

  if (values.metadata !== undefined) {
    const parsedMeta = parseJsonParameter(io, "metadata", values.metadata);
    if (
      parsedMeta &&
      typeof parsedMeta === "object" &&
      !Array.isArray(parsedMeta)
    ) {
      for (const [k, v] of Object.entries(
        parsedMeta as Record<string, unknown>,
      )) {
        putHeaders[`opc-meta-${k}`] = String(v);
      }
    }
  }

  if (typeof values.content_type === "string") {
    putHeaders["content-type"] =
      values.content_type === "auto"
        ? guessContentType(isStdin ? objectName : filePath)
        : values.content_type;
  } else {
    putHeaders["content-type"] = "application/octet-stream";
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

  if (typeof values.encryption_key_file === "string") {
    Object.assign(
      putHeaders,
      readEncryptionKeyHeaders(io, values.encryption_key_file),
    );
  }

  if (isStdin) {
    if (noMultipart) {
      usageError(
        io,
        "The --no-multipart flag is not valid when taking input from STDIN.",
      );
    }
    io.err(
      "boci: 'oci os object put' from STDIN (multipart) is not implemented yet.\n",
    );
    throw new Exit(3);
  }

  const fileBytes = new Uint8Array(readFileSync(resolve(io.cwd, filePath)));
  const totalSize = fileBytes.byteLength;
  const partSizeBytes =
    partSizeMib !== undefined
      ? partSizeMib * MEBIBYTE
      : DEFAULT_PART_SIZE_BYTES;
  const sizeQualifiesForMultipart = totalSize > partSizeBytes;

  if (totalSize > 0 && !noMultipart && sizeQualifiesForMultipart) {
    io.err(
      "boci: multipart upload for 'oci os object put' is not implemented yet.\n",
    );
    throw new Exit(3);
  }

  if (parallelUploadCount !== undefined) {
    io.err(
      "Warning: File is being uploaded as a single part so --parallel-upload-count will be ignored.\n",
    );
  }

  const algo =
    typeof values.opc_checksum_algorithm === "string"
      ? values.opc_checksum_algorithm.toUpperCase()
      : undefined;
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
    if (algo === "CRC32C") {
      putHeaders["opc-content-crc32c"] = computeCrc32cBase64(fileBytes);
    } else if (algo === "SHA256") {
      putHeaders["opc-content-sha256"] = new Bun.CryptoHasher("sha256")
        .update(fileBytes)
        .digest("base64");
    } else if (algo === "SHA384") {
      putHeaders["opc-content-sha384"] = new Bun.CryptoHasher("sha384")
        .update(fileBytes)
        .digest("base64");
    }
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

  const displayHeaders: Record<string, string> = {};
  for (const name of OBJECT_PUT_DISPLAY_HEADERS) {
    const val = put.response.headers.get(name);
    if (val !== null) displayHeaders[name] = val;
  }
  renderDocument(io, displayHeaders, outputOptions);

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
}

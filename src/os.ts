// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";
import { expandUser } from "./config.ts";
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
import { expandVars } from "./rc.ts";
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

const OCTET_STREAM_EXTENSIONS = new Set([
  ".bin",
  ".dms",
  ".lrf",
  ".mar",
  ".so",
  ".dist",
  ".distz",
  ".pkg",
  ".bpk",
  ".dump",
  ".elc",
  ".deploy",
  ".exe",
  ".dll",
  ".deb",
  ".dmg",
  ".iso",
  ".img",
  ".msi",
  ".msp",
  ".msm",
  ".buffer",
  ".a",
  ".o",
  ".obj",
]);

function guessContentTypeOptional(filePath: string): string | undefined {
  const mime = Bun.file(filePath).type;
  if (!mime) return undefined;
  const semi = mime.indexOf(";");
  const clean = (semi === -1 ? mime : mime.slice(0, semi)).trim();
  if (!clean) return undefined;
  if (
    clean === "application/octet-stream" &&
    !OCTET_STREAM_EXTENSIONS.has(extname(filePath).toLowerCase())
  ) {
    return undefined;
  }
  return clean;
}

function guessContentType(filePath: string): string {
  return guessContentTypeOptional(filePath) ?? "application/octet-stream";
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

const STREAMING_DEFAULT_PART_SIZE_BYTES = 10 * MEBIBYTE;
const DEFAULT_PARALLEL_UPLOAD_COUNT = 10;
const MAX_MULTIPART_PARTS = 10000;
const MULTIPART_UPLOAD_ERROR_MESSAGE =
  "MultipartUploadError: MultipartUploadError exception has occurred. Client Version: Oracle-PythonSDK/2.192.0, OS Version: <os>, See https://docs.oracle.com/iaas/Content/API/Concepts/sdk_troubleshooting.htm for common issues and steps to resolve them. If you need to contact support, or file a GitHub issue, please include this full error message.\n";

function stripQuery(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function computePartChecksum(
  algo: string,
  data: Uint8Array,
): { header: string; value: string } | undefined {
  if (algo === "CRC32C") {
    return { header: "opc-content-crc32c", value: computeCrc32cBase64(data) };
  }
  if (algo === "SHA256") {
    return {
      header: "opc-content-sha256",
      value: new Bun.CryptoHasher("sha256").update(data).digest("base64"),
    };
  }
  if (algo === "SHA384") {
    return {
      header: "opc-content-sha384",
      value: new Bun.CryptoHasher("sha384").update(data).digest("base64"),
    };
  }
  return undefined;
}

export function computeMultipartMd5(partMd5Base64s: string[]): string {
  const hasher = new Bun.CryptoHasher("md5");
  for (const partMd5 of partMd5Base64s) {
    hasher.update(Buffer.from(partMd5, "base64"));
  }
  return `${hasher.digest("base64")}-${partMd5Base64s.length}`;
}

/** Matches `MultipartObjectAssembler.add_parts_from_file` partitioning + 10,000-part cap. */
export function resolveMultipartPartSize(
  totalSize: number,
  requestedPartSizeMib?: number,
): { effectivePartSizeMib?: number; partSizeBytes: number } {
  let effectivePartSizeMib = requestedPartSizeMib;
  let partSizeBytes =
    effectivePartSizeMib !== undefined
      ? effectivePartSizeMib * MEBIBYTE
      : DEFAULT_PART_SIZE_BYTES;
  if (
    totalSize > 0 &&
    partSizeBytes > 0 &&
    Math.ceil(totalSize / partSizeBytes) > MAX_MULTIPART_PARTS
  ) {
    effectivePartSizeMib = Math.ceil(
      Math.ceil(totalSize / MAX_MULTIPART_PARTS) / MEBIBYTE,
    );
    partSizeBytes = effectivePartSizeMib * MEBIBYTE;
  }
  return { effectivePartSizeMib, partSizeBytes };
}

export function buildMultipartPutParts(
  totalSize: number,
  partSizeBytes: number,
): { partNum: number; offset: number; size: number }[] {
  const parts: { partNum: number; offset: number; size: number }[] = [];
  let offset = 0;
  let partNum = 1;
  while (offset < totalSize) {
    const remaining = totalSize - offset;
    const size = remaining > partSizeBytes ? partSizeBytes : remaining;
    parts.push({ partNum, offset, size });
    offset += size;
    partNum += 1;
  }
  return parts;
}

function readPartFromFile(
  fd: number,
  offset: number,
  size: number,
): Uint8Array {
  const buf = new Uint8Array(size);
  let pos = 0;
  while (pos < size) {
    const n = readSync(fd, buf, pos, size - pos, offset + pos);
    if (n === 0) break;
    pos += n;
  }
  return pos === size ? buf : buf.subarray(0, pos);
}

async function* readStdinParts(
  io: Invocation,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  const source: AsyncIterable<Uint8Array> = io.stdinBytes
    ? io.stdinBytes()
    : (async function* () {
        if (io.stdin && io.stdin.length > 0) {
          yield new TextEncoder().encode(io.stdin);
        }
      })();
  const pending: Uint8Array[] = [];
  let buffered = 0;

  const takeBytes = (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count && pending.length > 0) {
      const head = pending[0] as Uint8Array;
      const need = count - written;
      if (head.byteLength <= need) {
        out.set(head, written);
        written += head.byteLength;
        pending.shift();
      } else {
        out.set(head.subarray(0, need), written);
        written += need;
        pending[0] = head.subarray(need);
      }
    }
    buffered -= count;
    return out;
  };

  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    pending.push(chunk);
    buffered += chunk.byteLength;
    while (buffered >= partSize) {
      yield takeBytes(partSize);
    }
  }
  if (buffered > 0) {
    yield takeBytes(buffered);
  }
}

function renderObjectPutHeaders(
  io: Invocation,
  headers: Headers,
  outputOptions: OutputOptions,
): void {
  const displayHeaders: Record<string, string> = {};
  for (const name of OBJECT_PUT_DISPLAY_HEADERS) {
    const val = headers.get(name);
    if (val !== null) displayHeaders[name] = val;
  }
  renderDocument(io, displayHeaders, outputOptions);
}

/** `oci os object put` (single-part, multipart, and stdin). */
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
export function pyFloatRepr(n: number): string {
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(n);
  if (abs < 1e-4 || abs >= 1e16) {
    return n.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  const s = String(n);
  return s.includes(".") ? s : `${s}.0`;
}

/** `oci os object resume-put`. */
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

const BULK_PUT_DISPLAY_HEADERS = [
  "etag",
  "opc-content-md5",
  "last-modified",
  "opc-multipart-md5",
] as const;

function pyPathJoin(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  if (!base || base.endsWith("/")) return `${base}${rel}`;
  return `${base}/${rel}`;
}

/** Matches Python 3 `fnmatch.translate` (POSIX case-sensitive, `*` crosses `/`). */
export function fnmatchToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i] as string;
    i++;
    if (ch === "*") {
      while (i < n && pattern[i] === "*") i++;
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      let j = i;
      if (j < n && pattern[j] === "!") j++;
      if (j < n && pattern[j] === "]") j++;
      while (j < n && pattern[j] !== "]") j++;
      if (j >= n) {
        out += "\\[";
      } else {
        let stuff = pattern.slice(i, j).replaceAll("\\", "\\\\");
        if (stuff.startsWith("!")) {
          stuff = `^${stuff.slice(1)}`;
        } else if (stuff.startsWith("^") || stuff.startsWith("[")) {
          stuff = `\\${stuff}`;
        }
        out += `[${stuff}]`;
        i = j + 1;
      }
    } else {
      out += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

export function formatBulkProgressLabel(
  io: Invocation,
  objectName: string,
  prefix = "Processing",
): string {
  const envCols = Number(io.env.COLUMNS);
  const columns =
    Number.isFinite(envCols) && envCols > 0
      ? Math.floor(envCols)
      : io.isTTY(2) && process.stderr.columns
        ? process.stderr.columns
        : 80;
  const terminalWidth = columns / 2;
  const remainingWidth = terminalWidth - (prefix.length + 1);
  let nameToUse = objectName;
  if (objectName.length > remainingWidth) {
    const lastSlash = objectName.lastIndexOf("/");
    const tail =
      lastSlash === -1 ? objectName : objectName.slice(lastSlash + 1);
    nameToUse =
      tail.length > remainingWidth || tail.length === 0 ? "item" : tail;
  }
  return `${prefix} ${nameToUse}`;
}

export type WalkEntry = {
  fullFilePath: string;
  resolvedFilePath: string;
};

/** Top-down directory walk matching `os.walk(expandedDir, followlinks=not noFollowSymlinks)`. */
export function walkDirectoryForBulkUpload(
  io: Invocation,
  expandedDir: string,
  noFollowSymlinks: boolean,
): WalkEntry[] {
  const resolvedRoot = resolve(io.cwd, expandedDir);
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(resolvedRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const entries: WalkEntry[] = [];
  const visit = (
    displayDir: string,
    resolvedDir: string,
    ancestors: Set<string>,
  ) => {
    let names: string[];
    try {
      names = readdirSync(resolvedDir);
    } catch {
      return;
    }
    const subdirs: {
      display: string;
      resolved: string;
      key?: string;
    }[] = [];
    const files: WalkEntry[] = [];

    for (const name of names) {
      const childDisplay = pyPathJoin(displayDir, name);
      const childResolved = resolve(resolvedDir, name);
      let lst: ReturnType<typeof lstatSync>;
      try {
        lst = lstatSync(childResolved);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        if (noFollowSymlinks) continue;
        try {
          const targetStat = statSync(childResolved);
          if (targetStat.isDirectory()) {
            const key = `${targetStat.dev}:${targetStat.ino}`;
            if (!ancestors.has(key)) {
              subdirs.push({
                display: childDisplay,
                resolved: childResolved,
                key,
              });
            }
          } else {
            files.push({
              fullFilePath: childDisplay,
              resolvedFilePath: childResolved,
            });
          }
        } catch {
          // Broken symlink: os.walk yields it as a file; stat fails during upload.
          files.push({
            fullFilePath: childDisplay,
            resolvedFilePath: childResolved,
          });
        }
      } else if (lst.isDirectory()) {
        subdirs.push({
          display: childDisplay,
          resolved: childResolved,
          key: `${lst.dev}:${lst.ino}`,
        });
      } else {
        files.push({
          fullFilePath: childDisplay,
          resolvedFilePath: childResolved,
        });
      }
    }

    for (const f of files) entries.push(f);
    for (const sub of subdirs) {
      const nextAncestors = new Set(ancestors);
      if (sub.key) nextAncestors.add(sub.key);
      visit(sub.display, sub.resolved, nextAncestors);
    }
  };

  visit(
    expandedDir,
    resolvedRoot,
    new Set([`${rootStat.dev}:${rootStat.ino}`]),
  );
  return entries;
}

function filterBulkPutHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const name of BULK_PUT_DISPLAY_HEADERS) {
    const val = headers.get(name);
    if (val !== null) filtered[name] = val;
  }
  return filtered;
}

function normalizeStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}

/** `oci os object bulk-upload`. */
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
    accessSync(resolvedSrcDir, fsConstants.R_OK);
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

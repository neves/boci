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

export const SSE_ALGORITHM = "AES256";
export const OBJECT_STORAGE_CLIENT = "object_storage.object_storage";
export const OBJECT_PUT_DISPLAY_HEADERS = [
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

export const CRC32C_TABLE = (() => {
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

export const OCTET_STREAM_EXTENSIONS = new Set([
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

export function guessContentTypeOptional(filePath: string): string | undefined {
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

export function guessContentType(filePath: string): string {
  return guessContentTypeOptional(filePath) ?? "application/octet-stream";
}

export {
  type OutputFileHandle,
  openClickFileForWrite,
  validateClickFileForRead,
  validateOsNamespace,
} from "../../core/click-file.ts";

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

export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_PART_SIZE_BYTES = 128 * MEBIBYTE;
export const DEFAULT_MULTIPART_DOWNLOAD_THRESHOLD_MIB = 128;
export const DEFAULT_PARALLEL_DOWNLOAD_COUNT = 10;
export const PROGRESS_BAR_GRANULARITY = 10000;

export function createChunkWriter(
  io: Invocation,
  outputFile: OutputFileHandle,
) {
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

export function createNonTtyProgressTracker(
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

export async function readResponseBytes(
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

export type OsObjectPutOptions = {
  values: Record<string, unknown>;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  spec: Pick<ServiceSpec, "clients">;
  index: Pick<Index, "regions">;
  usageText: () => string;
  outputOptions: OutputOptions;
};

export async function confirmPrompt(
  io: Invocation,
  prompt: string,
): Promise<boolean> {
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

export function usageError(io: Invocation, message: string): never {
  io.err(`UsageError: ${message}\n`);
  throw new Exit(1);
}

export const STREAMING_DEFAULT_PART_SIZE_BYTES = 10 * MEBIBYTE;
export const DEFAULT_PARALLEL_UPLOAD_COUNT = 10;
export const MAX_MULTIPART_PARTS = 10000;
export const MULTIPART_UPLOAD_ERROR_MESSAGE =
  "MultipartUploadError: MultipartUploadError exception has occurred. Client Version: Oracle-PythonSDK/2.192.0, OS Version: <os>, See https://docs.oracle.com/iaas/Content/API/Concepts/sdk_troubleshooting.htm for common issues and steps to resolve them. If you need to contact support, or file a GitHub issue, please include this full error message.\n";

export function stripQuery(url: URL): string {
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

export function readPartFromFile(
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

export async function* readStdinParts(
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

export function renderObjectPutHeaders(
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

export const BULK_PUT_DISPLAY_HEADERS = [
  "etag",
  "opc-content-md5",
  "last-modified",
  "opc-multipart-md5",
] as const;

export function pyPathJoin(base: string, rel: string): string {
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

export function filterBulkPutHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const name of BULK_PUT_DISPLAY_HEADERS) {
    const val = headers.get(name);
    if (val !== null) filtered[name] = val;
  }
  return filtered;
}

export function normalizeStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}

/** `oci os object bulk-upload`. */

export const OBJECT_LIST_PAGE_SIZE_BULK_OPERATIONS = 1000;

/** Matches Python's `posixpath.dirname` (keeps `dest/sub` for `dest/sub/`). */
export function pyDirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  let head = p.slice(0, i);
  if (head && !/^\/+$/.test(head)) {
    head = head.replace(/\/+$/, "");
  }
  return head;
}

export function writeAllToFd(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

export async function downloadSinglePartToFile(
  io: Invocation,
  sc: ServiceClient,
  namespace: string,
  bucketName: string,
  sseHeaders: Record<string, string>,
  objectName: string,
  resolvedFilePath: string,
): Promise<void> {
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
          if (value?.length) writeAllToFd(fd, value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const bytes = new Uint8Array(await getRes.response.arrayBuffer());
      if (bytes.length) writeAllToFd(fd, bytes);
    }
  } finally {
    closeSync(fd);
  }
}

export function createLineReader(io: Invocation): () => Promise<string | null> {
  if (io.readLine) {
    const readLine = io.readLine.bind(io);
    return () => readLine();
  }
  if (io.stdin === undefined || io.stdin.length === 0) return async () => null;
  const lines = io.stdin.split(/\r?\n/);
  if (io.stdin.endsWith("\n")) lines.pop();
  let idx = 0;
  return async () => (idx < lines.length ? (lines[idx++] as string) : null);
}

export async function confirmPromptWithReader(
  io: Invocation,
  readLine: () => Promise<string | null>,
  prompt: string,
): Promise<boolean> {
  while (true) {
    io.out(`${prompt} [y/N]: `);
    const line = await readLine();
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

export async function promptOverwriteChoice(
  io: Invocation,
  readLine: () => Promise<string | null>,
  objectName: string,
): Promise<"Y" | "N" | "A"> {
  const prompt = `WARNING: ${objectName} already exists. Are you sure you want to overwrite it? [y/N/yes to (a)ll] (Y, N, A) [N]: `;
  while (true) {
    io.out(prompt);
    const line = await readLine();
    if (line === null) {
      io.err("Aborted!\n");
      throw new Exit(1);
    }
    const normalized = line.trim().toUpperCase();
    if (normalized === "") return "N";
    if (normalized === "Y" || normalized === "N" || normalized === "A") {
      return normalized;
    }
    io.err(`Error: invalid choice: ${line.trim()}. (choose from Y, N, A)\n`);
  }
}

/** Matches `_get_file_filter_collection` in objectstorage_cli_extended.py. */
export function buildBulkDownloadFilter(
  expandedDirectory: string,
  include: string[],
  exclude: string[],
  prefix: string | undefined,
): (fullFilePath: string) => boolean {
  const compile = (patterns: string[]): RegExp[] => {
    const regexes: RegExp[] = [];
    for (const pat of patterns) {
      if (prefix?.includes("/")) {
        regexes.push(
          fnmatchToRegex(
            pyPathJoin(expandedDirectory, pyPathJoin(prefix, pat)),
          ),
        );
      }
      regexes.push(fnmatchToRegex(pyPathJoin(expandedDirectory, pat)));
    }
    return regexes;
  };
  if (include.length > 0) {
    const regexes = compile(include);
    return (fullFilePath) => regexes.some((re) => re.test(fullFilePath));
  }
  if (exclude.length > 0) {
    const regexes = compile(exclude);
    return (fullFilePath) => !regexes.some((re) => re.test(fullFilePath));
  }
  return () => true;
}

export type ListedObject = {
  name?: unknown;
  size?: unknown;
  timeModified?: unknown;
  archivalState?: unknown;
};

/** `oci os object bulk-download`. */

export const DEFAULT_PARALLEL_DELETE_COUNT = 10;

export function renderBulkDeleteOutput(
  io: Invocation,
  deletedObjects: string[],
  deleteFailures: Record<string, string>,
  outputOptions: OutputOptions,
  dryRun: boolean,
): void {
  const outputFormat = outputOptions.output ?? "json";
  if (outputFormat === "table") {
    const rows: Record<string, unknown>[] = [];
    for (const [name, failure] of Object.entries(deleteFailures)) {
      rows.push({
        action: "Failed",
        object: name,
        "error-message": failure,
      });
    }
    for (const deleted of deletedObjects) {
      rows.push({
        action: dryRun ? "Dry Run" : "Deleted",
        type: "object",
        name: deleted,
      });
    }
    renderDocument(io, rows, outputOptions);
  } else {
    renderDocument(
      io,
      {
        "delete-failures": deleteFailures,
        "deleted-objects": deletedObjects,
      },
      outputOptions,
    );
  }
}

/** `oci os object bulk-delete`. */

export function parseIsoTimeTruncatedToSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Number.NaN;
  return Math.floor(ms / 1000) * 1000;
}

/** Matches `requires_sync` in objectstorage_cli_extended.py. */
export function requiresSync(
  resolvedFilePath: string,
  remoteSize: number | undefined,
  remoteMtimeMs: number | undefined,
  toRemote: boolean,
): boolean {
  const st = statSync(resolvedFilePath, { bigint: true });
  const localSize = Number(st.size);
  if (remoteSize === undefined || localSize !== remoteSize) return true;
  if (remoteMtimeMs === undefined || !Number.isFinite(remoteMtimeMs))
    return true;
  const localMtimeUs = (st.mtimeNs + 500n) / 1000n;
  const remoteMtimeUs = BigInt(Math.trunc(remoteMtimeMs)) * 1000n;
  return toRemote ? localMtimeUs > remoteMtimeUs : localMtimeUs < remoteMtimeUs;
}

export type SyncWalkEntry = {
  fullFilePath: string;
  resolvedFilePath: string;
  emptyFolder: boolean;
};

/** Top-down walk matching `os.walk(expandedDir, followlinks=not noFollowSymlinks)` with empty-folder detection for sync. */
export function walkDirectoryForSyncUpload(
  io: Invocation,
  expandedDir: string,
  noFollowSymlinks: boolean,
): SyncWalkEntry[] {
  const resolvedRoot = resolve(io.cwd, expandedDir);
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(resolvedRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const entries: SyncWalkEntry[] = [];
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

    if (names.length === 0 && displayDir !== expandedDir) {
      entries.push({
        fullFilePath: `${displayDir}/`,
        resolvedFilePath: resolvedDir,
        emptyFolder: true,
      });
      return;
    }

    const subdirs: {
      display: string;
      resolved: string;
      key?: string;
    }[] = [];
    const files: SyncWalkEntry[] = [];

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
              emptyFolder: false,
            });
          }
        } catch {
          files.push({
            fullFilePath: childDisplay,
            resolvedFilePath: childResolved,
            emptyFolder: false,
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
          emptyFolder: false,
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

export type BottomUpDirEntry = {
  dirDisplay: string;
  dirResolved: string;
  files: {
    name: string;
    fullFilePath: string;
    resolvedFilePath: string;
    isLink: boolean;
  }[];
};

/** Bottom-up walk matching `os.walk(expandedDir, topdown=False, followlinks=not noFollowSymlinks)`. */
export function walkDirectoryBottomUpForDelete(
  io: Invocation,
  expandedDir: string,
  noFollowSymlinks: boolean,
): BottomUpDirEntry[] {
  const resolvedRoot = resolve(io.cwd, expandedDir);
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(resolvedRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const result: BottomUpDirEntry[] = [];
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
    const files: BottomUpDirEntry["files"] = [];

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
        let isDirTarget = false;
        let targetKey: string | undefined;
        try {
          const targetStat = statSync(childResolved);
          if (targetStat.isDirectory()) {
            isDirTarget = true;
            targetKey = `${targetStat.dev}:${targetStat.ino}`;
          }
        } catch {
          // Broken symlink -> treated as a file by os.walk
        }
        if (isDirTarget) {
          if (!noFollowSymlinks && (!targetKey || !ancestors.has(targetKey))) {
            subdirs.push({
              display: childDisplay,
              resolved: childResolved,
              key: targetKey,
            });
          }
        } else {
          files.push({
            name,
            fullFilePath: childDisplay,
            resolvedFilePath: childResolved,
            isLink: true,
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
          name,
          fullFilePath: childDisplay,
          resolvedFilePath: childResolved,
          isLink: false,
        });
      }
    }

    for (const sub of subdirs) {
      const nextAncestors = new Set(ancestors);
      if (sub.key) nextAncestors.add(sub.key);
      visit(sub.display, sub.resolved, nextAncestors);
    }
    result.push({ dirDisplay: displayDir, dirResolved: resolvedDir, files });
  };

  visit(
    expandedDir,
    resolvedRoot,
    new Set([`${rootStat.dev}:${rootStat.ino}`]),
  );
  return result;
}

/** `oci os object sync`. */

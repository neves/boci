// Object Storage custom commands (`oci os object ...`), matching
// services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py.
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { BadParameter, pyRepr } from "./convert.ts";
import { Exit, type Invocation } from "./io.ts";
import {
  type ClientSettings,
  type ServiceClient,
  createServiceClient,
  sendServiceRequest,
} from "./operation.ts";
import { formatServiceError } from "./output.ts";
import type { Index, ServiceSpec } from "./spec.ts";

const NAMESPACE_HOST_LABEL_PATTERN = /^[/A-Za-z0-9_.-]+$/;
const NAMESPACE_VALIDATION_ERROR =
  "must contain only letters, digits, underscores, hyphens, forward slashes and periods";
const SSE_ALGORITHM = "AES256";
const OBJECT_STORAGE_CLIENT = "object_storage.object_storage";

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
  try {
    const fd = openSync(resolve(io.cwd, rawPath), "r");
    closeSync(fd);
  } catch (e) {
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
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

/** `oci os object get` (single-part). */
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

    // 2. Single-part GET object.
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

    const writeChunk = (() => {
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
    })();

    let bytesWritten = 0;
    if (get.response.body) {
      const reader = get.response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            writeChunk.write(value);
            bytesWritten += value.length;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const bytes = new Uint8Array(await get.response.arrayBuffer());
      if (bytes.length > 0) {
        writeChunk.write(bytes);
        bytesWritten += bytes.length;
      }
    }
    writeChunk.finish();

    if (!outputFile.isStdout && bytesWritten > 0) {
      io.err("Downloading object\n");
    }
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

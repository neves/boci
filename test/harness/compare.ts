import { createVerify } from "node:crypto";
// Normalise a Run so the Reference CLI's observation and boci's compare with toEqual.
import type { CapturedRequest } from "./fake-endpoint.ts";
import { applyMasks, IGNORED_REQUEST_HEADERS, maskStderr } from "./masks.ts";
import type { Run } from "./runner.ts";

export type Authorization = {
  scheme: string;
  algorithm?: string;
  headers?: string;
  keyId?: string;
  version?: string;
};

/** `Signature k="v",...` → fields, without the signature value itself. */
export function parseAuthorization(value: string): Authorization {
  const space = value.indexOf(" ");
  const out: Authorization = { scheme: value.slice(0, space) };
  for (const m of value.slice(space + 1).matchAll(/(\w+)="([^"]*)"/g)) {
    const [, k, v] = m;
    if (k && k !== "signature") (out as Record<string, string>)[k] = v ?? "";
  }
  return out;
}

export type NormalizedRequest = {
  method: string;
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  authorization?: Authorization;
  body: unknown;
};

export type NormalizedRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  requests: NormalizedRequest[];
};

function body(text: string): unknown {
  if (text === "") return "";
  try {
    return { json: JSON.parse(text) };
  } catch {
    return text;
  }
}

function normalizeRequest(req: CapturedRequest): NormalizedRequest {
  const headers: Record<string, string> = {};
  let authorization: Authorization | undefined;
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "authorization") authorization = parseAuthorization(v);
    else if (!(k in IGNORED_REQUEST_HEADERS)) headers[k] = v;
  }
  return {
    method: req.method,
    path: req.path,
    query: req.query,
    headers,
    authorization,
    body: body(req.body),
  };
}

export const mask = applyMasks;

export function normalizeRun(run: Run): NormalizedRun {
  return {
    stdout: mask(run.stdout),
    stderr: maskStderr(run.stderr),
    exitCode: run.exitCode,
    requests: run.requests.map(normalizeRequest),
  };
}

/** Re-apply the current output masks to a stored observation (goldens predate new masks). */
export function remask(run: NormalizedRun): NormalizedRun {
  return { ...run, stdout: mask(run.stdout), stderr: mask(run.stderr) };
}

/** boci's exit status and stderr marker for a command it has no implementation for. */
const NOT_IMPLEMENTED_EXIT = 3;
// The line src/core/cli.ts prints, not any mention of the phrase (a crash's stack trace can quote source).
const NOT_IMPLEMENTED_LINE = /^boci: '[^'\n]*' is not implemented yet/m;

/**
 * A `requestOnly` case ignores output differences, but not ones that mean boci never ran
 * the command: a "not implemented" exit, or sending a request where the Reference CLI
 * sent none (or the reverse). Returns why the case fails, or undefined when it may go on
 * to compare requests.
 */
export function requestOnlyMismatch(
  actual: NormalizedRun,
  expected: NormalizedRun,
): string | undefined {
  if (
    NOT_IMPLEMENTED_LINE.test(actual.stderr) &&
    !NOT_IMPLEMENTED_LINE.test(expected.stderr)
  )
    return `boci reports the command is not implemented: ${actual.stderr.trim()}`;
  if (
    actual.exitCode === NOT_IMPLEMENTED_EXIT &&
    expected.exitCode !== NOT_IMPLEMENTED_EXIT
  )
    return `boci exited ${NOT_IMPLEMENTED_EXIT} (not implemented); the Reference CLI exited ${expected.exitCode}`;
  const sent = actual.requests.length > 0;
  if (sent !== expected.requests.length > 0)
    return sent
      ? "boci sent a request; the Reference CLI sent none"
      : `the Reference CLI sent a request; boci sent none (exit ${actual.exitCode}: ${actual.stderr.trim()})`;
  return undefined;
}

/**
 * Check a captured request's signature against the signing string rebuilt from its own
 * headers, with the sandbox's public key. Goldens can only compare signature structure
 * (dates differ), so boci's requests are also verified cryptographically.
 */
export function signatureValid(
  req: CapturedRequest,
  publicKeyPem: string,
): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const signature = /signature="([^"]+)"/.exec(auth)?.[1];
  const names = parseAuthorization(auth).headers?.split(" ") ?? [];
  if (!signature) return false;
  const lines = names.map((n) => {
    if (n === "(request-target)") {
      return `(request-target): ${req.method.toLowerCase()} ${req.path}${req.rawQuery ? `?${req.rawQuery}` : ""}`;
    }
    return `${n}: ${req.headers[n] ?? ""}`;
  });
  return createVerify("sha256")
    .update(lines.join("\n"))
    .verify(publicKeyPem, signature, "base64");
}

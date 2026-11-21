// Normalise a Run so the Reference CLI's observation and boci's compare with toEqual.
import type { CapturedRequest } from "./fake-endpoint.ts";
import { IGNORED_REQUEST_HEADERS, OUTPUT_MASKS } from "./masks.ts";
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

export const mask = (s: string) =>
  OUTPUT_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), s);

export function normalizeRun(run: Run): NormalizedRun {
  return {
    stdout: mask(run.stdout),
    stderr: mask(run.stderr),
    exitCode: run.exitCode,
    requests: run.requests.map(normalizeRequest),
  };
}

/** Re-apply the current output masks to a stored observation (goldens predate new masks). */
export function remask(run: NormalizedRun): NormalizedRun {
  return { ...run, stdout: mask(run.stdout), stderr: mask(run.stderr) };
}

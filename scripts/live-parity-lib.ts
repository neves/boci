// Pure logic for `scripts/live-parity.ts`: read-only command discovery, live output
// normalization & comparison, rate-limit detection, crash-safe JSONL resume, and reporting.
import type { OperationSpec, ServiceSpec } from "../src/core/spec.ts";
import { applyMasks, maskStderr } from "../test/harness/masks.ts";

export type LiveContext = {
  profile: string;
  tenancy: string;
  user?: string;
  region?: string;
  namespace?: string;
  availabilityDomain?: string;
};

export type ReadCommandPlan = {
  key: string;
  service: string;
  argv: string[];
  kind: "generated" | "custom";
  httpMethods: string[];
};

export type CliSample = {
  exitCode: number;
  elapsedMs: number;
  stdout: string;
  stderr: string;
};

export type OutcomeKind = "ok" | "api-error" | "usage-error";

export type ComparisonResult = {
  match: boolean;
  outcome: OutcomeKind;
  diffs: string[];
  volatileReasons?: string[];
};

export type LiveParityRecord = {
  key: string;
  service: string;
  argv: string[];
  timestamp: string;
  oci: CliSample;
  boci: CliSample;
  speedup: number;
  status: "match" | "diverged";
  outcome: OutcomeKind;
  diffs: string[];
  volatileReasons?: string[];
};

export type LiveParitySummary = {
  totalPlanned: number;
  completed: number;
  remaining: number;
  matched: number;
  matchedExact: number;
  matchedVolatile: number;
  matchedOk: number;
  matchedApiError: number;
  matchedUsageError: number;
  diverged: number;
  ociTotalMs: number;
  bociTotalMs: number;
  ociMedianMs: number;
  bociMedianMs: number;
  overallSpeedup: number;
  medianSpeedup: number;
  servicesTested: number;
  divergedKeys: string[];
};

/** Services with local side effects, interactive flows, or arbitrary requests. */
const EXCLUDED_SERVICES = new Set([
  "setup",
  "session",
  "raw-request",
  "profile",
  "update",
]);

/** Parse `tenancy`, `user`, and `region` from an OCI CLI config file section. */
export function parseOciProfile(
  configText: string,
  profile: string,
): Pick<LiveContext, "tenancy" | "user" | "region"> {
  const sections = configText.split(/^\[/m);
  const section = sections.find((part) => part.startsWith(`${profile}]`));
  if (!section) {
    throw new Error(`OCI profile [${profile}] not found in ~/.oci/config`);
  }
  const get = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m").exec(section)?.[1];
  const tenancy = get("tenancy");
  if (!tenancy) {
    throw new Error(`tenancy missing from OCI profile [${profile}]`);
  }
  return {
    tenancy,
    user: get("user"),
    region: get("region"),
  };
}

function resolveRequiredOption(
  opts: string[],
  ctx: LiveContext,
): [string, string] | undefined {
  for (const opt of opts) {
    if (opt === "--compartment-id" || opt === "-c") {
      return ["--compartment-id", ctx.tenancy];
    }
    if (opt === "--tenancy-id") {
      return ["--tenancy-id", ctx.tenancy];
    }
    if (opt === "--user-id" && ctx.user) {
      return ["--user-id", ctx.user];
    }
    if ((opt === "--region" || opt === "--region-name") && ctx.region) {
      return [opt, ctx.region];
    }
    if (
      (opt === "--namespace-name" || opt === "--namespace" || opt === "-ns") &&
      ctx.namespace
    ) {
      return [opt === "-ns" ? "--namespace-name" : opt, ctx.namespace];
    }
    if (opt === "--availability-domain" && ctx.availabilityDomain) {
      return ["--availability-domain", ctx.availabilityDomain];
    }
  }
  return undefined;
}

function collectCommandOperations(
  cmd: ServiceSpec["commands"][string],
): OperationSpec[] {
  const ops: OperationSpec[] = [];
  if (cmd.operation) ops.push(cmd.operation);
  if (cmd.sdkOperations) ops.push(...cmd.sdkOperations);
  if (cmd.variants) {
    for (const v of cmd.variants) {
      if (v.operation) ops.push(v.operation);
    }
  }
  return ops;
}

/**
 * Build a deterministic, strictly READ-ONLY (GET/HEAD) command plan from loaded specs.
 * Every operation on an included command must be HTTP GET or HEAD, regional, non-streaming,
 * non-file-writing, and have all required parameters satisfiable from `ctx`.
 */
export function buildReadCommandPlan(
  specs: ServiceSpec[],
  ctx: LiveContext,
  filters?: { services?: string[]; filter?: string },
): ReadCommandPlan[] {
  const serviceFilter =
    filters?.services && filters.services.length > 0
      ? new Set(filters.services.map((s) => s.toLowerCase()))
      : undefined;
  const substringFilter = filters?.filter?.toLowerCase();

  const plan: ReadCommandPlan[] = [];

  for (const spec of specs) {
    const service = spec.service;
    if (EXCLUDED_SERVICES.has(service)) continue;
    if (serviceFilter && !serviceFilter.has(service.toLowerCase())) continue;

    for (const [cmdName, cmd] of Object.entries(spec.commands ?? {})) {
      if (cmd.hidden) continue;

      const key = `${service} ${cmdName}`;
      if (substringFilter && !key.toLowerCase().includes(substringFilter)) {
        continue;
      }

      const ops = collectCommandOperations(cmd);
      if (ops.length === 0) continue;

      // Strict READ-ONLY guard: every HTTP operation must be GET or HEAD.
      if (!ops.every((op) => op.http === "GET" || op.http === "HEAD")) {
        continue;
      }

      // Skip commands whose client requires a custom --endpoint (non-regional).
      if (
        ops.some((op) => spec.clients?.[op.client]?.regionalClient === false)
      ) {
        continue;
      }

      // Skip binary/stream responses and commands with a --file output parameter.
      if (ops.some((op) => op.responseType === "stream")) continue;
      const params = cmd.params ?? [];
      if (params.some((p) => (p.opts ?? []).includes("--file"))) continue;

      // Resolve all required parameters from the discovered read-only context.
      const requiredFlags: string[] = [];
      let satisfiable = true;
      for (const param of params) {
        if (!param.required) continue;
        const allOpts = [...(param.opts ?? []), ...(param.secondaryOpts ?? [])];
        const resolved = resolveRequiredOption(allOpts, ctx);
        if (!resolved) {
          satisfiable = false;
          break;
        }
        requiredFlags.push(resolved[0], resolved[1]);
      }
      if (!satisfiable) continue;

      const argv = [
        service,
        ...cmdName.split(" "),
        ...requiredFlags,
        "--no-retry",
      ];

      plan.push({
        key,
        service,
        argv,
        kind: cmd.kind,
        httpMethods: [...new Set(ops.map((o) => o.http))].sort(),
      });
    }
  }

  plan.sort((a, b) => a.key.localeCompare(b.key));
  return plan;
}

/** Detect OCI rate limiting (HTTP 429 / TooManyRequests) in CLI output. */
export function isRateLimited(sample: CliSample): boolean {
  if (sample.exitCode === 0) return false;
  const text = `${sample.stderr}\n${sample.stdout}`;
  return (
    /"status":\s*429\b/.test(text) ||
    /"code":\s*"TooManyRequests"/.test(text) ||
    /\bTooManyRequests\b/.test(text) ||
    /\bHTTP\s+429\b/i.test(text)
  );
}

/**
 * Normalize live CLI output so per-request dynamic server values (`opc-request-id`,
 * `timestamp`, and standard test masks) do not cause false-positive divergences.
 */
export function normalizeLiveOutput(
  text: string,
  stream: "stdout" | "stderr",
): string {
  const base = stream === "stderr" ? maskStderr(text) : applyMasks(text);
  if (stream !== "stderr") return base;
  return base.replace(
    /^(?:TransientServiceError|ServiceError|RequestException|SSLException|ConnectTimeout):\n\{\n[\s\S]*?^\}/gm,
    (envelope) =>
      envelope
        .replace(
          /^( {4}"opc-request-id": ")[^"]*("?,?)$/m,
          "$1<opc-request-id>$2",
        )
        .replace(/^( {4}"request_id": ")[^"]*("?,?)$/m, "$1<request-id>$2")
        .replace(
          /\bopcRequestId=[A-Za-z0-9/_-]+/g,
          "opcRequestId=<opc-request-id>",
        ),
  );
}

function firstDiffLine(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      const left = JSON.stringify((aLines[i] ?? "<EOF>").slice(0, 120));
      const right = JSON.stringify((bLines[i] ?? "<EOF>").slice(0, 120));
      return `line ${i + 1}: oci=${left} vs boci=${right}`;
    }
  }
  return "content differs";
}

function classifyOutcome(exitCode: number): OutcomeKind {
  if (exitCode === 0) return "ok";
  if (exitCode === 2) return "usage-error";
  return "api-error";
}

const ISO_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Allows small live clock skew and backend replica drift (e.g. Cloud Guard managed recipes ~2.5m)
// while still enforcing identical ISO-8601 format, precision, and timezone suffix.
const LIVE_TIMESTAMP_SKEW_MS = 300_000;
const LIVE_JWT_SKEW_SEC = 10;
const JWT_TIME_CLAIMS = new Set(["iat", "nbf", "exp"]);

function isSameFormatRecentTimestamp(a: string, b: string): boolean {
  const ma = ISO_TIMESTAMP_RE.exec(a);
  const mb = ISO_TIMESTAMP_RE.exec(b);
  if (!ma || !mb) return false;
  // Require identical precision and timezone suffix so datetime formatting bugs still fail.
  if ((ma[2]?.length ?? 0) !== (mb[2]?.length ?? 0) || ma[3] !== mb[3]) {
    return false;
  }
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= LIVE_TIMESTAMP_SKEW_MS;
}

function normalizeJwtSubValue(sub: string): unknown {
  const normalized = sub
    .replace(/(signature=\\?")[^"\\]+(\\?")/g, "$1<sig>$2")
    .replace(
      /\b[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g,
      "<http-date>",
    );
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return normalized;
  }
}

function decodeBase64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const padded = part
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isEquivalentLiveJwt(a: string, b: string): boolean {
  const partsA = a.split(".");
  const partsB = b.split(".");
  if (partsA.length !== 3 || partsB.length !== 3) return false;
  if (!partsA[2] || !partsB[2]) return false;
  const headerA = decodeBase64UrlJson(partsA[0]!);
  const headerB = decodeBase64UrlJson(partsB[0]!);
  const payloadA = decodeBase64UrlJson(partsA[1]!);
  const payloadB = decodeBase64UrlJson(partsB[1]!);
  if (!headerA || !headerB || !payloadA || !payloadB) return false;
  if (canonicalJson(headerA) !== canonicalJson(headerB)) return false;
  const keysA = Object.keys(payloadA).sort();
  const keysB = Object.keys(payloadB).sort();
  if (JSON.stringify(keysA) !== JSON.stringify(keysB)) return false;
  for (const k of keysA) {
    const va = payloadA[k];
    const vb = payloadB[k];
    if (
      JWT_TIME_CLAIMS.has(k) &&
      typeof va === "number" &&
      typeof vb === "number"
    ) {
      if (Math.abs(va - vb) > LIVE_JWT_SKEW_SEC) return false;
      continue;
    }
    if (k === "sub" && typeof va === "string" && typeof vb === "string") {
      const subReasons = new Set<string>();
      if (
        !compareJsonValues(
          normalizeJwtSubValue(va),
          normalizeJwtSubValue(vb),
          "$.sub",
          subReasons,
        )
      ) {
        return false;
      }
      continue;
    }
    if (canonicalJson(va) !== canonicalJson(vb)) return false;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareJsonValues(
  a: unknown,
  b: unknown,
  path: string,
  reasons: Set<string>,
): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    if (path === "$.opc-next-page" || path === "$.etag") {
      reasons.add("envelope-token");
      return true;
    }
    if (isSameFormatRecentTimestamp(a, b)) {
      reasons.add("server-timestamp");
      return true;
    }
    if (isEquivalentLiveJwt(a, b)) {
      reasons.add("jwt-token");
      return true;
    }
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const positionalReasons = new Set<string>();
    let positionalOk = true;
    for (let i = 0; i < a.length; i++) {
      if (!compareJsonValues(a[i], b[i], `${path}[${i}]`, positionalReasons)) {
        positionalOk = false;
        break;
      }
    }
    if (positionalOk) {
      for (const r of positionalReasons) reasons.add(r);
      return true;
    }
    // Check identical multiset (server-side nondeterministic array order).
    const sortedA = a.map(canonicalJson).sort();
    const sortedB = b.map(canonicalJson).sort();
    if (sortedA.every((v, i) => v === sortedB[i])) {
      reasons.add("array-order");
      return true;
    }
    return false;
  }
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA).sort();
    const keysB = Object.keys(recB).sort();
    if (
      keysA.length !== keysB.length ||
      !keysA.every((k, i) => k === keysB[i])
    ) {
      return false;
    }
    for (const k of keysA) {
      if (!compareJsonValues(recA[k], recB[k], `${path}.${k}`, reasons)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function compareLiveJson(
  a: string,
  b: string,
): { equivalent: boolean; reasons: string[] } {
  try {
    const oa = JSON.parse(a) as unknown;
    const ob = JSON.parse(b) as unknown;
    const reasons = new Set<string>();
    const equivalent = compareJsonValues(oa, ob, "$", reasons);
    return { equivalent, reasons: [...reasons].sort() };
  } catch {
    return { equivalent: false, reasons: [] };
  }
}

/** Compare a side-by-side live `oci` and `boci` invocation. */
export function compareLiveRuns(
  oci: CliSample,
  boci: CliSample,
): ComparisonResult {
  const diffs: string[] = [];
  const volatileReasons: string[] = [];
  if (oci.exitCode !== boci.exitCode) {
    diffs.push(`exitCode: oci=${oci.exitCode} vs boci=${boci.exitCode}`);
  }
  const ociOut = normalizeLiveOutput(oci.stdout, "stdout");
  const bociOut = normalizeLiveOutput(boci.stdout, "stdout");
  if (ociOut !== bociOut) {
    const jsonCmp = compareLiveJson(ociOut, bociOut);
    if (jsonCmp.equivalent) {
      volatileReasons.push(...jsonCmp.reasons);
    } else {
      diffs.push(`stdout (${firstDiffLine(ociOut, bociOut)})`);
    }
  }
  const ociErr = normalizeLiveOutput(oci.stderr, "stderr");
  const bociErr = normalizeLiveOutput(boci.stderr, "stderr");
  if (ociErr !== bociErr) {
    diffs.push(`stderr (${firstDiffLine(ociErr, bociErr)})`);
  }
  return {
    match: diffs.length === 0,
    outcome: classifyOutcome(oci.exitCode),
    diffs,
    ...(volatileReasons.length > 0 ? { volatileReasons } : {}),
  };
}

/**
 * Load completed records from a crash-safe JSONL file.
 * Malformed trailing lines (e.g. from a hard kill mid-write) are ignored.
 * If a key appears multiple times (e.g. after `--retry-diverged`), the latest entry wins.
 */
export async function loadCompletedRecords(
  jsonlPath: string,
): Promise<Map<string, LiveParityRecord>> {
  const map = new Map<string, LiveParityRecord>();
  const file = Bun.file(jsonlPath);
  if (!(await file.exists())) return map;
  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as LiveParityRecord;
      if (rec && typeof rec.key === "string") {
        map.set(rec.key, rec);
      }
    } catch {
      // Ignore partial/corrupted trailing line so resume stays resilient.
    }
  }
  return map;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export function summarizeRecords(
  records: LiveParityRecord[],
  totalPlanned: number,
): LiveParitySummary {
  let matched = 0;
  let matchedExact = 0;
  let matchedVolatile = 0;
  let matchedOk = 0;
  let matchedApiError = 0;
  let matchedUsageError = 0;
  let diverged = 0;
  let ociTotalMs = 0;
  let bociTotalMs = 0;
  const ociTimes: number[] = [];
  const bociTimes: number[] = [];
  const speedups: number[] = [];
  const services = new Set<string>();
  const divergedKeys: string[] = [];

  for (const r of records) {
    services.add(r.service);
    ociTotalMs += r.oci.elapsedMs;
    bociTotalMs += r.boci.elapsedMs;
    ociTimes.push(r.oci.elapsedMs);
    bociTimes.push(r.boci.elapsedMs);
    if (Number.isFinite(r.speedup) && r.speedup > 0) speedups.push(r.speedup);

    if (r.status === "match") {
      matched++;
      if (r.volatileReasons && r.volatileReasons.length > 0) {
        matchedVolatile++;
      } else {
        matchedExact++;
      }
      if (r.outcome === "ok") matchedOk++;
      else if (r.outcome === "usage-error") matchedUsageError++;
      else matchedApiError++;
    } else {
      diverged++;
      divergedKeys.push(r.key);
    }
  }

  return {
    totalPlanned,
    completed: records.length,
    remaining: Math.max(0, totalPlanned - records.length),
    matched,
    matchedExact,
    matchedVolatile,
    matchedOk,
    matchedApiError,
    matchedUsageError,
    diverged,
    ociTotalMs,
    bociTotalMs,
    ociMedianMs: median(ociTimes),
    bociMedianMs: median(bociTimes),
    overallSpeedup: bociTotalMs > 0 ? ociTotalMs / bociTotalMs : 0,
    medianSpeedup: median(speedups),
    servicesTested: services.size,
    divergedKeys: divergedKeys.sort(),
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsedHMS(ms: number): string {
  const totalSeconds =
    !Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatCounter(current: number, total: number): string {
  const width = Math.max(4, String(total).length);
  return `${String(current).padStart(width, "0")}/${String(total).padStart(width, "0")}`;
}

export function formatMarkdownReport(
  summary: LiveParitySummary,
  records: LiveParityRecord[],
): string {
  const passRate =
    summary.completed > 0
      ? ((summary.matched / summary.completed) * 100).toFixed(2)
      : "0.00";
  const lines: string[] = [
    "# Live Parity Report (`oci` vs `boci`, READ-ONLY)",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Progress | ${summary.completed} / ${summary.totalPlanned} (${summary.remaining} remaining) |`,
    `| Services tested | ${summary.servicesTested} |`,
    `| Matched | ${summary.matched} (${passRate}%) |`,
    `| — Exact | ${summary.matchedExact} |`,
    `| — Live-volatile (structurally identical) | ${summary.matchedVolatile} |`,
    `| — Matched (exit 0 / OK) | ${summary.matchedOk} |`,
    `| — Matched (API error) | ${summary.matchedApiError} |`,
    `| — Matched (usage error) | ${summary.matchedUsageError} |`,
    `| Diverged | ${summary.diverged} |`,
    `| Total elapsed (oci) | ${formatDuration(summary.ociTotalMs)} |`,
    `| Total elapsed (boci) | ${formatDuration(summary.bociTotalMs)} |`,
    `| Median command time (oci) | ${summary.ociMedianMs.toFixed(0)} ms |`,
    `| Median command time (boci) | ${summary.bociMedianMs.toFixed(0)} ms |`,
    `| Overall speedup | ${summary.overallSpeedup.toFixed(2)}× |`,
    `| Median per-command speedup | ${summary.medianSpeedup.toFixed(2)}× |`,
    "",
  ];

  const diverged = records
    .filter((r) => r.status === "diverged")
    .sort((a, b) => a.key.localeCompare(b.key));
  if (diverged.length > 0) {
    lines.push("## Divergences", "");
    lines.push(
      "| Command | oci exit | boci exit | oci ms | boci ms | Reason |",
    );
    lines.push("|---|---:|---:|---:|---:|---|");
    for (const r of diverged) {
      const reason = r.diffs.join("; ").replaceAll("|", "\\|");
      lines.push(
        `| \`${r.key}\` | ${r.oci.exitCode} | ${r.boci.exitCode} | ${r.oci.elapsedMs.toFixed(0)} | ${r.boci.elapsedMs.toFixed(0)} | ${reason} |`,
      );
    }
    lines.push("");
  }

  const volatile = records
    .filter(
      (r) =>
        r.status === "match" &&
        r.volatileReasons &&
        r.volatileReasons.length > 0,
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  if (volatile.length > 0) {
    lines.push("## Live-Volatile Matches", "");
    lines.push("| Command | Volatile Reason(s) | oci ms | boci ms |");
    lines.push("|---|---|---:|---:|");
    for (const r of volatile) {
      lines.push(
        `| \`${r.key}\` | ${(r.volatileReasons ?? []).join(", ")} | ${r.oci.elapsedMs.toFixed(0)} | ${r.boci.elapsedMs.toFixed(0)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Per-Command Timings", "");
  lines.push("| Command | Status | Outcome | oci ms | boci ms | Speedup |");
  lines.push("|---|---|---|---:|---:|---:|");
  for (const r of [...records].sort((a, b) => a.key.localeCompare(b.key))) {
    const icon = r.status === "match" ? "PASS" : "DIVERGED";
    lines.push(
      `| \`${r.key}\` | ${icon} | ${r.outcome} | ${r.oci.elapsedMs.toFixed(0)} | ${r.boci.elapsedMs.toFixed(0)} | ${r.speedup.toFixed(2)}× |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

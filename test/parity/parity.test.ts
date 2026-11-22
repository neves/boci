// Parity: boci against the Reference CLI's goldens. Never runs the Reference CLI (ADR 0004).
// Cases whose key boci doesn't implement yet are skipped (and recorded as not passing);
// once a key is implemented, every case for it must match its golden.
// Generated cases (test/parity/cases/generated-*.json, thousands of them) run only with
// BOCI_PARITY_ALL=1, which `bun run verify` sets; the default `bun test` stays fast.
import { afterAll, describe, expect, test } from "bun:test";
import { implementedLookup } from "../../src/registry.ts";
import {
  caseHash,
  includeGeneratedCases,
  loadCases,
  loadGolden,
  RESULTS_FILE,
} from "../harness/cases.ts";
import { normalizeRun, remask, signatureValid } from "../harness/compare.ts";
import { createPublicKey } from "node:crypto";
import { CLIS, runCli } from "../harness/runner.ts";

const cases = await loadCases({ generated: includeGeneratedCases() });
const isImplemented = await implementedLookup(cases.map((c) => c.key));
const runnableCases = cases.filter((c) => isImplemented(c.key));
const missingCases = cases.length - runnableCases.length;
const missingKeys = new Set(
  cases.filter((c) => !isImplemented(c.key)).map((c) => c.key),
).size;
const publicKey = createPublicKey(
  await Bun.file(`${import.meta.dir}/../fixtures/fake_oci_api_key.pem`).text(),
)
  .export({ type: "spki", format: "pem" })
  .toString();
const results: Record<string, { pass: boolean }> = {};
const record = (key: string, pass: boolean) => {
  // A key is verified only if all of its cases pass.
  results[key] = { pass: (results[key]?.pass ?? true) && pass };
};

const progressStartedAt = performance.now();
let completed = 0;
let active = 0;
let failed = 0;
let progressVisible = false;
let lastProgressAt = 0;

function duration(ms: number) {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clearProgress() {
  if (!progressVisible) return;
  process.stdout.write("\r\x1b[2K");
  progressVisible = false;
}

function showProgress(force = false) {
  if (!process.stdout.isTTY) return;
  const now = performance.now();
  if (!force && now - lastProgressAt < 1_000) return;
  lastProgressAt = now;
  const elapsed = now - progressStartedAt;
  const remaining = runnableCases.length - completed;
  const eta = completed
    ? `rough ETA ${duration((elapsed / completed) * remaining)}`
    : "ETA calculating";
  process.stdout.write(
    `\r\x1b[2Kparity: ${completed}/${runnableCases.length} done · ${active} active · ${missingCases} missing (${missingKeys} keys) · ${failed} failed · ${remaining} remaining · elapsed ${duration(elapsed)} · ${eta}`,
  );
  progressVisible = true;
}

const heartbeat = setInterval(() => showProgress(true), 1_000);
showProgress(true);

async function runParityCase(c: (typeof cases)[number]) {
  active++;
  showProgress();
  try {
    const golden = await loadGolden(c);
    expect(
      golden,
      `missing golden: run \`bun run golden --filter ${c.id}\``,
    ).toBeDefined();
    expect(
      golden?.caseHash,
      `stale golden: run \`bun run golden --filter ${c.id}\``,
    ).toBe(caseHash(c));
    const run = await runCli(CLIS.boci, c.argv, c);
    if (c.id === "os-ns-get-request-id")
      expect(run.requests[0]?.headers["opc-client-request-id"]).toBe(
        "boci-request-123",
      );
    if (c.key === "debug") {
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('"data": "fake-namespace"');
      expect(run.stderr).toMatch(/DEBUG:.*Request: GET .*\/n/);
      expect(run.stderr).toMatch(/DEBUG:.*Response status: 200/);
      record(c.key, true);
      return;
    }
    if (c.key === "read-timeout") {
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("TimeoutError");
      expect(run.requests).toHaveLength(1);
      record(c.key, true);
      return;
    }
    for (const req of run.requests) {
      if (req.headers.authorization)
        expect(
          signatureValid(req, publicKey),
          `${c.id}: invalid signature`,
        ).toBe(true);
    }
    if (c.requestOnly) {
      const actual = normalizeRun(run);
      const expected = remask(golden!.observed);
      expect(actual.requests).toEqual(expected.requests);
      record(c.key, true);
      return;
    }
    try {
      expect(normalizeRun(run)).toEqual(
        remask(golden?.observed as never) as never,
      );
      record(c.key, true);
    } catch (e) {
      record(c.key, false);
      throw e;
    }
  } catch (e) {
    failed++;
    throw e;
  } finally {
    active--;
    completed++;
    showProgress();
  }
}

// Concurrent: every case runs in its own sandbox against its own fake endpoint, and the
// suite is dominated by process spawns (~2x faster than serial).
describe.concurrent("parity", () => {
  for (const c of cases) {
    const implemented = isImplemented(c.key);
    test.skipIf(!implemented)(`${c.id} (${c.key})`, () => runParityCase(c));
    if (!implemented) record(c.key, false);
  }
});

afterAll(async () => {
  try {
    // results.json is derived and untracked (read by `bun run status`). Only a run of every
    // case rewrites it, so a partial run (default `bun test`, `-t`) can't leave stale passes.
    if (includeGeneratedCases() && completed === runnableCases.length) {
      const sorted = Object.fromEntries(
        Object.entries(results).sort(([a], [b]) => a.localeCompare(b)),
      );
      await Bun.write(RESULTS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    }
  } finally {
    clearInterval(heartbeat);
    clearProgress();
    if (process.stdout.isTTY)
      console.log(
        `parity: ${completed - failed}/${runnableCases.length} passed in ${duration(performance.now() - progressStartedAt)}`,
      );
  }
});

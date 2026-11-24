// Parity: boci against the Reference CLI's goldens. Never runs the Reference CLI (ADR 0004).
// Cases whose key boci doesn't implement yet are skipped (and recorded as not passing);
// once a key is implemented, every case for it must match its golden.
// Generated cases (test/parity/cases/generated-*.json, thousands of them) run only with
// BOCI_PARITY_ALL=1, which `bun run verify` sets; the default `bun test` stays fast.
// Cases run boci in-process (runInProcess) unless they must spawn (spawnsProcess below).
import { afterAll, describe, expect, test } from "bun:test";
import { implementedLookup } from "../../src/core/registry.ts";
import {
  computeSpawnSample,
  type ParityMode,
  selectParityCases,
} from "../../scripts/verify-lib.ts";
import {
  caseHash,
  includeGeneratedCases,
  isGeneratedCaseFile,
  loadCasesWithFiles,
  loadGolden,
  RESULTS_FILE,
} from "../harness/cases.ts";
import {
  normalizeRun,
  remask,
  requestOnlyMismatch,
  signatureValid,
} from "../harness/compare.ts";
import { createPublicKey } from "node:crypto";
import { CLIS, runCli, runInProcess } from "../harness/runner.ts";
import { disposeSharedSandboxes } from "../harness/sandbox.ts";

const parityMode =
  (Bun.env.BOCI_PARITY_MODE as ParityMode | undefined) ?? "full";
const mergeResults = Bun.env.BOCI_VERIFY_MERGE_RESULTS === "1";
const resultsFile = Bun.file(RESULTS_FILE);
const prevResults: Record<string, { pass: boolean }> | undefined =
  mergeResults && (await resultsFile.exists())
    ? ((await resultsFile.json()) as Record<string, { pass: boolean }>)
    : undefined;

const allWithFiles = await loadCasesWithFiles({
  generated: includeGeneratedCases(),
});
const allCases = allWithFiles.map((e) => e.case);
const splitCsv = (val?: string) =>
  val
    ? val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const scopeFiles = new Set(splitCsv(Bun.env.BOCI_PARITY_FILES));

const cases =
  parityMode === "full"
    ? allCases
    : selectParityCases(allWithFiles, {
        mode: parityMode,
        files: scopeFiles,
        ids: splitCsv(Bun.env.BOCI_PARITY_IDS),
        services: splitCsv(Bun.env.BOCI_PARITY_SERVICES),
        keys: splitCsv(Bun.env.BOCI_PARITY_KEYS),
        prevResults,
      });

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

// Spawned vs in-process. From source, everything runs in-process: same argv, env, cwd and
// sinks as a spawned boci, without a process, module load and spec parse per case.
// Against a binary (BOCI_BIN: verify, test:dist), the binary itself stays under test: every
// hand-written case spawns it (real exit codes and stdio), plus the first generated case of
// each kind per service (its embedded spec); the other generated cases exercise the same
// code paths in-process. In `sample` mode (core engine iteration), unmodified hand-written
// case files spawn their first case and run the rest in-process. BOCI_PARITY_SPAWN=all
// spawns every case (test:dist).
const spawnAll = Bun.env.BOCI_PARITY_SPAWN === "all";
const spawnSample = new Set<string>();
if (Bun.env.BOCI_BIN) {
  if (parityMode === "sample") {
    const seenGroups = new Set<string>();
    for (const { file, case: c } of allWithFiles) {
      if (scopeFiles.has(file)) {
        spawnSample.add(c.id);
        continue;
      }
      const group = isGeneratedCaseFile(file)
        ? `gen ${c.key.split(" ")[0]}`
        : `file ${file}`;
      if (!seenGroups.has(group)) spawnSample.add(c.id);
      seenGroups.add(group);
    }
  } else {
    for (const id of computeSpawnSample(cases)) spawnSample.add(id);
  }
}
/** A relative path would resolve against the sandbox in both modes, but keep it honest. */
const relativePath = (c: (typeof cases)[number]) =>
  c.argv.some((a) => /^file:\/\/(?![/~{$])/i.test(a));
const spawnsProcess = (c: (typeof cases)[number]) =>
  spawnAll || spawnSample.has(c.id) || relativePath(c);
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
    const captureFiles = c.expect?.files
      ? Object.keys(c.expect.files)
      : undefined;
    const captureFileModes = c.expect?.fileModes
      ? Object.keys(c.expect.fileModes)
      : undefined;
    const runOpts =
      captureFiles || captureFileModes
        ? { ...c, captureFiles, captureFileModes }
        : c;
    const run = spawnsProcess(c)
      ? await runCli(CLIS.boci, c.argv, runOpts)
      : await runInProcess(c.argv, runOpts);
    const want = c.expect ?? {};
    if (want.exitCode !== undefined) expect(run.exitCode).toBe(want.exitCode);
    if (want.stdout !== undefined) expect(run.stdout).toBe(want.stdout);
    if (want.stdoutContains !== undefined)
      expect(run.stdout).toContain(want.stdoutContains);
    if (want.stderrContains !== undefined)
      expect(run.stderr).toContain(want.stderrContains);
    for (const re of want.stderrMatches ?? [])
      expect(run.stderr).toMatch(new RegExp(re));
    if (want.requests !== undefined)
      expect(run.requests).toHaveLength(want.requests);
    for (const [name, value] of Object.entries(want.requestHeaders ?? {}))
      expect(run.requests[0]?.headers[name]).toBe(value);
    for (const [rel, content] of Object.entries(want.files ?? {}))
      expect(run.files?.[rel]).toBe(content);
    for (const [rel, mode] of Object.entries(want.fileModes ?? {}))
      expect(run.fileModes?.[rel]).toBe(mode);
    if (want.golden === false) {
      record(c.key, true);
      return;
    }
    const verifyKey = run.sessionPublicKey ?? publicKey;
    for (const req of run.requests) {
      if (req.headers.authorization?.startsWith("Signature "))
        expect(
          signatureValid(req, verifyKey),
          `${c.id}: invalid signature`,
        ).toBe(true);
    }
    if (c.requestOnly) {
      const actual = normalizeRun(run);
      const expected = remask(golden!.observed);
      try {
        expect(requestOnlyMismatch(actual, expected), c.id).toBeUndefined();
        expect(actual.requests).toEqual(expected.requests);
        record(c.key, true);
      } catch (e) {
        record(c.key, false);
        throw e;
      }
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

// Concurrent: every case runs against its own fake endpoint (spawned cases also in their own
// sandbox), and spawns and HTTP round trips overlap (~2x faster than serial).
describe.concurrent("parity", () => {
  for (const c of cases) {
    const implemented = isImplemented(c.key);
    test.skipIf(!implemented)(`${c.id} (${c.key})`, () => runParityCase(c));
    if (!implemented) record(c.key, false);
  }
});

afterAll(async () => {
  try {
    // results.json is derived and untracked (read by `bun run status`). A full run rewrites
    // it completely; a scoped/sample run from `bun run verify` merges updated key results.
    if (includeGeneratedCases() && completed === runnableCases.length) {
      let outResults = results;
      if (parityMode !== "full" && prevResults) {
        const validKeys = new Set(allCases.map((c) => c.key));
        outResults = {};
        for (const [k, v] of Object.entries(prevResults)) {
          if (validKeys.has(k)) outResults[k] = v;
        }
        for (const [k, v] of Object.entries(results)) {
          outResults[k] = v;
        }
      }
      if (parityMode === "full" || prevResults) {
        const sorted = Object.fromEntries(
          Object.entries(outResults).sort(([a], [b]) => a.localeCompare(b)),
        );
        await Bun.write(RESULTS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
      }
    }
  } finally {
    await disposeSharedSandboxes();
    clearInterval(heartbeat);
    clearProgress();
    if (process.stdout.isTTY)
      console.log(
        `parity: ${completed - failed}/${runnableCases.length} passed in ${duration(performance.now() - progressStartedAt)}`,
      );
  }
});

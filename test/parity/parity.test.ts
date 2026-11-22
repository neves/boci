// Parity: boci against the Reference CLI's goldens. Never runs the Reference CLI (ADR 0004).
// Cases whose key boci doesn't implement yet are skipped (and recorded as not passing);
// once a key is implemented, every case for it must match its golden.
// Generated cases (test/parity/cases/generated-*.json, thousands of them) run only with
// BOCI_PARITY_ALL=1, which `bun run verify` sets; the default `bun test` stays fast.
// Cases run boci in-process (runInProcess) unless they must spawn (spawnsProcess below).
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
import { CLIS, runCli, runInProcess } from "../harness/runner.ts";
import { disposeSharedSandboxes } from "../harness/sandbox.ts";

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

// Spawned vs in-process. From source, everything runs in-process: same argv, env, cwd and
// sinks as a spawned boci, without a process, module load and spec parse per case.
// Against a binary (BOCI_BIN: verify, test:dist), the binary itself stays under test: every
// hand-written case spawns it (real exit codes and stdio), plus the first generated case of
// each kind per service (its embedded spec); the other generated cases exercise the same
// code paths in-process. BOCI_PARITY_SPAWN=all spawns every case (test:dist).
const spawnAll = Bun.env.BOCI_PARITY_SPAWN === "all";
const spawnSample = new Set<string>();
if (Bun.env.BOCI_BIN) {
  const seen = new Set<string>();
  for (const c of cases) {
    const kind = /^generated-(get|request)-/.exec(c.id)?.[1];
    const group = kind ? `${kind} ${c.key.split(" ")[0]}` : c.id;
    if (!seen.has(group)) spawnSample.add(c.id);
    seen.add(group);
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
    const run = spawnsProcess(c)
      ? await runCli(CLIS.boci, c.argv, c)
      : await runInProcess(c.argv, c);
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
    if (want.golden === false) {
      record(c.key, true);
      return;
    }
    const verifyKey = run.sessionPublicKey ?? publicKey;
    for (const req of run.requests) {
      if (req.headers.authorization)
        expect(
          signatureValid(req, verifyKey),
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
    // results.json is derived and untracked (read by `bun run status`). Only a run of every
    // case rewrites it, so a partial run (default `bun test`, `-t`) can't leave stale passes.
    if (includeGeneratedCases() && completed === runnableCases.length) {
      const sorted = Object.fromEntries(
        Object.entries(results).sort(([a], [b]) => a.localeCompare(b)),
      );
      await Bun.write(RESULTS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
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

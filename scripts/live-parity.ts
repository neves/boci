// Side-by-side live READ-ONLY parity runner: `oci` vs `boci` against BOCI_TEST_PROFILE.
// Invoked via `mise run live-parity [-- --service iam,os --limit 20 --delay 400 ...]`.
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServiceSpec } from "../src/core/spec.ts";
import {
  buildReadCommandPlan,
  type CliSample,
  compareLiveRuns,
  formatCounter,
  formatDuration,
  formatElapsedHMS,
  formatMarkdownReport,
  isRateLimited,
  type LiveContext,
  type LiveParityRecord,
  loadCompletedRecords,
  parseOciProfile,
  summarizeRecords,
} from "./live-parity-lib.ts";

const ROOT = join(import.meta.dir, "..");
const SPEC_DIR = join(ROOT, "spec");

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    service: { type: "string" },
    filter: { type: "string" },
    limit: { type: "string" },
    delay: { type: "string", default: "400" },
    "pair-gap": { type: "string", default: "150" },
    timeout: { type: "string", default: "30000" },
    out: { type: "string", default: ".live-parity" },
    reset: { type: "boolean", default: false },
    "retry-diverged": { type: "boolean", default: false },
    report: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`Usage: mise run live-parity [-- [options]]

Run side-by-side READ-ONLY live parity checks of oci vs boci against BOCI_TEST_PROFILE.
Progress is saved after every command so Ctrl+C or rate limits resume cleanly.

Options:
  --service <csv>    Filter to specific service(s), e.g. iam,os,compute
  --filter <substr>  Filter commands whose key contains <substr>
  --limit <n>        Run at most N commands in this session
  --delay <ms>       Base delay between commands in ms (default: 400)
  --pair-gap <ms>    Delay between oci and boci calls in ms (default: 150)
  --timeout <ms>     Per-command timeout in ms (default: 30000)
  --out <dir>        Directory for recordings & reports (default: .live-parity)
  --reset            Clear saved state and start fresh
  --retry-diverged   Re-run previously diverged commands
  --report           Print summary report from saved results without API calls
  --dry-run          Print planned READ-ONLY commands and exit
  --no-build         Skip rebuilding dist/boci if it already exists
  -h, --help         Show this help
`);
  process.exit(0);
}

const outDir = join(ROOT, flags.out);
const resultsPath = join(outDir, "results.jsonl");
const summaryPath = join(outDir, "summary.json");
const reportPath = join(outDir, "report.md");
const contextPath = join(outDir, "context.json");

const baseDelayMs = Math.max(0, Number(flags.delay));
const pairGapMs = Math.max(0, Number(flags["pair-gap"]));
const timeoutMs = Math.max(1_000, Number(flags.timeout));
const sessionLimit = flags.limit ? Math.max(1, Number(flags.limit)) : undefined;
const servicesFilter = flags.service
  ? flags.service
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const isTTY = Boolean(process.stderr.isTTY);
const c = {
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

async function runCliCommand(
  cmd: string[],
  env: Record<string, string>,
): Promise<CliSample> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const elapsedMs = performance.now() - t0;
  if (timedOut) {
    return {
      exitCode: 124,
      elapsedMs,
      stdout,
      stderr: `${stderr}\n[live-parity] timed out after ${timeoutMs}ms\n`,
    };
  }
  return { exitCode, elapsedMs, stdout, stderr };
}

async function loadAllSpecs(): Promise<ServiceSpec[]> {
  const files = (await readdir(SPEC_DIR))
    .filter(
      (f) => f.endsWith(".json") && f !== "index.json" && f !== "regions.json",
    )
    .sort();
  return Promise.all(
    files.map(
      (f) => Bun.file(join(SPEC_DIR, f)).json() as Promise<ServiceSpec>,
    ),
  );
}

async function discoverContext(
  ociBin: string,
  profile: string,
  env: Record<string, string>,
): Promise<LiveContext> {
  const cachedFile = Bun.file(contextPath);
  if (!flags.reset && (await cachedFile.exists())) {
    try {
      const cached = (await cachedFile.json()) as LiveContext;
      if (cached.profile === profile && cached.tenancy) return cached;
    } catch {
      // Re-discover below.
    }
  }

  const configPath = join(homedir(), ".oci", "config");
  const configText = await Bun.file(configPath).text();
  const { tenancy, user, region } = parseOciProfile(configText, profile);

  process.stderr.write(
    `Discovering read-only context for profile [${profile}]...\n`,
  );

  let namespace: string | undefined;
  const nsRun = await runCliCommand(
    [ociBin, "os", "ns", "get", "--no-retry"],
    env,
  );
  if (nsRun.exitCode === 0) {
    try {
      const parsed = JSON.parse(nsRun.stdout) as { data?: string };
      if (typeof parsed.data === "string") namespace = parsed.data;
    } catch {
      // Leave undefined.
    }
  }

  let availabilityDomain: string | undefined;
  const adRun = await runCliCommand(
    [
      ociBin,
      "iam",
      "availability-domain",
      "list",
      "--compartment-id",
      tenancy,
      "--no-retry",
    ],
    env,
  );
  if (adRun.exitCode === 0) {
    try {
      const parsed = JSON.parse(adRun.stdout) as {
        data?: { name?: string }[];
      };
      availabilityDomain = parsed.data?.[0]?.name;
    } catch {
      // Leave undefined.
    }
  }

  let childCompartmentId: string | undefined;
  const compRun = await runCliCommand(
    [
      ociBin,
      "iam",
      "compartment",
      "list",
      "--compartment-id",
      tenancy,
      "--lifecycle-state",
      "ACTIVE",
      "--no-retry",
    ],
    env,
  );
  if (compRun.exitCode === 0 && compRun.stdout.trim()) {
    try {
      const parsed = JSON.parse(compRun.stdout) as {
        data?: { id?: string }[];
      };
      childCompartmentId = parsed.data?.[0]?.id;
    } catch {
      // Leave undefined.
    }
  }

  const ctx: LiveContext = {
    profile,
    tenancy,
    childCompartmentId,
    user,
    region,
    namespace,
    availabilityDomain,
  };
  await mkdir(outDir, { recursive: true });
  await Bun.write(contextPath, `${JSON.stringify(ctx, null, 2)}\n`);
  return ctx;
}

async function writeReports(
  recordsMap: Map<string, LiveParityRecord>,
  totalPlanned: number,
) {
  const records = [...recordsMap.values()];
  const summary = summarizeRecords(
    records,
    Math.max(totalPlanned, records.length),
  );
  await mkdir(outDir, { recursive: true });
  await Bun.write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await Bun.write(reportPath, formatMarkdownReport(summary, records));
  return summary;
}

function printSummary(
  summary: ReturnType<typeof summarizeRecords>,
  wallMs?: number,
) {
  const passRate =
    summary.completed > 0
      ? ((summary.matched / summary.completed) * 100).toFixed(2)
      : "0.00";
  console.log("");
  console.log(c.bold("=== Live Parity Summary (oci vs boci) ==="));
  console.log(
    `Progress:   ${summary.completed}/${summary.totalPlanned} completed (${summary.remaining} remaining, ${summary.servicesTested} services)`,
  );
  console.log(
    `Matches:    ${c.green(`${summary.matched} (${passRate}%)`)}  [exact: ${summary.matchedExact}, live-volatile: ${summary.matchedVolatile} · ok: ${summary.matchedOk}, api-error: ${summary.matchedApiError}, usage-error: ${summary.matchedUsageError}]`,
  );
  console.log(
    `Diverged:   ${summary.diverged > 0 ? c.red(String(summary.diverged)) : c.green("0")}`,
  );
  console.log(
    `Timing:     oci total ${formatDuration(summary.ociTotalMs)} (median ${summary.ociMedianMs.toFixed(0)}ms) vs boci total ${formatDuration(summary.bociTotalMs)} (median ${summary.bociMedianMs.toFixed(0)}ms)`,
  );
  console.log(
    `Speedup:    ${c.bold(`${summary.overallSpeedup.toFixed(2)}×`)} overall  ·  ${summary.medianSpeedup.toFixed(2)}× median per command${wallMs !== undefined ? `  ·  session wall ${formatDuration(wallMs)}` : ""}`,
  );
  if (summary.divergedKeys.length > 0) {
    console.log("");
    console.log(c.red("Diverged commands:"));
    for (const k of summary.divergedKeys) {
      console.log(`  - ${k}`);
    }
  }
  console.log("");
  console.log(c.dim(`Recordings: ${resultsPath}`));
  console.log(c.dim(`Report:     ${reportPath}`));
}

// ---------------------------------------------------------------- main

if (flags.report) {
  const existing = await loadCompletedRecords(resultsPath);
  if (existing.size === 0) {
    console.error(`No saved results found at ${resultsPath}`);
    process.exit(1);
  }
  // Re-evaluate saved raw outputs against current comparison rules.
  for (const [key, rec] of existing) {
    const cmp = compareLiveRuns(rec.oci, rec.boci);
    existing.set(key, {
      ...rec,
      status: cmp.match ? "match" : "diverged",
      outcome: cmp.outcome,
      diffs: cmp.diffs,
      ...(cmp.volatileReasons
        ? { volatileReasons: cmp.volatileReasons }
        : { volatileReasons: undefined }),
    });
  }
  const summary = await writeReports(existing, existing.size);
  printSummary(summary);
  process.exit(summary.diverged > 0 ? 1 : 0);
}

const profile = Bun.env.BOCI_TEST_PROFILE;
if (!profile) {
  console.error(
    "BOCI_TEST_PROFILE is not set. Create .env.test with BOCI_TEST_PROFILE=<profile> and run via `mise run live-parity`.",
  );
  process.exit(2);
}

const ociBin = Bun.which("oci");
if (!ociBin) {
  console.error(
    "Reference CLI `oci` not found. Install with: uv tool install --python 3.12 oci-cli==3.96.3",
  );
  process.exit(2);
}

const bociBin = join(ROOT, "dist", "boci");
if (!flags["no-build"] || !(await Bun.file(bociBin).exists())) {
  process.stderr.write("Building dist/boci...\n");
  await Bun.$`bun ${join(ROOT, "scripts/build.ts")} --outfile dist/boci`
    .cwd(ROOT)
    .quiet();
}

const liveEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  OCI_CLI_PROFILE: profile,
  OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True",
};

if (flags.reset) {
  for (const p of [resultsPath, summaryPath, reportPath, contextPath]) {
    if (await Bun.file(p).exists()) await unlink(p);
  }
  process.stderr.write(`Cleared saved state in ${outDir}\n`);
}

const ctx = await discoverContext(ociBin, profile, liveEnv);
const specs = await loadAllSpecs();
const plan = buildReadCommandPlan(specs, ctx, {
  services: servicesFilter,
  filter: flags.filter,
});

if (plan.length === 0) {
  console.error("No matching READ-ONLY commands found.");
  process.exit(1);
}

if (flags["dry-run"]) {
  for (const item of plan) {
    console.log(
      `${item.key}  [${item.httpMethods.join(",")}]  ${item.argv.join(" ")}`,
    );
  }
  console.error(
    `\nTotal: ${plan.length} READ-ONLY commands across ${new Set(plan.map((p) => p.service)).size} services.`,
  );
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const completedMap = await loadCompletedRecords(resultsPath);

const pending = plan.filter((item) => {
  const prev = completedMap.get(item.key);
  if (!prev) return true;
  return Boolean(flags["retry-diverged"] && prev.status === "diverged");
});

const toRun = sessionLimit ? pending.slice(0, sessionLimit) : pending;
const alreadyDoneCount = plan.length - pending.length;

process.stderr.write(
  `Plan: ${plan.length} READ-ONLY commands across ${new Set(plan.map((p) => p.service)).size} services` +
    (alreadyDoneCount > 0
      ? ` (${alreadyDoneCount} already completed, resuming)`
      : "") +
    (sessionLimit ? ` — running up to ${toRun.length} this session` : "") +
    "\n",
);

if (toRun.length === 0) {
  const summary = await writeReports(completedMap, plan.length);
  printSummary(summary);
  process.exit(summary.diverged > 0 ? 1 : 0);
}

let stopRequested = false;
const onSignal = () => {
  if (stopRequested) {
    process.stderr.write("\nForce exiting.\n");
    process.exit(130);
  }
  stopRequested = true;
  process.stderr.write(
    `\n${c.yellow("Interrupt received — finishing current command and saving progress...")}\n`,
  );
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const sessionStartedAt = performance.now();
let sessionCompleted = 0;
let currentDelayMs = baseDelayMs;
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
let progressVisible = false;

function clearProgress() {
  if (!progressVisible || !isTTY) return;
  process.stderr.write("\r\x1b[2K");
  progressVisible = false;
}

function linePrefix(doneTotal: number): string {
  const elapsed = performance.now() - sessionStartedAt;
  return `${formatElapsedHMS(elapsed)} ${formatCounter(doneTotal, plan.length)}`;
}

function renderProgress(currentKey?: string) {
  if (!isTTY) return;
  const doneTotal = alreadyDoneCount + sessionCompleted;
  const pct = ((doneTotal / plan.length) * 100).toFixed(1).padStart(5, " ");
  const elapsed = performance.now() - sessionStartedAt;
  const remainingThisRun = toRun.length - sessionCompleted;
  const eta =
    sessionCompleted > 0
      ? formatDuration((elapsed / sessionCompleted) * remainingThisRun)
      : "calc...";
  const matched = [...completedMap.values()].filter(
    (r) => r.status === "match",
  ).length;
  const diverged = completedMap.size - matched;
  const suffix = currentKey ? ` · running: ${currentKey}` : "";
  process.stderr.write(
    `\r\x1b[2K${linePrefix(doneTotal)} [${pct}%] ETA ${eta} · match ${matched} · div ${diverged} · delay ${currentDelayMs}ms${suffix}`,
  );
  progressVisible = true;
}

for (const item of toRun) {
  if (stopRequested) break;

  renderProgress(item.key);

  let ociSample: CliSample | undefined;
  let bociSample: CliSample | undefined;
  let rateLimitAborted = false;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (stopRequested) break;

    ociSample = await runCliCommand([ociBin, ...item.argv], liveEnv);
    if (isRateLimited(ociSample)) {
      const waitMs = BACKOFF_MS[attempt];
      if (waitMs === undefined) {
        rateLimitAborted = true;
        break;
      }
      currentDelayMs = Math.min(3_000, Math.round(currentDelayMs * 1.5) + 250);
      clearProgress();
      process.stderr.write(
        `${c.dim(linePrefix(alreadyDoneCount + sessionCompleted + 1))} ${c.yellow("⏳")} rate-limited on oci (${item.key}); backing off ${formatDuration(waitMs)}, raising delay to ${currentDelayMs}ms\n`,
      );
      await Bun.sleep(waitMs);
      continue;
    }

    if (pairGapMs > 0) await Bun.sleep(pairGapMs);
    if (stopRequested) break;

    bociSample = await runCliCommand([bociBin, ...item.argv], liveEnv);
    if (isRateLimited(bociSample)) {
      const waitMs = BACKOFF_MS[attempt];
      if (waitMs === undefined) {
        rateLimitAborted = true;
        break;
      }
      currentDelayMs = Math.min(3_000, Math.round(currentDelayMs * 1.5) + 250);
      clearProgress();
      process.stderr.write(
        `${c.dim(linePrefix(alreadyDoneCount + sessionCompleted + 1))} ${c.yellow("⏳")} rate-limited on boci (${item.key}); backing off ${formatDuration(waitMs)}, raising delay to ${currentDelayMs}ms\n`,
      );
      await Bun.sleep(waitMs);
      continue;
    }

    // Gradually relax adaptive delay back toward baseDelayMs after clean calls.
    if (currentDelayMs > baseDelayMs) {
      currentDelayMs = Math.max(baseDelayMs, currentDelayMs - 50);
    }
    break;
  }

  if (stopRequested) break;

  if (rateLimitAborted || !ociSample || !bociSample) {
    clearProgress();
    process.stderr.write(
      `${c.red("Stopped due to persistent rate limiting")} on ${item.key}. Resume later with: mise run live-parity\n`,
    );
    const summary = await writeReports(completedMap, plan.length);
    printSummary(summary, performance.now() - sessionStartedAt);
    process.exit(2);
  }

  let cmp = compareLiveRuns(ociSample, bociSample);

  // If both exited 0 but stdout differed (e.g. transient server mutation or lazy seeding
  // between the two sequential calls), re-check once after a brief pause before flagging.
  if (
    !cmp.match &&
    ociSample.exitCode === 0 &&
    bociSample.exitCode === 0 &&
    !stopRequested
  ) {
    await Bun.sleep(500);
    const retryOci = await runCliCommand([ociBin, ...item.argv], liveEnv);
    if (pairGapMs > 0) await Bun.sleep(pairGapMs);
    const retryBoci = await runCliCommand([bociBin, ...item.argv], liveEnv);
    if (!isRateLimited(retryOci) && !isRateLimited(retryBoci)) {
      ociSample = retryOci;
      bociSample = retryBoci;
      cmp = compareLiveRuns(ociSample, bociSample);
    }
  }

  const speedup =
    bociSample.elapsedMs > 0 ? ociSample.elapsedMs / bociSample.elapsedMs : 0;

  const record: LiveParityRecord = {
    key: item.key,
    service: item.service,
    argv: item.argv,
    timestamp: new Date().toISOString(),
    oci: ociSample,
    boci: bociSample,
    speedup,
    status: cmp.match ? "match" : "diverged",
    outcome: cmp.outcome,
    diffs: cmp.diffs,
    ...(cmp.volatileReasons ? { volatileReasons: cmp.volatileReasons } : {}),
  };

  await appendFile(resultsPath, `${JSON.stringify(record)}\n`);
  completedMap.set(record.key, record);
  sessionCompleted++;

  clearProgress();
  const prefix = c.dim(linePrefix(alreadyDoneCount + sessionCompleted));
  const timing = `${ociSample.elapsedMs.toFixed(0)}ms → ${bociSample.elapsedMs.toFixed(0)}ms (${speedup.toFixed(1)}×)`;
  if (cmp.match) {
    const icon = cmp.outcome === "ok" ? c.green("✓") : c.dim("·");
    const baseTag = cmp.outcome === "ok" ? "ok" : `exit ${ociSample.exitCode}`;
    const tag = cmp.volatileReasons?.length
      ? `${baseTag}, volatile: ${cmp.volatileReasons.join("+")}`
      : baseTag;
    process.stderr.write(
      `${prefix} ${icon} ${item.key} ${c.dim(`[${tag}] ${timing}`)}\n`,
    );
  } else {
    process.stderr.write(
      `${prefix} ${c.red("✗ DIVERGED")} ${c.bold(item.key)} ${c.dim(timing)}\n`,
    );
    for (const d of cmp.diffs) {
      process.stderr.write(`                    ${c.red(d)}\n`);
    }
  }

  renderProgress();

  if (currentDelayMs > 0 && sessionCompleted < toRun.length && !stopRequested) {
    await Bun.sleep(currentDelayMs);
  }
}

clearProgress();
const wallMs = performance.now() - sessionStartedAt;
const summary = await writeReports(completedMap, plan.length);
printSummary(summary, wallMs);

if (stopRequested) {
  console.log("Paused cleanly. Resume anytime with: mise run live-parity");
  process.exit(130);
}

process.exit(summary.diverged > 0 ? 1 : 0);

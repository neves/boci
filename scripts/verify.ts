// `bun run verify [--full]`: every check the loop needs before a commit, with quiet output.
// It keeps a live terminal status showing finished, running, and queued checks. One line per
// passing step; a failing step prints its (tail-capped) output. All steps run even if one
// fails, so a single run reports every problem. By default, test execution is scoped to the
// unit tests and parity cases affected by the current git changes (while merging results into
// test/parity/results.json); `--full` or `CI=true` runs the entire suite.
import { join } from "node:path";
import { parseArgs } from "util";
import { RESULTS_FILE } from "../test/harness/cases.ts";
import { planVerification } from "./verify-lib.ts";

const ROOT = join(import.meta.dir, "..");
const MAX_LINES = 150;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    full: { type: "boolean", default: false },
  },
});

function gitLines(args: string[]): string[] {
  const res = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return [];
  return new TextDecoder()
    .decode(res.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function gitText(args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return "";
  return new TextDecoder().decode(res.stdout);
}

function detectChanges(): { files: string[]; registryDiff: string } {
  const uncommitted = [
    ...gitLines(["diff", "--name-only", "HEAD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
  if (uncommitted.length > 0) {
    return {
      files: [...new Set(uncommitted)],
      registryDiff: gitText([
        "diff",
        "-U0",
        "HEAD",
        "--",
        "src/core/registry.ts",
      ]),
    };
  }
  const headCommit = gitLines(["diff", "--name-only", "HEAD~1", "HEAD"]);
  return {
    files: headCommit,
    registryDiff: gitText([
      "diff",
      "-U0",
      "HEAD~1",
      "HEAD",
      "--",
      "src/core/registry.ts",
    ]),
  };
}

const forceFull =
  values.full ||
  Bun.env.BOCI_VERIFY_FULL === "1" ||
  Boolean(Bun.env.CI) ||
  Boolean(Bun.env.GITHUB_ACTIONS);

const hasResultsFile = await Bun.file(RESULTS_FILE).exists();
const { files: changedFiles, registryDiff } = forceFull
  ? { files: [], registryDiff: "" }
  : detectChanges();

const plan = planVerification(changedFiles, {
  full: forceFull,
  hasResultsFile,
  registryDiff,
});

type Step = { name: string; cmd: string[]; env?: Record<string, string> };
type Result = {
  step: Step;
  code: number;
  ms: number;
  output: string;
};

const steps: Step[] = [
  { name: "fmt", cmd: ["bun", "fmt", "--check"] },
  { name: "check", cmd: ["bun", "check"] },
];

if (plan.needsBuild) {
  steps.push({ name: "build", cmd: ["bun", "run", "build"] });
}

if (plan.mode === "full") {
  steps.push({
    name: "test",
    cmd: ["bun", "test", "--only-failures"],
    env: { BOCI_BIN: "dist/boci", BOCI_PARITY_ALL: "1" },
  });
} else {
  const testTargets: string[] = [];
  if (plan.allUnitTests) {
    testTargets.push("test/unit");
  } else {
    testTargets.push(...plan.unitFiles);
  }
  if (plan.mode !== "none") {
    testTargets.push("test/parity/parity.test.ts");
  }
  if (testTargets.length > 0) {
    steps.push({
      name: "test",
      cmd: ["bun", "test", "--only-failures", ...testTargets],
      env: {
        BOCI_BIN: "dist/boci",
        BOCI_PARITY_ALL: "1",
        BOCI_PARITY_MODE: plan.mode,
        BOCI_VERIFY_MERGE_RESULTS: "1",
        ...(plan.parityFiles.length
          ? { BOCI_PARITY_FILES: plan.parityFiles.join(",") }
          : {}),
        ...(plan.parityIds.length
          ? { BOCI_PARITY_IDS: plan.parityIds.join(",") }
          : {}),
        ...(plan.parityServices.length
          ? { BOCI_PARITY_SERVICES: plan.parityServices.join(",") }
          : {}),
        ...(plan.parityKeys.length
          ? { BOCI_PARITY_KEYS: plan.parityKeys.join(",") }
          : {}),
      },
    });
  }
}

const startedAt = performance.now();
const running = new Map<string, number>();
const results: Result[] = [];
let progressVisible = false;
let childOwnsTerminal = false;

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

function progress() {
  const elapsed = performance.now() - startedAt;
  const active = [...running]
    .map(([name, start]) => `${name} (${duration(performance.now() - start)})`)
    .join(", ");
  const waiting = steps
    .filter(
      (step) =>
        !running.has(step.name) && !results.some((r) => r.step === step),
    )
    .map((step) => step.name);
  const remaining = steps.length - results.length;
  const average = results.length
    ? results.reduce((total, result) => total + result.ms, 0) / results.length
    : undefined;
  const eta = average
    ? `rough ETA ${duration(average * remaining)}`
    : "ETA calculating";
  return [
    `verify: ${results.length}/${steps.length} done`,
    active && `running ${active}`,
    waiting.length && `waiting ${waiting.join(", ")}`,
    `${remaining} remaining`,
    `elapsed ${duration(elapsed)}`,
    eta,
  ]
    .filter(Boolean)
    .join(" · ");
}

function showProgress() {
  if (!process.stdout.isTTY || childOwnsTerminal) return;
  process.stdout.write(`\r\x1b[2K${progress()}`);
  progressVisible = true;
}

function report(result: Result) {
  clearProgress();
  const secs = duration(result.ms);
  if (result.code === 0) {
    const summary =
      result.step.name.startsWith("test") &&
      /Ran \d+ tests[^\n]*/.exec(result.output)?.[0];
    console.log(
      `✓ [${results.length}/${steps.length}] ${result.step.name} (${secs})${summary ? ` ${summary}` : ""}`,
    );
    return;
  }

  const lines = result.output
    .trim()
    .split("\n")
    .filter((line) => !/^\(pass\)/.test(line) && !/^\(skip\)/.test(line));
  const shown = lines.slice(-MAX_LINES);
  console.log(
    `✗ [${results.length}/${steps.length}] ${result.step.name} (exit ${result.code}, ${secs})`,
  );
  if (lines.length > shown.length) {
    const omittedFails = lines
      .slice(0, lines.length - shown.length)
      .filter((line) => /^\(fail\)/.test(line));
    if (omittedFails.length > 0) {
      console.log(omittedFails.join("\n"));
    }
    console.log(`  … ${lines.length - shown.length} earlier lines omitted`);
  }
  console.log(shown.join("\n"));
}

async function run(step: Step) {
  const start = performance.now();
  running.set(step.name, start);
  showProgress();
  // The parity suite renders its own case-level progress. It needs the terminal directly;
  // formatting and type-checking remain captured to keep normal verify output quiet.
  const liveOutput = step.name.startsWith("test") && process.stdout.isTTY;
  if (liveOutput) {
    clearProgress();
    childOwnsTerminal = true;
  }
  const proc = Bun.spawn(step.cmd, {
    cwd: `${import.meta.dir}/..`,
    stdout: liveOutput ? "inherit" : "pipe",
    stderr: liveOutput ? "inherit" : "pipe",
    env: {
      ...process.env,
      ...step.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  const [out, err, code] = liveOutput
    ? ["", "", await proc.exited]
    : await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
  childOwnsTerminal = false;
  running.delete(step.name);
  const result = {
    step,
    code,
    ms: performance.now() - start,
    output: `${out}${err}`,
  };
  results.push(result);
  report(result);
  showProgress();
  return result;
}

// fmt and check are fast and independent; the test suite runs after them.
console.log(
  `verify: ${steps.length} checks (${steps.map((step) => step.name).join(", ")}) [${plan.mode}: ${plan.reason}]`,
);
const heartbeat = setInterval(showProgress, 1_000);
await Promise.all(steps.slice(0, 2).map(run));
for (const step of steps.slice(2)) await run(step);
clearInterval(heartbeat);
clearProgress();

let failed = 0;
for (const r of results) {
  if (r.code !== 0) failed++;
}
console.log(
  `verify: ${results.length - failed}/${steps.length} passed in ${duration(performance.now() - startedAt)}`,
);
process.exit(failed ? 1 : 0);

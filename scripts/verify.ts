// `bun run verify [--dist]`: every check the loop needs before a commit, with quiet output.
// It keeps a live terminal status showing finished, running, and queued checks. One line per
// passing step; a failing step prints its (tail-capped) output. All steps run even if one
// fails, so a single run reports every problem. `--dist` adds the parity suite against the
// compiled binary (`bun run test:dist`).
const MAX_LINES = 150;

type Step = { name: string; cmd: string[] };
type Result = {
  step: Step;
  code: number;
  ms: number;
  output: string;
};
const steps: Step[] = [
  { name: "fmt", cmd: ["bun", "fmt", "--check"] },
  { name: "check", cmd: ["bun", "check"] },
  { name: "test", cmd: ["bun", "test", "--only-failures"] },
];
if (Bun.argv.includes("--dist"))
  steps.push({ name: "test:dist", cmd: ["bun", "run", "test:dist"] });

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
  if (lines.length > shown.length)
    console.log(`  … ${lines.length - shown.length} earlier lines omitted`);
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
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
  `verify: ${steps.length} checks (${steps.map((step) => step.name).join(", ")})`,
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

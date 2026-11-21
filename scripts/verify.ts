// `bun run verify [--dist]`: every check the loop needs before a commit, with quiet output.
// One line per passing step; a failing step prints its (tail-capped) output. All steps run
// even if one fails, so a single run reports every problem. `--dist` adds the parity suite
// against the compiled binary (`bun run test:dist`).
const MAX_LINES = 150;

type Step = { name: string; cmd: string[] };
const steps: Step[] = [
  { name: "fmt", cmd: ["bun", "fmt", "--check"] },
  { name: "check", cmd: ["bun", "check"] },
  { name: "test", cmd: ["bun", "test", "--only-failures"] },
];
if (Bun.argv.includes("--dist"))
  steps.push({ name: "test:dist", cmd: ["bun", "run", "test:dist"] });

async function run(step: Step) {
  const start = performance.now();
  const proc = Bun.spawn(step.cmd, {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { step, code, ms: performance.now() - start, output: `${out}${err}` };
}

// fmt and check are fast and independent; the test suite runs after them.
const results = [
  ...(await Promise.all(steps.slice(0, 2).map(run))),
  ...(await (async () => {
    const rest = [];
    for (const s of steps.slice(2)) rest.push(await run(s));
    return rest;
  })()),
];

let failed = 0;
for (const r of results) {
  const secs = (r.ms / 1000).toFixed(1);
  if (r.code === 0) {
    const summary =
      r.step.name.startsWith("test") &&
      /Ran \d+ tests[^\n]*/.exec(r.output)?.[0];
    console.log(`✓ ${r.step.name} (${secs}s)${summary ? ` ${summary}` : ""}`);
    continue;
  }
  failed++;
  const lines = r.output
    .trim()
    .split("\n")
    .filter((l) => !/^\(pass\)/.test(l) && !/^\(skip\)/.test(l));
  const shown = lines.slice(-MAX_LINES);
  console.log(`✗ ${r.step.name} (exit ${r.code}, ${secs}s)`);
  if (lines.length > shown.length)
    console.log(`  … ${lines.length - shown.length} earlier lines omitted`);
  console.log(shown.join("\n"));
}
process.exit(failed ? 1 : 0);

// `bun run golden [--force] [--filter <substring>] [--spawn]`
// Runs the Reference CLI for every Parity case whose golden is missing or stale and
// stores its normalised observation. The only place the Reference CLI runs (ADR 0004).
// By default each case runs in a child forked from a pre-imported `oci`
// (scripts/oci-zygote.ts, ~6x faster); --spawn starts `oci` afresh for every case.
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "util";
import { normalizeRun } from "../test/harness/compare.ts";
import {
  type Golden,
  type ParityCase,
  caseHash,
  withBrowserCallbackPort,
  goldenPath,
  loadCases,
  loadGolden,
} from "../test/harness/cases.ts";
import {
  CLIS,
  type Launcher,
  runCli,
  spawnLauncher,
} from "../test/harness/runner.ts";
import { zygoteLauncher } from "./oci-zygote.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    force: { type: "boolean", default: false },
    filter: { type: "string" },
    spawn: { type: "boolean", default: false },
  },
});

const referenceVersion = (await Bun.$`${CLIS.oci} --version`.text()).trim();
const cases = (await loadCases()).filter(
  (c) => !values.filter || c.id.includes(values.filter),
);
const todo: ParityCase[] = [];
for (const c of cases) {
  const g = await loadGolden(c);
  if (
    values.force ||
    !g ||
    g.caseHash !== caseHash(c) ||
    g.referenceVersion !== referenceVersion
  )
    todo.push(c);
}
console.log(
  `${todo.length} of ${cases.length} goldens to (re)generate with oci ${referenceVersion}`,
);

// Same-service cases back to back, so a worker's zygote is reused (stable sort keeps order).
if (!values.spawn)
  todo.sort((a, b) => String(a.argv[0]).localeCompare(String(b.argv[0])));

let next = 0;
let done = 0;
let fallbacks = 0;
async function worker() {
  const zygote = values.spawn ? undefined : await zygoteLauncher();
  const launch: Launcher = zygote ?? spawnLauncher;
  try {
    await work(launch);
  } finally {
    fallbacks += zygote?.fallbacks ?? 0;
    await zygote?.close();
  }
}
async function work(launch: Launcher) {
  while (next < todo.length) {
    const c = todo[next++];
    if (!c) break;
    const run = await withBrowserCallbackPort(c, () =>
      runCli(CLIS.oci, c.argv, c, launch),
    );
    const golden: Golden = {
      caseHash: caseHash(c),
      referenceVersion,
      observed: normalizeRun(run),
    };
    await Bun.write(goldenPath(c.id), `${JSON.stringify(golden, null, 2)}\n`);
    done++;
    // Live progress only on a terminal: captured by an agent, `\r` lines pile up (80 B/case).
    if (process.stdout.isTTY)
      process.stdout.write(`\r${done}/${todo.length} ${c.id}`.padEnd(80));
  }
}
await Promise.all(Array.from({ length: availableParallelism() }, worker));
if (todo.length && process.stdout.isTTY) process.stdout.write("\n");
if (todo.length)
  console.log(
    `wrote ${done} goldens${fallbacks ? ` (${fallbacks} spawned: the zygote couldn't run them)` : ""}`,
  );
// JSON.stringify's layout isn't what `bun fmt --check` (in verify) wants.
if (done)
  await Bun.$`${process.execPath} fmt ${dirname(goldenPath("x"))}`.quiet();

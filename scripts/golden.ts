// `bun run golden [--force] [--filter <substring>]`
// Runs the Reference CLI for every Parity case whose golden is missing or stale and
// stores its normalised observation. The only place the Reference CLI runs (ADR 0004).
import { availableParallelism } from "node:os";
import { parseArgs } from "util";
import { normalizeRun } from "../test/harness/compare.ts";
import {
  type Golden,
  type ParityCase,
  caseHash,
  goldenPath,
  loadCases,
  loadGolden,
} from "../test/harness/cases.ts";
import { CLIS, runCli } from "../test/harness/runner.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    force: { type: "boolean", default: false },
    filter: { type: "string" },
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

let next = 0;
let done = 0;
async function worker() {
  while (next < todo.length) {
    const c = todo[next++];
    if (!c) break;
    const run = await runCli(CLIS.oci, c.argv, c);
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
if (todo.length) console.log(`wrote ${done} goldens`);

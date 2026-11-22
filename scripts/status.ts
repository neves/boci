// `bun run status [--all] [--service <name>] [--json]`: parity progress vs the Reference CLI.
import { parseArgs } from "util";
import { implementedLookup } from "../src/registry.ts";
import { buildStatus, countDivergences, renderStatus } from "./status-lib.ts";

const root = `${import.meta.dir}/..`;
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    service: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const resultsFile = Bun.file(`${root}/test/parity/results.json`);
const hasResults = await resultsFile.exists();
const divergencesFile = Bun.file(`${root}/DIVERGENCES.md`);

const index = await Bun.file(`${root}/spec/index.json`).json();
const divergenceCounts = countDivergences(
  (await divergencesFile.exists()) ? await divergencesFile.text() : "",
);
const status = buildStatus({
  index,
  ladder: await Bun.file(`${root}/PLAN.md`).text(),
  implemented: await implementedLookup(Object.keys(index.root.commands)),
  results: hasResults ? await resultsFile.json() : {},
  divergences:
    divergenceCounts.accepted +
    divergenceCounts.unresolved +
    divergenceCounts.resolved,
  divergenceCounts,
});

if (values.json) {
  const { leaves: _leaves, ...summary } = status;
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    renderStatus(status, { all: values.all, service: values.service }),
  );
  if (!hasResults)
    console.log(
      "\nNo parity results yet: nothing counts as verified until `bun run verify` runs every case.",
    );
}

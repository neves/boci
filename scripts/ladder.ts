// `bun run ladder`        print the rung holding the next Ladder item, and that item
// `bun run ladder tick`   mark the next item done   (`- [x]`)
// `bun run ladder stuck`  mark the next item stuck  (`- [~]`, see AGENTS.md "When stuck")
// `bun run ladder sync`   mark every verified command item done (`- [x]`)
import { currentItem, markCurrent, syncItems } from "./ladder-lib.ts";

const root = `${import.meta.dir}/..`;
const file = Bun.file(`${root}/PLAN.md`);
const plan = await file.text();
const action = Bun.argv[2] ?? "next";

if (action === "next") {
  const cur = currentItem(plan);
  if (!cur) {
    console.log("Ladder complete.");
  } else {
    console.log(cur.section);
    console.log(`\nNext (PLAN.md:${cur.line}):\n${cur.item}`);
  }
} else if (action === "tick" || action === "stuck") {
  const res = markCurrent(plan, action === "tick" ? "x" : "~");
  if (!res) {
    console.error("No unticked item.");
    process.exit(1);
  }
  await Bun.write(file, res.markdown);
  console.log(res.item);
} else if (action === "sync") {
  const resultsFile = Bun.file(`${root}/test/parity/results.json`);
  const results: Record<string, { pass: boolean }> =
    (await resultsFile.exists()) ? await resultsFile.json() : {};
  const res = syncItems(plan, (key) => Boolean(results[key]?.pass));
  if (res.total > 0) await Bun.write(file, res.markdown);
  if (res.counts.length === 0) {
    console.log("0 items ticked.");
  } else {
    for (const { rung, ticked } of res.counts) {
      console.log(`${rung}: ${ticked} ticked`);
    }
  }
} else {
  console.error("usage: bun run ladder [next|tick|stuck|sync]");
  process.exit(2);
}

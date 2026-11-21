// `bun run ladder`        print the rung holding the next Ladder item, and that item
// `bun run ladder tick`   mark the next item done   (`- [x]`)
// `bun run ladder stuck`  mark the next item stuck  (`- [~]`, see AGENTS.md "When stuck")
import { currentItem, markCurrent } from "./ladder-lib.ts";

const file = Bun.file(`${import.meta.dir}/../PLAN.md`);
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
} else {
  console.error("usage: bun run ladder [next|tick|stuck]");
  process.exit(2);
}

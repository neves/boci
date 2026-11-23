import { expect, test } from "bun:test";
import {
  currentItem,
  markCurrent,
  syncItems,
} from "../../scripts/ladder-lib.ts";

const plan = `# plan

## Rung 0 — A

- [x] one
- [~] two

## Rung 1 — B

- [x] three
- [ ] four: details
- [ ] five

## Rung 2 — C

- [ ] six
`;

test("currentItem returns the rung section and the first unticked item", () => {
  const cur = currentItem(plan);
  expect(cur?.item).toBe("- [ ] four: details");
  expect(cur?.line).toBe(11);
  expect(cur?.section).toBe(
    "## Rung 1 — B\n\n- [x] three\n- [ ] four: details\n- [ ] five",
  );
});

test("markCurrent ticks or marks stuck only the first unticked item", () => {
  const ticked = markCurrent(plan, "x");
  expect(ticked?.item).toBe("- [x] four: details");
  expect(currentItem(ticked!.markdown)?.item).toBe("- [ ] five");
  expect(markCurrent(plan, "~")?.item).toBe("- [~] four: details");
});

test("a complete ladder has no current item", () => {
  const done = plan.replaceAll("- [ ]", "- [x]");
  expect(currentItem(done)).toBeUndefined();
  expect(markCurrent(done, "x")).toBeUndefined();
});

test("syncItems ticks verified todo and stuck command items and counts per rung", () => {
  const fixture = `# plan

## Rung 7 — Custom

- [x] \`os ns get\`
- [ ] \`iam region list\`

## Rung 8 — Remaining

- [~] \`os object head\`
- [ ] \`compute instance list\`
- [ ] Write documentation
- [ ] Update \`os ns get\` docs
`;
  const verified = new Set(["os ns get", "iam region list", "os object head"]);
  const res = syncItems(fixture, (key) => verified.has(key));
  expect(res.total).toBe(2);
  expect(res.counts).toEqual([
    { rung: "Rung 7 — Custom", ticked: 1 },
    { rung: "Rung 8 — Remaining", ticked: 1 },
  ]);
  expect(res.markdown).toBe(`# plan

## Rung 7 — Custom

- [x] \`os ns get\`
- [x] \`iam region list\`

## Rung 8 — Remaining

- [x] \`os object head\`
- [ ] \`compute instance list\`
- [ ] Write documentation
- [ ] Update \`os ns get\` docs
`);
});

test("syncItems leaves non-command items alone and is idempotent", () => {
  const fixture = `# plan

## Rung 0 — Offline

- [ ] Plain prose item
- [ ] \`boci --version\` → \`3.96.3\`
- [ ] Update \`README.md\` with numbers

## Rung 8 — Remaining

- [ ] \`os ns get\`
- [ ] \`iam region list\`
`;
  const first = syncItems(fixture, (key) => key !== "iam region list");
  expect(first.total).toBe(1);
  expect(first.counts).toEqual([{ rung: "Rung 8 — Remaining", ticked: 1 }]);
  expect(first.markdown).toContain("- [x] `os ns get`");
  expect(first.markdown).toContain("- [ ] `iam region list`");
  expect(first.markdown).toContain("- [ ] Plain prose item");
  expect(first.markdown).toContain("- [ ] `boci --version` → `3.96.3`");
  expect(first.markdown).toContain("- [ ] Update `README.md` with numbers");

  const second = syncItems(first.markdown, (key) => key !== "iam region list");
  expect(second.total).toBe(0);
  expect(second.counts).toEqual([]);
  expect(second.markdown).toBe(first.markdown);
});

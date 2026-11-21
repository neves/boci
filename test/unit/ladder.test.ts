import { expect, test } from "bun:test";
import { currentItem, markCurrent } from "../../scripts/ladder-lib.ts";

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

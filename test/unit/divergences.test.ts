import { expect, test } from "bun:test";

const text = await Bun.file(`${import.meta.dir}/../../DIVERGENCES.md`).text();
const entries = text.split("## Entries")[1] ?? "";

test("every divergence entry states invocation, behaviours, reason and state", () => {
  for (const entry of entries.split(/^### /m).slice(1)) {
    for (const field of [
      "**Invocation:**",
      "**Reference CLI:**",
      "**boci:**",
      "**Why:**",
      "**State:**",
    ]) {
      expect(entry, `entry "${entry.split("\n")[0]}" lacks ${field}`).toContain(
        field,
      );
    }
  }
});

test("status counts only real entries, not the format example", () => {
  // The format example lives in a fenced block above "## Entries"; status counts /^### /m
  // over the whole file, so the example must not start a line with "### " outside the fence.
  const outsideFences = text.replace(/```[\s\S]*?```/g, "");
  expect(outsideFences.match(/^### /gm)?.length ?? 0).toBe(
    entries.match(/^### /gm)?.length ?? 0,
  );
});

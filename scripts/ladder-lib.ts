// Pure core of `bun run ladder`: find the next Ladder item and tick it, without an agent
// having to read (or re-write) all of PLAN.md.

const TODO = /^- \[ \] /;

export type Current = {
  /** The `## Rung …` section holding the next item, verbatim. */
  section: string;
  /** The next item's full line. */
  item: string;
  /** 1-based line number of the item in PLAN.md. */
  line: number;
};

export function currentItem(markdown: string): Current | undefined {
  const lines = markdown.split("\n");
  const at = lines.findIndex((l) => TODO.test(l));
  if (at < 0) return undefined;
  let start = at;
  while (start > 0 && !lines[start]?.startsWith("## ")) start--;
  let end = at + 1;
  while (end < lines.length && !lines[end]?.startsWith("## ")) end++;
  return {
    section: lines.slice(start, end).join("\n").trimEnd(),
    item: lines[at] ?? "",
    line: at + 1,
  };
}

/** Marks the next item done (`x`) or stuck (`~`). */
export function markCurrent(
  markdown: string,
  mark: "x" | "~",
): { markdown: string; item: string } | undefined {
  const lines = markdown.split("\n");
  const at = lines.findIndex((l) => TODO.test(l));
  if (at < 0) return undefined;
  const item = (lines[at] ?? "").replace(TODO, `- [${mark}] `);
  lines[at] = item;
  return { markdown: lines.join("\n"), item };
}

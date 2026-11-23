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

const SYNCABLE = /^- \[[ ~]\] `([^`]+)`(?:\s*$|[.:]\s|[.:]$)/;

export type SyncResult = {
  markdown: string;
  counts: { rung: string; ticked: number }[];
  total: number;
};

/** Marks `[x]` every `[ ]` or `[~]` command item whose key passes `isVerified`. */
export function syncItems(
  markdown: string,
  isVerified: (key: string) => boolean,
): SyncResult {
  const lines = markdown.split("\n");
  const byRung = new Map<string, number>();
  let currentRung = "";
  let total = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1]) {
      currentRung = heading[1].trim();
      continue;
    }
    const match = SYNCABLE.exec(line);
    const key = match?.[1];
    if (key && isVerified(key)) {
      lines[i] = line.replace(/^- \[[ ~]\] /, "- [x] ");
      byRung.set(currentRung, (byRung.get(currentRung) ?? 0) + 1);
      total++;
    }
  }

  return {
    markdown: lines.join("\n"),
    counts: [...byRung.entries()].map(([rung, ticked]) => ({ rung, ticked })),
    total,
  };
}

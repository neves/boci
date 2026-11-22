// Pure core of `bun run status`: Verification state per Leaf command and Ladder progress.

export type TreeNode = {
  name: string;
  hidden: boolean;
  commands?: Record<string, TreeNode>;
};

export type LadderItem = { text: string; state: "done" | "todo" | "stuck" };
export type Rung = { title: string; items: LadderItem[] };

export type Counts = {
  missing: number;
  implemented: number;
  verified: number;
  total: number;
};

type DivergenceCounts = Record<"accepted" | "unresolved" | "resolved", number>;

export function countDivergences(markdown: string): DivergenceCounts {
  const counts = { accepted: 0, unresolved: 0, resolved: 0 };
  const entries = markdown.split(/^## Entries$/m)[1] ?? "";
  for (const match of entries.matchAll(
    /^- \*\*State:\*\* (accepted|unresolved|resolved)\b/gm,
  )) {
    counts[match[1] as keyof DivergenceCounts]++;
  }
  return counts;
}

export type Status = {
  referenceVersion: string;
  totals: Counts;
  services: Record<string, Counts>;
  leaves: Record<string, "missing" | "implemented" | "verified">;
  rungs: Rung[];
  next?: string;
  divergences: number;
  divergenceCounts?: DivergenceCounts;
  kinds: { generated: number; custom: number };
};

export type StatusInput = {
  index: {
    referenceVersion: string;
    root: TreeNode;
    kinds?: Record<string, { generated: number; custom: number }>;
  };
  ladder: string;
  implemented: (path: string) => boolean;
  results: Record<string, { pass: boolean }>;
  divergences: number;
  divergenceCounts?: DivergenceCounts;
};

const STATES = { x: "done", " ": "todo", "~": "stuck" } as const;

export function parseLadder(markdown: string): Rung[] {
  const rungs: Rung[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^## (Rung .*)$/.exec(line);
    if (heading?.[1]) {
      rungs.push({ title: heading[1], items: [] });
      continue;
    }
    const item = /^- \[([x ~])\] (.*)$/.exec(line);
    if (item && rungs.length > 0) {
      const [, mark, text] = item;
      rungs.at(-1)?.items.push({
        text: (text ?? "").split(/[:.] /)[0] ?? "",
        state: STATES[mark as keyof typeof STATES],
      });
    }
  }
  return rungs;
}

function* leafPaths(node: TreeNode, path: string[]): Generator<string> {
  if (!node.commands) {
    yield path.join(" ");
    return;
  }
  for (const [name, child] of Object.entries(node.commands)) {
    yield* leafPaths(child, [...path, name]);
  }
}

const empty = (): Counts => ({
  missing: 0,
  implemented: 0,
  verified: 0,
  total: 0,
});

export function buildStatus(input: StatusInput): Status {
  const totals = empty();
  const services: Record<string, Counts> = {};
  const leaves: Status["leaves"] = {};
  for (const [service, node] of Object.entries(
    input.index.root.commands ?? {},
  )) {
    const counts = (services[service] = empty());
    for (const path of leafPaths(node, [service])) {
      const state = input.results[path]?.pass
        ? "verified"
        : input.implemented(path)
          ? "implemented"
          : "missing";
      leaves[path] = state;
      for (const c of [counts, totals]) {
        c[state]++;
        c.total++;
      }
    }
  }
  const rungs = parseLadder(input.ladder);
  const next = rungs
    .flatMap((r) => r.items)
    .find((i) => i.state === "todo")?.text;
  return {
    referenceVersion: input.index.referenceVersion,
    totals,
    services,
    leaves,
    rungs,
    next,
    divergences: input.divergences,
    divergenceCounts: input.divergenceCounts,
    kinds: Object.values(input.index.kinds ?? {}).reduce(
      (a, k) => ({
        generated: a.generated + k.generated,
        custom: a.custom + k.custom,
      }),
      { generated: 0, custom: 0 },
    ),
  };
}

const pct = (n: number, d: number) =>
  d === 0 ? "0.0" : ((100 * n) / d).toFixed(1);

function line(name: string, c: Counts): string {
  return `${name.padEnd(28)} ${String(c.verified).padStart(5)} ${String(c.implemented).padStart(5)} ${String(c.missing).padStart(5)} ${String(c.total).padStart(5)}  ${pct(c.verified, c.total).padStart(5)}%`;
}

export function renderStatus(
  status: Status,
  opts: { service?: string; all?: boolean } = {},
): string {
  const out: string[] = [];
  const t = status.totals;
  out.push(`boci parity vs oci ${status.referenceVersion}`);
  out.push(
    `Leaf commands: ${t.verified} verified, ${t.implemented} implemented, ${t.missing} missing of ${t.total} (${pct(t.verified, t.total)}% verified)`,
  );
  out.push(
    `  ${status.kinds.generated} generated (engine-driven), ${status.kinds.custom} custom (hand-written)`,
  );
  const counts = status.divergenceCounts;
  out.push(
    counts
      ? `Divergences: ${counts.accepted} accepted, ${counts.unresolved} unresolved, ${counts.resolved} resolved`
      : `Divergences: ${status.divergences}`,
  );
  out.push("");
  out.push("Ladder:");
  for (const rung of status.rungs) {
    const done = rung.items.filter((i) => i.state === "done").length;
    const stuck = rung.items.filter((i) => i.state === "stuck").length;
    out.push(
      `  ${done === rung.items.length ? "✓" : " "} ${rung.title}  ${done}/${rung.items.length}${stuck ? ` (${stuck} stuck)` : ""}`,
    );
  }
  out.push(`Next: ${status.next ?? "(ladder complete)"}`);
  out.push("");

  if (opts.service) {
    out.push(line(opts.service, status.services[opts.service] ?? empty()));
    for (const [path, state] of Object.entries(status.leaves)) {
      if (path === opts.service || path.startsWith(`${opts.service} `)) {
        out.push(`  ${state.padEnd(8)} ${path}`);
      }
    }
    return out.join("\n");
  }

  out.push(
    `${"service".padEnd(28)} ${"verif".padStart(5)} ${"impl".padStart(5)} ${"miss".padStart(5)} ${"total".padStart(5)}  ${"done".padStart(6)}`,
  );
  const rows = Object.entries(status.services)
    .filter(([, c]) => opts.all || c.verified + c.implemented > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [name, c] of rows) out.push(line(name, c));
  const hidden = Object.keys(status.services).length - rows.length;
  if (hidden > 0)
    out.push(`… ${hidden} services with nothing implemented (use --all)`);
  return out.join("\n");
}

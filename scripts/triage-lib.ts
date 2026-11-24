// Pure helpers for `bun run triage` and `bun run scaffold` (unit-tested).

export type TreeNode = { name: string; commands?: Record<string, TreeNode> };

export type SdkCall = {
  client: string;
  method: string;
  line: number;
  operation?: Record<string, unknown>;
  error?: string;
};

/** One line of tools/extract/triage.py output. */
export type Triage = {
  key: string;
  error?: string;
  exclusion?: string;
  callback?: string;
  source?: { file: string; line: number; lines: number };
  sourceText?: string;
  kind?: "generated" | "custom";
  tier?: string;
  reason?: string;
  blame?: { source: string; line: number | null };
  sdkCalls?: SdkCall[];
  helpers?: string[];
  invokes?: string[];
  /** Every independent blocker: capability -> the first source that needs it. */
  needs?: Record<string, string | null>;
};

/** Every Leaf command key under the index's root tree ("iam compartment list"). */
export function leafKeys(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode, path: string[]) => {
    if (!node.commands) {
      out.push(path.join(" "));
      return;
    }
    for (const [name, child] of Object.entries(node.commands))
      walk(child, [...path, name]);
  };
  for (const [name, child] of Object.entries(root.commands ?? {}))
    walk(child, [name]);
  return out;
}

/**
 * The blocker a missing command shares with others: one bucket is one compiler or
 * Engine extension (AGENTS.md: "Group what fails by cause, one commit per cause").
 */
export function bucket(t: Triage): string {
  if (t.exclusion) return t.exclusion;
  if (t.error) return `error: ${t.error}`;
  if (t.kind === "generated")
    return "engine: generated request shape unsupported";
  if (t.tier === "A") return "engine: Tier A delegate request unsupported";
  const reason = t.reason ?? "compiles (Engine request unsupported?)";
  if (reason === "call keywords" && t.blame) {
    const callee = t.blame.source.match(/^([\w.]+)\(/)?.[1] ?? "";
    if (/^client\w*\./.test(callee) || /\bclient\b/.test(t.blame.source))
      return "sdk call: client.<method>(...) (Tier C)";
    return `call keywords: ${callee || t.blame.source.slice(0, 40)}`;
  }
  if (reason === "attribute" && t.blame)
    return `attribute: ${t.blame.source.replace(/\(.*$/s, "").slice(0, 60)}`;
  return reason;
}

/** Commands grouped by bucket, biggest first. */
export function groupByBucket(rows: Triage[]): [string, Triage[]][] {
  const groups = new Map<string, Triage[]>();
  for (const row of rows) {
    const b = bucket(row);
    groups.set(b, [...(groups.get(b) ?? []), row]);
  }
  return [...groups].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
}

/**
 * Blockers that only make sense together: the shape every hand-written (Tier C) wrapper
 * shares, copied from the generated commands. One bundle is one capability.
 */
export const BUNDLES: Record<string, string[]> = {
  "Tier C: build_client + client.<method>(...) + render_response": [
    "no ctx.invoke (calls the SDK directly)",
    "sdk: client.<method>(...)",
    "call cli_util.render_response",
    "call cli_util.use_or_generate_request_id",
    "attribute .data",
  ],
  "Tier C: generated waiter block (oci.wait_until under try/except)": [
    "call oci.wait_until",
    "call hasattr",
    "call callable",
    "call getattr",
    "try",
    "except",
    "call click.echo",
    "call sys.exit",
  ],
};

const BUNDLE_OF = new Map(
  Object.entries(BUNDLES).flatMap(([b, needs]) => needs.map((n) => [n, b])),
);

/** What a command still needs: its blockers (bundled), or why the Engine refuses it. */
export function needsOf(t: Triage): string[] {
  const needs = Object.keys(t.needs ?? {});
  if (!needs.length || t.exclusion) return [bucket(t)];
  return [
    ...new Set(
      needs.map((n) => {
        const bundle = BUNDLE_OF.get(n);
        if (
          bundle?.includes("waiter") &&
          !needs.includes("call oci.wait_until")
        )
          return n;
        if (bundle?.includes("build_client") && !t.sdkCalls?.length) return n;
        return bundle ?? n;
      }),
    ),
  ];
}

export type UnlockStep = {
  capability: string;
  /** Commands whose every need is met once this step lands. */
  unlocked: string[];
  /** Commands that need it at all. */
  users: number;
};

/**
 * A greedy order of capabilities: each step is the one that completes the most
 * commands given the steps before it (ties: the most-used). One step is one Ladder item.
 */
export function unlockPlan(rows: Triage[]): UnlockStep[] {
  const pending = new Map(rows.map((t) => [t.key, new Set(needsOf(t))]));
  const steps: UnlockStep[] = [];
  while (pending.size) {
    const score = new Map<string, { done: number; users: number }>();
    for (const needs of pending.values())
      for (const n of needs) {
        const s = score.get(n) ?? { done: 0, users: 0 };
        s.users++;
        if (needs.size === 1) s.done++;
        score.set(n, s);
      }
    const [capability] = [...score].sort(
      (a, b) =>
        b[1].done - a[1].done ||
        b[1].users - a[1].users ||
        a[0].localeCompare(b[0]),
    )[0]!;
    const unlocked: string[] = [];
    for (const [key, needs] of pending) {
      needs.delete(capability);
      if (!needs.size) {
        unlocked.push(key);
        pending.delete(key);
      }
    }
    steps.push({ capability, unlocked, users: score.get(capability)!.users });
  }
  return steps;
}

export function renderPlan(rows: Triage[], verbose = false): string {
  const lines = [
    `${rows.length} missing Leaf commands. Unlock order (one step = one capability = one Ladder item):`,
    "",
    "  step  +done  total  uses  capability",
  ];
  let total = 0;
  unlockPlan(rows).forEach((s, i) => {
    total += s.unlocked.length;
    lines.push(
      `  ${String(i + 1).padStart(4)}  ${String(s.unlocked.length).padStart(5)}  ${String(total).padStart(5)}  ${String(s.users).padStart(4)}  ${s.capability}`,
    );
    const shown = verbose ? s.unlocked : s.unlocked.slice(0, 2);
    for (const key of shown) lines.push(`${" ".repeat(30)}${key}`);
    if (shown.length < s.unlocked.length)
      lines.push(`${" ".repeat(30)}… ${s.unlocked.length - shown.length} more`);
  });
  return lines.join("\n");
}

/** Absolute line of the blamed node in the Reference CLI source file. */
export function blameLine(t: Triage): number | undefined {
  if (!t.source || !t.blame?.line) return undefined;
  return t.source.line + t.blame.line - 1;
}

export function renderTriage(rows: Triage[], verbose = false): string {
  const lines = [`${rows.length} missing Leaf commands, by blocker:`, ""];
  for (const [name, group] of groupByBucket(rows)) {
    lines.push(`${String(group.length).padStart(4)}  ${name}`);
    const shown = verbose ? group : group.slice(0, 3);
    for (const t of shown) {
      const where = t.source
        ? `  ${t.source.file}:${blameLine(t) ?? t.source.line}`
        : "";
      lines.push(`        ${t.key}${where}`);
    }
    if (shown.length < group.length)
      lines.push(`        … ${group.length - shown.length} more`);
  }
  return lines.join("\n");
}

const camel = (s: string) =>
  s.replace(/[-_ ]+(\w)/g, (_, c: string) => c.toUpperCase());

/** File, export and constant names for a scaffolded Custom command. */
export function scaffoldNames(key: string) {
  const [service, ...path] = key.split(" ");
  const pascal = (s: string) => {
    const c = camel(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
  };
  return {
    service: service!,
    path: path.join(" "),
    file: `src/commands/${service}/${path.join("_").replaceAll("-", "_") || "index"}.ts`,
    fn: `run${pascal(service!)}${path.map(pascal).join("")}`,
    caseId: key.replaceAll(" ", "-"),
    caseFile: `test/parity/cases/${key.replaceAll(" ", "-")}.json`,
  };
}

/** `list_compartments` -> `listCompartmentsOperation`. */
export function operationConst(method: string): string {
  return `${camel(method)}Operation`;
}

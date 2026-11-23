// `bun run spec <service> [<command words>…] [--full]`
// One Leaf command's extracted spec, compact: kind, HTTP operation, option bindings and
// options. Use it instead of reading spec/*.json (up to ~2 MB per service).
// With only a service (or a group prefix), lists the matching Leaf commands.
// `--full` prints the raw spec entry (minus helpDoc). Help text: `bun src/main.ts … --help`.
import { join } from "node:path";
import type { ServiceSpec } from "../src/core/spec.ts";

const args = Bun.argv.slice(2);
const full = args.includes("--full");
const [service, ...words] = args.filter((a) => a !== "--full");
if (!service) {
  console.error("usage: bun run spec <service> [<command words>…] [--full]");
  process.exit(2);
}
const file = Bun.file(join(import.meta.dir, "..", "spec", `${service}.json`));
if (!(await file.exists())) {
  console.error(`no spec/${service}.json (service names: spec/index.json)`);
  process.exit(1);
}
const spec = (await file.json()) as ServiceSpec;
const key = words.join(" ");
type Command = ServiceSpec["commands"][string] & {
  bindings?: { target: string; key: string[]; param: string; when?: string }[];
  tier?: "A" | "B" | "C";
  delegate?: { callback: string; renames: Record<string, string> };
  patterns?: string[];
  survey?: {
    invokes?: string[];
    checks?: { when: string; options: string[]; message: string }[];
    folds?: {
      target: string;
      path: (string | number)[];
      options: string[];
      json?: boolean;
      value?: unknown;
    }[];
    files?: string[];
    helpers?: string[];
  };
};
const cmd = spec.commands[key] as Command | undefined;

if (!cmd) {
  const matches = Object.keys(spec.commands).filter(
    (k) => k === key || k.startsWith(key ? `${key} ` : ""),
  );
  if (!matches.length) {
    console.error(`no leaf command "${service} ${key}"`);
    process.exit(1);
  }
  const shown = matches.slice(0, 200);
  for (const k of shown)
    console.log(`${spec.commands[k]?.kind.padEnd(9)} ${service} ${k}`);
  if (matches.length > shown.length)
    console.log(`… ${matches.length - shown.length} more`);
  process.exit(0);
}

if (full) {
  const { helpDoc: _h, ...rest } = cmd as Command & { helpDoc?: unknown };
  console.log(JSON.stringify(rest, null, 1));
  process.exit(0);
}

console.log(`${service} ${key}  [${cmd.kind}]${cmd.hidden ? " hidden" : ""}`);
if (cmd.tier)
  console.log(
    `tier: ${cmd.tier}${cmd.delegate ? ` → ${cmd.delegate.callback}` : ""}`,
  );
if (cmd.patterns) console.log(`patterns: ${cmd.patterns.join(" ")}`);
const sv = cmd.survey;
for (const i of sv?.invokes ?? []) console.log(`invokes: ${i}`);
for (const c of sv?.checks ?? [])
  console.log(
    `check${c.test ? "" : " (not compiled)"}: ${c.message}\n  when ${c.when}`,
  );
for (const c of cmd.delegate?.checks ?? [])
  console.log(`check: ${c.message}\n  test ${JSON.stringify(c.test)}`);
for (const f of sv?.folds ?? [])
  console.log(
    `fold: ${f.options.join(",") || JSON.stringify(f.value)} → ${[f.target, ...f.path].join(".")}${f.json ? " (json)" : ""}`,
  );
if (sv?.files?.length) console.log(`files: ${sv.files.join(" ")}`);
if (sv?.helpers?.length) console.log(`helpers: ${sv.helpers.join(" ")}`);
const op = cmd.operation as
  | (NonNullable<Command["operation"]> & {
      paginated?: boolean;
      positionalArgs?: string[];
    })
  | undefined;
if (op) {
  console.log(
    `${op.http} ${op.path}  ${op.client}.${op.method}${op.responseType ? ` → ${op.responseType}` : ""}${op.paginated ? "  (paginated)" : ""}`,
  );
  const fmt = (o: Record<string, unknown> | undefined) =>
    Object.entries(o ?? {})
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  if (op.pathParams && Object.keys(op.pathParams).length)
    console.log(`path:   ${fmt(op.pathParams)}`);
  if (Object.keys(op.queryParams ?? {}).length)
    console.log(`query:  ${fmt(op.queryParams)}`);
  if (op.headerParams && Object.keys(op.headerParams).length)
    console.log(`header: ${fmt(op.headerParams)}`);
}
if (cmd.bindings?.length) {
  console.log("bindings:");
  for (const b of cmd.bindings)
    console.log(
      `  ${b.param} → ${b.target}:${b.key.join(".")}${b.when ? `  (when ${b.when})` : ""}`,
    );
}
console.log("options:");
for (const p of cmd.params ?? []) {
  const q = p as unknown as Record<string, unknown>;
  if (q.name === "help") continue;
  const names = [
    ...((q.opts as string[]) ?? []),
    ...((q.secondaryOpts as string[]) ?? []),
  ].join(", ");
  const bits = [
    String(q.type),
    q.required ? "required" : "",
    q.multiple ? "multiple" : "",
    q.isFlag ? "flag" : "",
    q.hidden ? "hidden" : "",
    q.default !== undefined && q.default !== null && q.default !== false
      ? `default=${JSON.stringify(q.default)}`
      : "",
    Array.isArray(q.choices)
      ? `choices=${(q.choices as string[]).slice(0, 12).join("|")}${(q.choices as string[]).length > 12 ? "|…" : ""}`
      : "",
  ].filter(Boolean);
  console.log(`  ${names}  ${bits.join(" ")}`);
}

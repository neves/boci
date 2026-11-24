// `bun run triage [--service <name>] [--verbose] [--first] [--json] [--refresh] [key...]`
// Why each missing Leaf command is missing, grouped by blocker. One blocker is one
// compiler (tools/extract/program.py) or Engine extension that unlocks every command in
// its group: implement by cause, not command by command. Results are cached in
// .build/triage.json (fingerprinted by extractor source and its pinned Reference CLI dependency).
import { parseArgs } from "util";
import { cpus } from "os";
import { EXCLUDED, implementedLookup } from "../src/core/registry.ts";
import {
  leafKeys,
  renderPlan,
  renderTriage,
  type Triage,
} from "./triage-lib.ts";

const root = `${import.meta.dir}/..`;

export async function missingKeys(): Promise<string[]> {
  const index = await Bun.file(`${root}/spec/index.json`).json();
  const implemented = await implementedLookup(Object.keys(index.root.commands));
  return leafKeys(index.root).filter((k) => !implemented(k));
}

/** Runs tools/extract/triage.py once per service, in parallel. */
export async function triageKeys(keys: string[]): Promise<Triage[]> {
  const byService = new Map<string, string[]>();
  for (const key of keys) {
    const [service, ...path] = key.split(" ");
    byService.set(service!, [
      ...(byService.get(service!) ?? []),
      path.join(" "),
    ]);
  }
  const queue = [...byService];
  const rows: Triage[] = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [service, paths] = job;
      const proc = Bun.spawn(
        [
          "uv",
          "run",
          "--quiet",
          "--python",
          "3.12",
          `${root}/tools/extract/triage.py`,
          service,
          ...paths,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const err = stderr.trim();
        for (const p of paths)
          rows.push({
            key: [service, p].filter(Boolean).join(" "),
            error: err.split("\n").at(-1) ?? "triage failed",
          });
        continue;
      }
      for (const line of out.split("\n"))
        if (line.trim()) rows.push(JSON.parse(line));
    }
  };
  await Promise.all(Array.from({ length: Math.min(cpus().length, 8) }, worker));
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

export async function cachedTriage(
  keys: string[],
  refresh = false,
): Promise<Triage[]> {
  const hash = new Bun.CryptoHasher("sha256");
  for (const name of ["triage.py", "sdk.py", "program.py", "checks.py"])
    hash.update(await Bun.file(`${root}/tools/extract/${name}`).arrayBuffer());
  const file = Bun.file(`${root}/.build/triage.json`);
  const version = hash.digest("hex");
  const saved = (await file.exists()) ? await file.json() : {};
  const rows: Record<string, Triage> =
    saved.version === version ? saved.rows : {};
  const fresh = await triageKeys(
    keys.filter((k) => refresh || !Object.hasOwn(rows, k)),
  );
  for (const row of fresh) rows[row.key] = row;
  if (fresh.length)
    await Bun.write(
      file,
      JSON.stringify({
        version,
        rows: Object.fromEntries(
          Object.entries(rows).filter(([, r]) => !r.error),
        ),
      }),
    );
  return keys.flatMap((k) =>
    rows[k] ? [{ ...rows[k], exclusion: EXCLUDED.get(k) }] : [],
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      service: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      json: { type: "boolean", default: false },
      // Group by first blocker instead of printing the unlock plan.
      first: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
    },
  });

  let keys = positionals.length ? [positionals.join(" ")] : await missingKeys();
  if (values.service)
    keys = keys.filter((k) => k.split(" ")[0] === values.service);
  const rows = await cachedTriage(keys, values.refresh);
  if (values.json) {
    console.log(JSON.stringify(rows, null, 1));
  } else if (positionals.length) {
    for (const t of rows) {
      const { sourceText: _s, sdkCalls, ...rest } = t;
      console.log(
        JSON.stringify(
          {
            ...rest,
            sdkCalls: sdkCalls?.map(({ operation: _o, ...c }) => c),
          },
          null,
          1,
        ),
      );
    }
  } else if (values.first) {
    console.log(renderTriage(rows, values.verbose));
  } else {
    console.log(renderPlan(rows, values.verbose));
  }
}

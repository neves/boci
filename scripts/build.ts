// `bun run build [--outfile dist/boci] [--target bun-linux-x64]`
// Compiles dist/boci with spec/ embedded: each spec file zstd-compressed and imported
// `with { type: "file" }`, so it's carried in the binary but only read when used.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "util";

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, ".build");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outfile: { type: "string", default: "dist/boci" },
    target: { type: "string" },
  },
});

await rm(BUILD, { recursive: true, force: true });
await mkdir(join(BUILD, "spec"), { recursive: true });

const imports: string[] = [];
const entries: string[] = [];
let i = 0;
let raw = 0;
let packed = 0;
for await (const file of new Bun.Glob("*.json").scan(join(ROOT, "spec"))) {
  const name = file.slice(0, -".json".length);
  // Minified JSON parses faster; the runtime index doesn't need the full command tree
  // (each service rebuilds its own from its spec) nor the dev-only summaries.
  const data = await Bun.file(join(ROOT, "spec", file)).json();
  if (name === "index") {
    delete data.root;
    delete data.kinds;
    delete data.rootHelp;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const zst = Bun.zstdCompressSync(bytes, { level: 19 });
  raw += bytes.length;
  packed += zst.length;
  await Bun.write(join(BUILD, "spec", `${name}.json.zst`), zst);
  imports.push(
    `import s${i} from "./spec/${name}.json.zst" with { type: "file" };`,
  );
  entries.push(`  ${JSON.stringify(name)}: s${i},`);
  i++;
}
await Bun.write(
  join(BUILD, "entry.ts"),
  `${imports.join("\n")}
import { useEmbeddedSpec } from "../src/core/spec.ts";
useEmbeddedSpec({
${entries.join("\n")}
});
await import("../src/main.ts");
`,
);

const result = await Bun.build({
  entrypoints: [join(BUILD, "entry.ts")],
  compile: {
    outfile: join(ROOT, values.outfile),
    ...(values.target ? { target: values.target as never } : {}),
  },
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;
console.log(
  `spec: ${i} files, ${mb(raw)} → ${mb(packed)} zstd · ${values.outfile}: ${mb(Bun.file(join(ROOT, values.outfile)).size)}`,
);

// `bun run build [--outfile dist/boci] [--target bun-linux-x64]`
// Compiles dist/boci with spec/ embedded: each spec file zstd-compressed and imported
// `with { type: "file" }`, so it's carried in the binary but only read when used.
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "util";
import pkg from "../package.json" with { type: "json" };
import { resolveBociVersion } from "../src/core/version.ts";

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, ".build");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outfile: { type: "string", default: "dist/boci" },
    target: { type: "string" },
  },
});

await mkdir(join(BUILD, "spec"), { recursive: true });
const buildScriptMtime = (await stat(import.meta.path)).mtimeMs;

const specFiles: string[] = [];
for await (const file of new Bun.Glob("*.json").scan(join(ROOT, "spec"))) {
  specFiles.push(file);
}
specFiles.sort();

const imports: string[] = [];
const entries: string[] = [];
const expectedZst = new Set<string>();
let i = 0;
let raw = 0;
let packed = 0;
for (const file of specFiles) {
  const name = file.slice(0, -".json".length);
  const srcPath = join(ROOT, "spec", file);
  const zstName = `${name}.json.zst`;
  const zstPath = join(BUILD, "spec", zstName);
  expectedZst.add(zstName);

  const srcStat = await stat(srcPath);
  let zstStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    zstStat = await stat(zstPath);
  } catch {
    zstStat = undefined;
  }

  if (
    zstStat &&
    zstStat.mtimeMs >= Math.max(srcStat.mtimeMs, buildScriptMtime)
  ) {
    raw += srcStat.size;
    packed += zstStat.size;
  } else {
    // Minified JSON parses faster; the runtime index doesn't need the full command tree
    // (each service rebuilds its own from its spec) nor the dev-only summaries.
    const data = await Bun.file(srcPath).json();
    if (name === "index") {
      delete data.root;
      delete data.kinds;
      delete data.rootHelp;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const zst = Bun.zstdCompressSync(bytes, { level: 19 });
    raw += bytes.length;
    packed += zst.length;
    await Bun.write(zstPath, zst);
  }
  imports.push(
    `import s${i} from "./spec/${name}.json.zst" with { type: "file" };`,
  );
  entries.push(`  ${JSON.stringify(name)}: s${i},`);
  i++;
}
for await (const existing of new Bun.Glob("*.json.zst").scan(
  join(BUILD, "spec"),
)) {
  if (!expectedZst.has(existing)) {
    await rm(join(BUILD, "spec", existing), { force: true });
  }
}
const entryPath = join(BUILD, "entry.ts");
const entryContent = `${imports.join("\n")}
import { useEmbeddedSpec } from "../src/core/spec.ts";
useEmbeddedSpec({
${entries.join("\n")}
});
await import("../src/main.ts");
`;
const existingEntry = Bun.file(entryPath);
if (
  !(await existingEntry.exists()) ||
  (await existingEntry.text()) !== entryContent
) {
  await Bun.write(entryPath, entryContent);
}

const bociVersion = resolveBociVersion(process.env.BOCI_VERSION, pkg.version);
const result = await Bun.build({
  entrypoints: [join(BUILD, "entry.ts")],
  compile: {
    outfile: join(ROOT, values.outfile),
    ...(values.target ? { target: values.target as never } : {}),
  },
  define: {
    "process.env.BOCI_VERSION": JSON.stringify(bociVersion),
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

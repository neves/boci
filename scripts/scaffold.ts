// `bun run scaffold [--dry-run] [--force] <command key>`
// Scaffolds a Custom (Tier C) command from the Reference CLI's extracted SDK operations:
//   1. src/commands/<service>/<path>.ts  (with extracted OperationSpec constants)
//   2. src/core/registry.ts              (codemods a lazy CUSTOM_HANDLERS entry)
//   3. test/parity/cases/<case-id>.json  (starter Parity case with required options)
import { parseArgs } from "util";
import { loadService } from "../src/core/spec.ts";
import {
  registerCustomHandler,
  renderCommandFile,
  renderParityCase,
  type SpecParam,
} from "./scaffold-lib.ts";
import { isImplemented } from "../src/core/registry.ts";
import { cachedTriage } from "./triage.ts";
import { scaffoldNames } from "./triage-lib.ts";

const root = `${import.meta.dir}/..`;
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const key = positionals.join(" ").trim();
if (!key) {
  console.error("usage: bun run scaffold [--dry-run] [--force] <command key>");
  process.exit(2);
}

const names = scaffoldNames(key);
const spec = await loadService(names.service);
const specCmd = spec.commands[names.path];
if (!specCmd || specCmd.tier !== "C" || isImplemented(key, specCmd)) {
  console.error("scaffold requires a missing Tier C Leaf command");
  process.exit(1);
}
const [info] = await cachedTriage([key]);
if (!info || info.error) throw new Error(info?.error ?? "No triage result");
const params = (specCmd?.params ?? []) as SpecParam[];

const commandSource = renderCommandFile(info, params);
const caseSource = renderParityCase(
  key,
  params,
  Boolean(info.sdkCalls?.length || info.invokes?.length),
);
const registryPath = `${root}/src/core/registry.ts`;
const registrySource = await Bun.file(registryPath).text();
const registry = registerCustomHandler(registrySource, key);

const commandPath = `${root}/${names.file}`;
const casePath = `${root}/${names.caseFile}`;

if (values["dry-run"]) {
  console.log(`=== ${names.file} ===\n${commandSource}`);
  console.log(`=== ${names.caseFile} ===\n${caseSource}`);
  console.log(
    `=== src/core/registry.ts (${registry.changed ? "would add" : "already registered"}) ===`,
  );
  process.exit(0);
}

const writeIfAllowed = async (path: string, rel: string, content: string) => {
  if (!values.force && (await Bun.file(path).exists())) {
    console.log(`skip   ${rel} (already exists; pass --force to overwrite)`);
    return false;
  }
  await Bun.write(path, content);
  console.log(`write  ${rel}`);
  return true;
};

await writeIfAllowed(commandPath, names.file, commandSource);
await writeIfAllowed(casePath, names.caseFile, caseSource);
if (registry.changed) {
  await Bun.write(registryPath, registry.source);
  console.log(`update src/core/registry.ts`);
} else {
  console.log(`skip   src/core/registry.ts (already registered)`);
}

console.log(
  `\nNext:\n  bun run golden --filter ${names.caseId}\n  bun test test/parity -t '${names.caseId}'`,
);

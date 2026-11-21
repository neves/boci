// Access to the extracted command surface (spec/). Loaded lazily, per service, like
// the Reference CLI loads only the service named on the command line.
import { join } from "node:path";

import type { DatetimeSpec, TypedParam } from "./convert.ts";
import type { ParseSettings } from "./parser.ts";

export type HelpDoc = {
  usage: string;
  text: string;
  records: [string, string][];
  epilog?: string;
  shortHelp?: string;
  deprecated?: boolean;
  parse: ParseSettings;
};

export type TreeNode = {
  name: string;
  hidden: boolean;
  commands?: Record<string, TreeNode>;
};

export type SpecNode = {
  hidden: boolean;
  help?: string;
  shortHelp?: string;
  helpDoc: HelpDoc;
  params?: TypedParam[];
};

export type ServiceSpec = {
  service: string;
  top: SpecNode;
  groups: Record<string, SpecNode>;
  commands: Record<string, SpecNode & { kind: "generated" | "custom" }>;
};

export type Index = {
  referenceVersion: string;
  rootHelpDoc: HelpDoc;
  ociHelp: string;
  ociUserHelp: string;
  nonServiceCommands: string[];
  servicesWithoutCommands: string[];
  globalParams: TypedParam[];
  datetime: DatetimeSpec;
  services: Record<string, { dir: string; title: string; category: string }>;
  root: TreeNode;
};

const SPEC_DIR = join(import.meta.dir, "..", "spec");

/**
 * In the compiled binary, spec files are embedded zstd-compressed (scripts/build.ts
 * registers their embedded paths here). From source, they are read from spec/.
 */
let embedded: Record<string, string> | undefined;
export function useEmbeddedSpec(files: Record<string, string>) {
  embedded = files;
}

async function readSpec(name: string): Promise<unknown> {
  if (embedded) {
    const path = embedded[name];
    if (!path) throw new Error(`boci: no embedded spec for ${name}`);
    return JSON.parse(
      new TextDecoder().decode(
        Bun.zstdDecompressSync(await Bun.file(path).bytes()),
      ),
    );
  }
  return Bun.file(join(SPEC_DIR, `${name}.json`)).json();
}

let index: Index | undefined;
export async function loadIndex(): Promise<Index> {
  index ??= (await readSpec("index")) as Index;
  return index;
}

export async function loadService(name: string): Promise<ServiceSpec> {
  return (await readSpec(name)) as ServiceSpec;
}

/** Longest prefix of `tokens` naming a node in the tree, stopping at the first option. */
export function resolvePath(
  root: TreeNode,
  tokens: string[],
): { path: string[]; node: TreeNode } {
  const path: string[] = [];
  let node = root;
  for (const t of tokens) {
    if (t.startsWith("-")) break;
    const next = node.commands?.[t];
    if (!next) break;
    path.push(t);
    node = next;
  }
  return { path, node };
}

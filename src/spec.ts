// Access to the extracted command surface (spec/). Loaded lazily, per service, like
// the Reference CLI loads only the service named on the command line.
import { join } from "node:path";

export type HelpDoc = {
  usage: string;
  text: string;
  records: [string, string][];
  epilog?: string;
  shortHelp?: string;
  deprecated?: boolean;
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
  services: Record<string, { dir: string; title: string; category: string }>;
  root: TreeNode;
};

const SPEC_DIR = join(import.meta.dir, "..", "spec");

let index: Index | undefined;
export async function loadIndex(): Promise<Index> {
  index ??= (await Bun.file(join(SPEC_DIR, "index.json")).json()) as Index;
  return index;
}

export async function loadService(name: string): Promise<ServiceSpec> {
  return (await Bun.file(join(SPEC_DIR, `${name}.json`)).json()) as ServiceSpec;
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

// Access to the extracted command surface (spec/). Loaded lazily, per service, like
// the Reference CLI loads only the service named on the command line.
import { join } from "node:path";

import type { DatetimeSpec, TypedParam } from "./convert.ts";
import type { ParseSettings } from "./parser.ts";
import type { RegionsSpec, ClientInfo } from "./endpoint.ts";

export type OperationSpec = {
  client: string;
  method: string;
  http: string;
  path: string;
  responseType?: string;
  queryParams: Record<string, { arg?: string }>;
  pathParams?: Record<string, string>;
  headerParams?: Record<string, { arg?: string; value?: string }>;
  body?: string;
};

export type HelpDoc = {
  usage: string;
  text: string;
  records: [string, string][];
  epilog?: string;
  shortHelp?: string;
  deprecated?: boolean;
  parse: ParseSettings;
  aliasAware?: boolean;
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
  commands: Record<
    string,
    SpecNode & { kind: "generated" | "custom"; operation?: OperationSpec }
  >;
  clients: Record<string, ClientInfo>;
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
  regions: RegionsSpec;
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

/** Parsed once per process: specs are read-only, so in-process runs share them. */
const services = new Map<string, Promise<ServiceSpec>>();
export function loadService(name: string): Promise<ServiceSpec> {
  let spec = services.get(name);
  if (!spec) {
    spec = readSpec(name) as Promise<ServiceSpec>;
    services.set(name, spec);
  }
  return spec;
}

/**
 * The command tree of one service, rebuilt from its spec (group and command keys), so the
 * runtime index doesn't carry the whole tree (start-up: parse only what's used).
 */
export function serviceTree(spec: ServiceSpec): TreeNode {
  const root: TreeNode = { name: spec.service, hidden: spec.top.hidden };
  if (spec.commands[""]) return root; // the service itself is a leaf (e.g. raw-request)
  root.commands = {};
  const ensure = (path: string[], hidden: boolean, leaf: boolean) => {
    let node = root;
    path.forEach((part, i) => {
      node.commands ??= {};
      const last = i === path.length - 1;
      node.commands[part] ??= {
        name: part,
        hidden: false,
        ...(last && leaf ? {} : { commands: {} }),
      };
      node = node.commands[part] as TreeNode;
      if (last) node.hidden = hidden;
    });
  };
  for (const [key, g] of Object.entries(spec.groups))
    ensure(key.split(" "), g.hidden, false);
  for (const [key, c] of Object.entries(spec.commands))
    ensure(key.split(" "), c.hidden, true);
  return root;
}

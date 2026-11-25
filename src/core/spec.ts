// Access to the extracted command surface (spec/). Loaded lazily, per service, like
// the Reference CLI loads only the service named on the command line.
import { join } from "node:path";

import type { DatetimeSpec, TypedParam } from "./convert.ts";
import type { Models } from "./camelize.ts";
import type { ParseSettings } from "./parser.ts";
import type { RegionsSpec, ClientInfo } from "./endpoint.ts";
import type { Predicate, UsageCheck } from "./checks.ts";
import type { Statement } from "./program.ts";

export type OperationSpec = {
  client: string;
  workRequestClient?: string;
  lifecycleGetter?: string;
  lifecycleGetterError?: string;
  method: string;
  http: string;
  path: string;
  positionalArgs?: string[];
  responseType?: string;
  queryParams: Record<string, { arg?: string; collectionFormat?: string }>;
  pathParams?: Record<string, string>;
  fixedPathParams?: Record<string, string>;
  headerParams?: Record<string, { arg?: string; value?: string }>;
  body?: string;
  enforce_content_headers?: boolean;
  paginated?: boolean;
  /** Generated callback checks `if sort_by and not availability_domain and not all_pages:`. */
  sortByRequiresAd?: boolean;
  /** Generated callback prompts `WARNING: Updates to ...` unless `--force`, for these params. */
  updateConfirm?: string[];
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
  jsonExamples?: {
    full: unknown;
    params: Record<string, string>;
  };
};

export type ServiceSpec = {
  service: string;
  top: SpecNode;
  groups: Record<string, SpecNode>;
  commands: Record<
    string,
    SpecNode & {
      otherOperations?: string[];
      kind: "generated" | "custom";
      tier?: "A" | "B" | "C";
      delegate?: {
        callback: string;
        renames: Record<string, string>;
        /** The wrapper's own `Parameter --x cannot be whitespace or empty string` checks. */
        blankChecks?: { param: string; message: string }[];
        /** The wrapper's other UsageError checks, compiled to predicates. */
        checks?: UsageCheck[];
        /** The wrapper is decorated with cli_util.wrap_exceptions. */
        wrapExceptions?: boolean;
        /** The delegated command's complex types, when not the wrapper's. */
        complexTypes?: Record<string, string>;
      };
      /** input_params_to_complex_types, as `{param: "module:class"}`. */
      complexTypes?: Record<string, string>;
      /** Tier B survey (tools/extract/patterns.py); only what the Engine reads. */
      survey?: {
        /** `test` is present when the check compiles and precedes any I/O. */
        checks?: { message: string; test?: Predicate }[];
        wrapExceptions?: boolean;
      };
      /** A Tier B/C wrapper's body compiled to a program (tools/extract/program.py). */
      program?: {
        body: Statement[];
        wrapExceptions: boolean;
        rawRequests?: boolean;
      };
      /** The generated command a programmed wrapper invokes; operation and bindings are its. */
      generated?: GeneratedTarget;
      operation?: OperationSpec;
      /**
       * The other generated commands a programmed wrapper invokes, one per variant
       * (ticket 14); an invoke's target index `i` names `variants[i - 1]`.
       */
      variants?: WrapperTarget[];
      /** Direct SDK operations a programmed wrapper calls (`client.<method>(...)`). */
      sdkOperations?: OperationSpec[];
    }
  >;
  clients: Record<
    string,
    ClientInfo & {
      workRequestGetter?: OperationSpec;
      lifecycleGetters?: Record<string, OperationSpec>;
    }
  >;
  jsonExamplePool: Record<string, unknown>;
  /** SDK models complex params' key camelization reaches (ticket 19). */
  models?: Models;
};

/** A generated command a programmed Tier B wrapper invokes. */
export type GeneratedTarget = {
  callback: string;
  params: TypedParam[];
  complexTypes?: Record<string, string>;
};

export type WrapperTarget = {
  generated: GeneratedTarget;
  operation: OperationSpec;
  bindings: Record<string, unknown>[];
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

const SPEC_DIR = join(import.meta.dir, "..", "..", "spec");

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

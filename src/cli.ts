// Click's invocation flow for the oci command tree (click.core main → Group.invoke →
// resolve_command → make_context), reproduced so boci fails, helps and dispatches exactly
// like the Reference CLI. See ADR 0003 and the usage parity cases.
import { commandHelp, groupHelp, rootHelp } from "./help/render.ts";
import { HelpFormatter, helpWidth } from "./help/formatter.ts";
import {
  BadParameter,
  convert,
  errorHint,
  processingOrder,
} from "./convert.ts";
import { getCloseMatches } from "./difflib.ts";
import {
  OptionParser,
  type ParamSpec,
  splitOpt,
  UsageError,
} from "./parser.ts";
import {
  type HelpDoc,
  type Index,
  type ServiceSpec,
  type TreeNode,
  loadIndex,
  loadService,
} from "./spec.ts";
import { REFERENCE_VERSION } from "./version.ts";

/** Click's prog name. boci answers as `oci` so usage text matches what scripts expect. */
const PROG = "oci";
const INTERACTIVE_SUGGESTION =
  "For OCI CLI commands and parameters suggestion, auto completion and other useful features, try the Interactive mode by typing `oci -i`.";

export class Exit {
  constructor(public code: number) {}
}

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

const repr = (s: string) =>
  s.includes("'") && !s.includes('"')
    ? `"${s}"`
    : `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

function usage(commandPath: string, doc: HelpDoc): string {
  const f = new HelpFormatter(helpWidth());
  f.writeUsage(commandPath, doc.usage);
  return f.getvalue().replace(/\n+$/, "");
}

/** Click's stock UsageError.show (before the root callback patches it): stderr.
 * `usageText` is null when Click raised the error without a context. */
function showStock(usageText: string | null, message: string): never {
  if (usageText !== null) err(`${usageText}\n\n`);
  err(`Error: ${message}\n`);
  throw new Exit(2);
}

/** cli_util.update_click_help_message, installed by the root callback: stdout. */
function showPatched(usageText: string | null, message: string): never {
  if (usageText !== null) out(`${usageText}\n\n`);
  out(`Error: ${message}\n\n`);
  out(`${INTERACTIVE_SUGGESTION}\n`);
  throw new Exit(2);
}

/** Click's parser raises BadOptionUsage/BadArgumentUsage without a ctx: no usage line. */
const usageFor = (e: UsageError, usageText: () => string) =>
  e.type === "BadOptionUsage" || e.type === "BadArgumentUsage"
    ? null
    : usageText();

function noSuchCommand(name: string, possibilities: Iterable<string>): string {
  const close = getCloseMatches(name, possibilities);
  let message = `No such command ${repr(name)}.`;
  if (close.length) {
    const list = [...close].sort().map(repr).join(", ");
    message +=
      close.length === 1
        ? ` Did you mean ${list}?`
        : ` (Did you mean one of: ${list}?)`;
  }
  return message;
}

const has = (opts: Record<string, unknown>, name: string) =>
  opts[name] !== undefined;

export async function run(argv: string[]): Promise<void> {
  const index = await loadIndex();
  const rootUsage = () => usage(PROG, index.rootHelpDoc);

  // 1. Root context: interspersed, unknown options ignored, so root options are taken
  //    from anywhere on the command line (that's why `oci os ns get --help` works).
  let root: ReturnType<OptionParser["parse"]>;
  try {
    root = new OptionParser(index.globalParams, index.rootHelpDoc.parse).parse(
      argv,
    );
  } catch (e) {
    if (e instanceof UsageError) showStock(usageFor(e, rootUsage), e.message);
    throw e;
  }
  // Root params in Click's processing order: eager first (--version exits here), then type
  // conversion. Errors still use the stock display: the root callback hasn't run yet.
  // TODO(rung 0): --release-info, --latest-version, --cli-rc-file, --generate-*-json-input.
  const rootValues: Record<string, unknown> = {};
  for (const p of processingOrder(root.order, index.globalParams)) {
    if (p.name === "version" && root.opts.version !== undefined) {
      out(`${REFERENCE_VERSION}\n`);
      throw new Exit(0);
    }
    if (root.opts[p.name] === undefined) continue;
    try {
      rootValues[p.name] = convert(p, root.opts[p.name], index.datetime);
    } catch (e) {
      if (e instanceof BadParameter)
        showStock(
          rootUsage(),
          `Invalid value for ${errorHint(p)}: ${e.message}`,
        );
      throw e;
    }
  }
  const rest = root.args;

  // 2. No subcommand: invoke_without_command → root callback → echo_help.
  if (rest.length === 0) {
    await printRootHelp(index);
    throw new Exit(0);
  }

  // 3. Resolve the service. Only the core commands and the first service named anywhere
  //    in argv are registered (dynamic_loader.load_service_from_command).
  const loaded = new Set(index.nonServiceCommands);
  const named = argv.find((a) => a in index.services);
  if (named && !index.servicesWithoutCommands.includes(named))
    loaded.add(named);
  const name = rest[0] as string;
  if (!loaded.has(name) || !index.root.commands?.[name]) {
    if (splitOpt(name)[0]) {
      // resolve_command re-parses when the token looks like an option.
      try {
        new OptionParser(index.globalParams, index.rootHelpDoc.parse).parse(
          rest,
        );
      } catch (e) {
        if (e instanceof UsageError)
          showStock(usageFor(e, rootUsage), e.message);
        throw e;
      }
    }
    showStock(
      rootUsage(),
      noSuchCommand(name, rootCommandOrder(index, loaded)),
    );
  }

  // 4. Root callback runs: UsageError.show is now patched to stdout.
  if (has(root.opts, "max_retries") && root.opts.no_retry === true) {
    showPatched(
      rootUsage(),
      "The option --max-retries is not applicable when using the --no-retry flag.",
    );
  }
  const helpRequested = root.opts.help === true;

  // 5. Walk groups down to the leaf.
  const spec = await loadService(name);
  let node = index.root.commands[name] as TreeNode;
  let path: string[] = [name];
  let args = rest.slice(1);
  while (node.commands) {
    const sub = path.slice(1).join(" ");
    const group = sub ? spec.groups[sub] : spec.top;
    if (!group) break;
    const commandPath = [PROG, ...path].join(" ");
    if (args.length === 0) {
      // NoArgsIsHelpError.show: the group's help on stderr.
      err(
        `${groupHelp(commandPath, group.helpDoc, children(spec, node, path.slice(1)))}\n`,
      );
      throw new Exit(2);
    }
    let parsed: ReturnType<OptionParser["parse"]>;
    try {
      parsed = new OptionParser(group.params ?? [], group.helpDoc.parse).parse(
        args,
      );
    } catch (e) {
      if (e instanceof UsageError)
        showPatched(
          usageFor(e, () => usage(commandPath, group.helpDoc)),
          e.message,
        );
      throw e;
    }
    if (parsed.args.length === 0)
      showPatched(usage(commandPath, group.helpDoc), "Missing command.");
    const childName = parsed.args[0] as string;
    const child = node.commands[childName];
    if (!child) {
      if (splitOpt(childName)[0]) {
        try {
          new OptionParser(group.params ?? [], group.helpDoc.parse).parse(
            parsed.args,
          );
        } catch (e) {
          if (e instanceof UsageError)
            showPatched(
              usageFor(e, () => usage(commandPath, group.helpDoc)),
              e.message,
            );
          throw e;
        }
      }
      showPatched(
        usage(commandPath, group.helpDoc),
        noSuchCommand(childName, Object.keys(node.commands)),
      );
    }
    node = child;
    path = [...path, childName];
    args = parsed.args.slice(1);
  }

  // 6. Leaf: parse, eager help, then extra-argument check.
  const key = path.slice(1).join(" ");
  const cmd = spec.commands[key];
  if (!cmd) throw new Error(`boci: spec has no command ${path.join(" ")}`);
  const commandPath = [PROG, ...path].join(" ");
  let parsed: ReturnType<OptionParser["parse"]>;
  try {
    parsed = new OptionParser(cmd.params ?? [], cmd.helpDoc.parse).parse(args);
  } catch (e) {
    if (e instanceof UsageError)
      showPatched(
        usageFor(e, () => usage(commandPath, cmd.helpDoc)),
        e.message,
      );
    throw e;
  }
  if (helpRequested) {
    // cli_util.help_callback: eager, prints when the root saw a help flag.
    out(`${commandHelp(commandPath, cmd.helpDoc)}\n`);
    throw new Exit(0);
  }
  const values: Record<string, unknown> = {};
  for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
    if (parsed.opts[p.name] === undefined) continue;
    try {
      values[p.name] = convert(p, parsed.opts[p.name], index.datetime);
    } catch (e) {
      if (e instanceof BadParameter)
        showPatched(
          usage(commandPath, cmd.helpDoc),
          `Invalid value for ${errorHint(p)}: ${e.message}`,
        );
      throw e;
    }
  }
  if (parsed.args.length && !cmd.helpDoc.parse.allowExtra) {
    const n = parsed.args.length;
    showPatched(
      usage(commandPath, cmd.helpDoc),
      `Got unexpected extra argument${n === 1 ? "" : "s"} (${parsed.args.join(" ")})`,
    );
  }

  // oci's required check (cli_util._coalesce_param → wrap_exceptions): params marked
  // required that got no value, in processing order, reported with sys.exit → stderr, 1.
  // TODO: values from oci_cli_rc, --from-json, and the os/iam service fallbacks.
  const missing = processingOrder(parsed.order, cmd.params ?? [])
    .filter((p) => p.required && !p.isFlag && isMissing(parsed.opts[p.name]))
    .map((p) => p.name.replaceAll("_", "-"));
  if (missing.length) {
    err(
      `${usage(commandPath, cmd.helpDoc)}\n\nError: Missing option(s) --${missing.join(", --")}.\n`,
    );
    throw new Exit(1);
  }

  await notImplemented(argv, commandPath);
}

/** Exit code for "boci doesn't implement this yet" (oci itself uses 0, 1 and 2). */
export const NOT_IMPLEMENTED = 3;

/**
 * The command is valid but boci can't run it yet. With BOCI_FALLBACK set (e.g. to `oci`),
 * hand the untouched argv, stdin and stdio to the Reference CLI and return its exit code.
 */
async function notImplemented(
  argv: string[],
  commandPath: string,
): Promise<never> {
  const fallback = process.env.BOCI_FALLBACK;
  const depth = Number(process.env.BOCI_FALLBACK_DEPTH ?? "0");
  if (fallback && depth === 0) {
    const bin = Bun.which(fallback) ?? fallback;
    const proc = Bun.spawn([bin, ...argv], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, BOCI_FALLBACK_DEPTH: String(depth + 1) },
    });
    throw new Exit(await proc.exited);
  }
  err(
    `boci: '${commandPath}' is not implemented yet (run \`bun run status\` in the boci repo for coverage).\n` +
      "Set BOCI_FALLBACK=oci to run unimplemented commands with the Reference CLI.\n",
  );
  throw new Exit(NOT_IMPLEMENTED);
}

const isMissing = (v: unknown) =>
  v === undefined || (Array.isArray(v) && v.length === 0);

/** Root group's registered commands in insertion order (core first, then the loaded service). */
function rootCommandOrder(index: Index, loaded: Set<string>): string[] {
  return [
    ...index.nonServiceCommands,
    ...[...loaded].filter((n) => !index.nonServiceCommands.includes(n)),
  ];
}

function children(spec: ServiceSpec, node: TreeNode, sub: string[]) {
  return Object.entries(node.commands ?? {}).map(([childName, child]) => {
    const key = [...sub, childName].join(" ");
    const s = child.commands ? spec.groups[key] : spec.commands[key];
    return {
      name: childName,
      hidden: child.hidden,
      help: s?.help,
      shortHelp: s?.helpDoc.shortHelp,
    };
  });
}

async function printRootHelp(index: Index) {
  const core = await Promise.all(
    index.nonServiceCommands.map(async (n) => {
      const top = (await loadService(n)).top;
      return {
        name: n,
        hidden: top.hidden,
        help: top.help,
        shortHelp: top.helpDoc.shortHelp,
      };
    }),
  );
  out(
    `${rootHelp(index.rootHelpDoc, core, index.services, index.ociHelp, index.ociUserHelp)}\n`,
  );
}

export type { ParamSpec };

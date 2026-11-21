// Click's invocation flow for the oci command tree (click.core main → Group.invoke →
// resolve_command → make_context), reproduced so boci fails, helps and dispatches exactly
// like the Reference CLI. See ADR 0003 and the usage parity cases.
import { readFileSync } from "node:fs";
import {
  ConfigError,
  DEFAULT_LOCATION,
  DEFAULT_PROFILE,
  expandUser,
  fromFile,
} from "./config.ts";
import { parseConfig, sectionItems } from "./configparser.ts";
import {
  type Rc,
  RC_DEFAULT_LOCATION,
  aliasRecords,
  applyParamAliases,
  badAliasMessages,
  effectiveAliases,
  loadRc,
  lookupDefault,
  rcDefaults,
} from "./rc.ts";
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
  serviceTree,
} from "./spec.ts";
import { REFERENCE_VERSION } from "./version.ts";
import { resolveEndpoint } from "./endpoint.ts";
import { loadPrivateKey, prepareContentLength, signRequest } from "./signer.ts";

/** Click's prog name. boci answers as `oci` so usage text matches what scripts expect. */
const PROG = "oci";
const INTERACTIVE_SUGGESTION =
  "For OCI CLI commands and parameters suggestion, auto completion and other useful features, try the Interactive mode by typing `oci -i`.";

export class Exit {
  constructor(public code: number) {}
}

import { err, flush, isTTY, out } from "./io.ts";

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
  // --cli-rc-file is eager with a default, so its callback (rc loading) always runs.
  const rc = loadRc(
    (rootValues.cli_rc_file as string | undefined) ?? RC_DEFAULT_LOCATION,
  );
  const rest = root.args;

  // populate_parameter_aliases runs inside that eager callback: it shims rc parameter
  // aliases into every loaded leaf command and the root params (too late for the root
  // parser of this invocation, but visible in help), reporting problems in red.
  const loaded = new Set(index.nonServiceCommands);
  const named = argv.find((a) => a in index.services);
  if (named && !index.servicesWithoutCommands.includes(named))
    loaded.add(named);
  const aliases = effectiveAliases(rc);
  const hasAliases = Object.values(aliases).some((a) => a.length);
  const shimmed = new Set(loaded); // services whose commands got the aliases
  const rootParamsAliased = hasAliases
    ? applyParamAliases(index.globalParams, aliases)
    : null;
  {
    const messages = badAliasMessages(rc);
    for (const m of messages) err(`${style(m, "red", isTTY(2))}\n`);
    if (hasAliases) {
      const collisions: string[] = [];
      for (const service of loaded) {
        for (const c of Object.values((await loadService(service)).commands)) {
          for (const m of applyParamAliases(c.params ?? [], aliases).collisions)
            if (!collisions.includes(m)) collisions.push(m);
        }
      }
      for (const m of rootParamsAliased?.collisions ?? [])
        if (!collisions.includes(m)) collisions.push(m);
      if (collisions.length)
        err(`${style(collisions.join("\n"), "red", isTTY(2))}\n`);
    }
  }
  const rootHelpDoc = rootParamsAliased
    ? {
        ...index.rootHelpDoc,
        records: aliasRecords(
          index.rootHelpDoc.records,
          index.globalParams,
          rootParamsAliased.params,
        ),
      }
    : index.rootHelpDoc;

  // 2. No subcommand: invoke_without_command → root callback → echo_help.
  if (rest.length === 0) {
    await printRootHelp(index, rootHelpDoc);
    throw new Exit(0);
  }

  // 3. Resolve the service. Only the core commands and the first service named anywhere
  //    in argv are registered (dynamic_loader.load_service_from_command).
  const typedName = rest[0] as string;
  const rootAlias = resolveAlias(rc, "oci", typedName, true, (n) => {
    // An alias target is loaded on demand (dynamic_loader.load_service).
    if (
      n !== typedName &&
      n in index.services &&
      !index.servicesWithoutCommands.includes(n)
    )
      loaded.add(n);
    return loaded.has(n);
  });
  if (rootAlias.target === undefined) {
    if (splitOpt(typedName)[0]) {
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
      noSuchCommand(typedName, rootCommandOrder(index, loaded)),
    );
  }
  const name = rootAlias.target;

  // 4. Root callback runs: UsageError.show is now patched to stdout.
  if (has(root.opts, "max_retries") && root.opts.no_retry === true) {
    showPatched(
      rootUsage(),
      "The option --max-retries is not applicable when using the --no-retry flag.",
    );
  }
  const settings = resolveRootSettings(rootValues, rc, rootUsage);
  if (typedName !== "profile") checkKeyForSecurity(settings); // invoked_subcommand is the typed name
  const helpRequested = root.opts.help === true;

  // 5. Walk groups down to the leaf. `path` holds names as typed (Click's info_name,
  //    shown in usage); `canon` the canonical command names (spec keys).
  const spec = await loadService(name);
  let node = serviceTree(spec);
  let path: string[] = [typedName];
  let canon: string[] = [name];
  let args = rest.slice(1);
  while (node.commands) {
    const sub = canon.slice(1).join(" ");
    const group = sub ? spec.groups[sub] : spec.top;
    if (!group) break;
    const commandPath = [PROG, ...path].join(" ");
    if (args.length === 0) {
      // NoArgsIsHelpError.show: the group's help on stderr.
      err(
        `${groupHelp(commandPath, group.helpDoc, children(spec, node, canon.slice(1)))}\n`,
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
    const commands = node.commands;
    const resolved = resolveAlias(
      rc,
      canon.join(" "),
      childName,
      group.helpDoc.aliasAware === true,
      (n) => Boolean(commands[n]),
    );
    const child =
      resolved.target === undefined ? undefined : commands[resolved.target];
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
    canon = [...canon, resolved.target as string];
    args = parsed.args.slice(1);
  }

  // 6. Leaf: parse, eager help, then extra-argument check.
  const key = canon.slice(1).join(" ");
  const specCmd = spec.commands[key];
  if (!specCmd) throw new Error(`boci: spec has no command ${path.join(" ")}`);
  // rc parameter aliases apply to commands of services loaded before the root callback.
  const aliased =
    hasAliases && shimmed.has(name)
      ? applyParamAliases(specCmd.params ?? [], aliases).params
      : null;
  const cmd = aliased
    ? {
        ...specCmd,
        params: aliased,
        helpDoc: {
          ...specCmd.helpDoc,
          records: aliasRecords(
            specCmd.helpDoc.records,
            specCmd.params ?? [],
            aliased,
          ),
        },
      }
    : specCmd;
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
  // oci_cli_rc defaults count as provided. TODO: --from-json and the os/iam service fallbacks.
  const defaults = rcDefaults(rc, settings.profile);
  const missing = processingOrder(parsed.order, cmd.params ?? [])
    .filter(
      (p) =>
        p.required &&
        !p.isFlag &&
        isMissing(parsed.opts[p.name]) &&
        lookupDefault(defaults, rc, path, p) === undefined,
    )
    .map((p) => p.name.replaceAll("_", "-"));
  if (missing.length) {
    err(
      `${usage(commandPath, cmd.helpDoc)}\n\nError: Missing option(s) --${missing.join(", --")}.\n`,
    );
    throw new Exit(1);
  }

  if (key === "ns get" && name === "os") {
    await runNamespaceGet(values, rootValues, settings, spec, index);
    return;
  }
  await notImplemented(argv, commandPath);
}

async function runNamespaceGet(
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  settings: RootSettings,
  spec: ServiceSpec,
  index: Index,
): Promise<void> {
  let config;
  try {
    config = fromFile(settings.configFile, settings.profile);
  } catch (e) {
    if (e instanceof ConfigError) {
      if (e.type === "ConfigFileNotFound") {
        const message = e.message.split(", please follow")[0] as string;
        out(
          `ERROR: ${message}\nDo you want to create a new config file? [Y/n]: `,
        );
        err("Abort: \n");
        throw new Exit(1);
      }
      err(`ERROR: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }
  const operation = spec.commands["ns get"]?.operation;
  if (!operation) throw new Error("boci: missing os ns get operation spec");
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const endpointOpt = (rootValues.endpoint ?? config.endpoint) as
    string | undefined;
  const region = (rootValues.region ??
    process.env.OCI_CLI_REGION ??
    config.region) as string | undefined;
  const { resolved } = resolveEndpoint(client, index.regions, {
    region,
    endpoint: endpointOpt,
    realmSpecific: configBool(
      values.realm_specific_endpoint ??
        config.realm_specific_service_endpoint_template_enabled,
    ),
    dualStack: configBool(
      values.enable_dual_stack ?? config.dual_stack_endpoint_enabled,
    ),
  });
  const url = new URL(`${resolved}${operation.path}`);
  if (values.compartment_id !== undefined)
    url.searchParams.set("compartmentId", String(values.compartment_id));
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "opc-client-retries": "true",
  };
  const keyPath = expandUser(String(config.key_file));
  const pem = readFileSync(keyPath, "utf8");
  const keyId = `${config.tenancy}/${config.user}/${config.fingerprint}`;
  const req = { method: "GET", url: url.toString(), headers, body: "" };
  prepareContentLength(req);
  signRequest(req, {
    keyId,
    privateKey: loadPrivateKey(pem, config.pass_phrase as string | null),
  });
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
  });
  const raw = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  out(`${JSON.stringify(sortJson({ data: value }), null, 2)}\n`);
}

function configBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortJson(v)]),
    );
  return value;
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
    await flush(); // anything boci printed (warnings) comes before the child's output
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

async function printRootHelp(index: Index, doc: HelpDoc) {
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
    `${rootHelp(doc, core, index.services, index.ociHelp, index.ociUserHelp)}\n`,
  );
}

export type { ParamSpec };

// ---------------------------------------------------------------- root callback

const AUTH_CHOICES = [
  "api_key",
  "instance_principal",
  "security_token",
  "instance_obo_user",
  "resource_principal",
  "oke_workload_identity",
  "pkcs11",
];

export type RootSettings = {
  configFile: string;
  profile: string;
  auth: string | null;
};

/** cli_root.cli: config file (OCI_CLI_CONFIG_FILE), profile (--profile, OCI_CLI_PROFILE, rc
 * default_profile), auth (OCI_CLI_AUTH). */
function resolveRootSettings(
  values: Record<string, unknown>,
  rc: Rc,
  rootUsage: () => string,
): RootSettings {
  const env = process.env;
  let configFile =
    (values.config_file as string | undefined) ?? DEFAULT_LOCATION;
  // read_values_from_env: only when not given or equal to the default.
  if (configFile === DEFAULT_LOCATION && env.OCI_CLI_CONFIG_FILE)
    configFile = env.OCI_CLI_CONFIG_FILE;
  const profile =
    (values.profile as string | undefined) ??
    env.OCI_CLI_PROFILE ??
    rc.settings.default_profile ??
    DEFAULT_PROFILE;
  let auth = (values.auth as string | undefined) ?? null;
  if (auth === null && env.OCI_CLI_AUTH !== undefined) {
    if (!AUTH_CHOICES.includes(env.OCI_CLI_AUTH)) {
      showPatched(
        rootUsage(),
        `Invalid value for OCI_CLI_AUTH: invalid choice: ${env.OCI_CLI_AUTH}. (choose from ${AUTH_CHOICES.join(", ")})`,
      );
    }
    auth = env.OCI_CLI_AUTH;
  }
  return { configFile, profile, auth };
}

/** cli_root.check_key_for_security: warn when the API key lacks the OCI_API_KEY label. */
function checkKeyForSecurity(s: RootSettings) {
  if (s.auth !== null && s.auth !== "api_key") return;
  let keyFile = keyFileFor(s.configFile, s.profile);
  if (process.env.OCI_CLI_KEY_FILE !== undefined)
    keyFile = process.env.OCI_CLI_KEY_FILE;
  if (
    (process.env.SUPPRESS_LABEL_WARNING ?? "").toLowerCase() === "true" ||
    !keyFile
  )
    return;
  let content: string;
  try {
    content = readFileSync(keyFile, "utf8");
  } catch {
    return; // oci crashes here (see DIVERGENCES.md)
  }
  if (content.replace(/\s+$/u, "").endsWith("OCI_API_KEY")) return;
  const message =
    `Warning: To increase security of your API key located at ${keyFile}, append an extra line with 'OCI_API_KEY' at the end. ` +
    "For more information, refer to https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm. " +
    "To suppress the warning, set the env variable SUPPRESS_LABEL_WARNING=True";
  err(`${style(message, "yellow", isTTY(2))}\n`);
}

/** cli_root.get_key_file: configparser read of the config (missing file → none). */
function keyFileFor(configFile: string, profile: string): string | null {
  const path = expandUser(configFile);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const items = sectionItems(parseConfig(text, path), profile);
    const keyFile = items?.get("key_file");
    return keyFile ? expandUser(keyFile) : null;
  } catch {
    return null;
  }
}

/** click.style for a foreground colour; click.echo strips it when not writing to a TTY. */
function style(
  text: string,
  color: "yellow" | "red",
  tty: boolean | undefined,
): string {
  if (!tty) return text;
  const code = { yellow: 33, red: 31 }[color];
  return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * CommandGroupWithAlias.get_command: an exact name wins (warning if an rc alias tried to
 * shadow it), then a command-sequence alias for this chain, then a global alias.
 */
function resolveAlias(
  rc: Rc,
  chain: string,
  name: string,
  aliasAware: boolean,
  exists: (name: string) => boolean,
): { target?: string } {
  const sequence = rc.commandSequenceAliases[chain];
  if (exists(name)) {
    if (aliasAware) {
      const shadowed = rc.globalCommandAliases[name] ?? sequence?.[name];
      if (shadowed !== undefined) {
        err(
          `${style(`Could not use '${name}' as an alias for '${shadowed}' as it belongs to an existing command under '${chain}'`, "red", isTTY(2))}\n`,
        );
      }
    }
    return { target: name };
  }
  if (!aliasAware) return {};
  for (const target of [sequence?.[name], rc.globalCommandAliases[name]]) {
    if (target !== undefined && exists(target)) return { target };
  }
  return {};
}

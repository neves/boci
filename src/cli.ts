// Click's invocation flow for the oci command tree (click.core main → Group.invoke →
// resolve_command → make_context), reproduced so boci fails, helps and dispatches exactly
// like the Reference CLI. See ADR 0003 and the usage parity cases.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  ConfigError,
  DEFAULT_LOCATION,
  DEFAULT_PROFILE,
  configPath,
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
  expandVars,
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
  type OperationSpec,
  type ServiceSpec,
  type TreeNode,
  loadIndex,
  loadService,
  serviceTree,
} from "./spec.ts";
import { REFERENCE_VERSION } from "./version.ts";
import { isImplemented } from "./registry.ts";
import { applyQuery } from "./query.ts";
import { loadExternalRegionMetadata, resolveEndpoint } from "./endpoint.ts";
import {
  InvalidPrivateKey,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "./signer.ts";

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
  if (rootValues.generate_full_command_json_input === true) {
    const sample: Record<string, unknown> = {};
    for (const p of cmd.params ?? []) {
      if (
        p.kind !== "option" ||
        p.name.startsWith("generate_") ||
        p.name === "from_json" ||
        p.name === "help"
      )
        continue;
      const name = toCamelCase(p.name);
      sample[name] = p.multiple ? ["string"] : "string";
    }
    out(`${JSON.stringify(sample, null, 2)}\n`);
    throw new Exit(0);
  }
  if (typeof rootValues.generate_param_json_input === "string") {
    const param = (cmd.params ?? []).find(
      (candidate) =>
        candidate.name.replaceAll("_", "-") ===
        rootValues.generate_param_json_input,
    );
    if (isComplexParam(param)) out("{}\n");
    else
      err(
        `Option ${rootValues.generate_param_json_input} is not a recognized complex type, so no example JSON can be produced. Invoke help for this command (--help/-h/-?) to see available documentation on this option\n`,
      );
    throw new Exit(0);
  }
  const fromJson = parsed.opts.from_json;
  const fromJsonDefaults: Record<string, unknown> = {};
  if (typeof fromJson === "string") {
    const input = parseJsonParameter("from-json", fromJson);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      err("We expect a JSON object to be provided to --from-json\n");
      throw new Exit(1);
    }
    const optToCanon: Record<string, string> = {};
    for (const p of cmd.params ?? []) {
      for (const o of p.opts) {
        if (o.startsWith("--")) optToCanon[o.slice(2)] = p.name;
        else if (o.startsWith("-")) optToCanon[o.slice(1)] = p.name;
      }
    }
    for (const [rawKey, value] of Object.entries(input)) {
      let key = rawKey;
      for (const [unit, replacement] of Object.entries(STORAGE_UNIT_MAP)) {
        if (key.endsWith(unit)) key = key.replaceAll(unit, replacement);
      }
      const underscored = underscore(key);
      fromJsonDefaults[underscored] = value;
      const canonName = optToCanon[underscored];
      if (canonName !== undefined) fromJsonDefaults[canonName] = value;
    }
  }
  const values: Record<string, unknown> = {};
  for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
    if (p.name === "from_json") continue;
    const rawVal =
      parsed.opts[p.name] !== undefined
        ? parsed.opts[p.name]
        : fromJsonDefaults[p.name];
    if (rawVal === undefined || rawVal === null) continue;
    try {
      values[p.name] = convert(p, rawVal, index.datetime);
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
  // oci_cli_rc defaults count as provided. TODO: the os/iam service fallbacks.
  const defaults = rcDefaults(rc, settings.profile);
  const missing: string[] = [];
  for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
    if (p.name === "from_json" || p.name === "help") continue;
    if (!isMissing(values[p.name] ?? parsed.opts[p.name])) continue;
    const rcVal = lookupDefault(defaults, rc, path, p);
    if (rcVal !== undefined && rcVal !== null) {
      values[p.name] = convertDefaultValue(p, rcVal, index.datetime);
      continue;
    }
    if (p.required && !p.isFlag) missing.push(p.name.replaceAll("_", "-"));
  }
  if (missing.length) {
    err(
      `${usage(commandPath, cmd.helpDoc)}\n\nError: Missing option(s) --${missing.join(", --")}.\n`,
    );
    throw new Exit(1);
  }
  for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
    if (values[p.name] !== undefined && isComplexParam(p)) {
      values[p.name] = parseJsonParameter(p.name, values[p.name]);
    }
  }

  if (key === "ns get" && name === "os") {
    await runGeneratedGet(
      values,
      rootValues,
      settings,
      spec,
      index,
      rc,
      specCmd,
    );
    return;
  }
  if (
    specCmd.kind === "generated" &&
    specCmd.operation?.http === "GET" &&
    isImplemented(`${name} ${key}`, specCmd)
  ) {
    await runGeneratedGet(
      values,
      rootValues,
      settings,
      spec,
      index,
      rc,
      specCmd,
    );
    return;
  }
  if (
    specCmd.kind === "generated" &&
    ["POST", "PUT", "PATCH"].includes(specCmd.operation?.http ?? "") &&
    isImplemented(`${name} ${key}`, specCmd)
  ) {
    await runGeneratedWrite(
      values,
      rootValues,
      settings,
      spec,
      index,
      rc,
      specCmd,
    );
    return;
  }
  await notImplemented(argv, commandPath);
}

const COMPLEX_TYPE_CLASS =
  "oci_cli.custom_types.cli_complex_type.CliComplexType";

const STORAGE_UNIT_MAP: Record<string, string> = {
  MBs: "Mbs",
  KBs: "Kbs",
  GBs: "Gbs",
};

const DEFAULT_FILE_TRUTHY = new Set(["1", "y", "t", "yes", "true", "on"]);

function toCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function underscore(word: string): string {
  return word
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function isComplexParam(param?: { typeClass?: string }): boolean {
  return param?.typeClass === COMPLEX_TYPE_CLASS;
}

function loadFileContents(path: string): string | null {
  if (path.toLowerCase().startsWith("file://")) {
    const filePath = expandVars(expandUser(path.slice("file://".length)));
    if (!existsSync(filePath)) {
      err(
        `The specified file '${path}' did not exist  (Resolved to path: '${filePath}')\n`,
      );
      throw new Exit(1);
    }
    return readFileSync(filePath, "utf8");
  }
  return null;
}

function parseJsonParameter(
  parameterName: string,
  parameterValue: unknown,
): unknown {
  if (parameterValue === undefined || parameterValue === null)
    return parameterValue;
  if (typeof parameterValue !== "string") return parameterValue;
  const jsonToParse = loadFileContents(parameterValue) ?? parameterValue;
  try {
    return JSON.parse(jsonToParse) as unknown;
  } catch {
    err(
      `Parameter ${repr(parameterName)} must be in JSON format.\nFor help with formatting JSON input see our documentation here: https://docs.cloud.oracle.com/iaas/Content/API/SDKDocs/cliusing.htm#ManagingCLIInputandOutput\n`,
    );
    throw new Exit(1);
  }
}

function convertDefaultValue(
  p: ParamSpec & { typeClass?: string; datetimeRounding?: string | null },
  value: string,
  datetime?: Index["datetime"],
): unknown {
  const expanded = expandVars(value);
  const convertSingle = (val: string): unknown => {
    switch (p.typeClass) {
      case "click.types.BoolParamType":
        return DEFAULT_FILE_TRUTHY.has(val.toLowerCase());
      case "click.types.IntParamType":
      case "click.types.IntRange":
        return Number.parseInt(val, 10);
      case "click.types.FloatParamType":
      case "click.types.FloatRange":
        return Number.parseFloat(val);
      case "oci_cli.custom_types.cli_datetime.CliDatetime":
        return convert(p as Parameters<typeof convert>[0], val, datetime);
      default:
        return val;
    }
  };
  if (p.multiple) {
    return expanded
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(convertSingle);
  }
  return convertSingle(expanded);
}

type GeneratedCommand = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

function whenMatches(
  when: string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!when) return true;
  for (const clause of when.split(" and ")) {
    const notNone = /^([a-z0-9_]+) is not None$/.exec(clause);
    if (notNone) {
      const val = values[notNone[1] as string];
      if (val === undefined || val === null) return false;
      continue;
    }
    const lenCheck = /^len\(([a-z0-9_]+)\) > 0$/.exec(clause);
    if (lenCheck) {
      const val = values[lenCheck[1] as string];
      if ((!Array.isArray(val) && typeof val !== "string") || val.length === 0)
        return false;
      continue;
    }
    const val = values[clause.trim()];
    if (val === undefined || val === null || val === false) return false;
  }
  return true;
}

function boundValueFor(
  command: GeneratedCommand,
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  arg: string,
): unknown {
  const bindings =
    command.bindings?.filter(
      (item) =>
        item.target === "kwarg" &&
        Array.isArray(item.key) &&
        item.key[0] === arg,
    ) ?? [];
  if (bindings.length === 0) return values[arg];
  let result: unknown;
  for (const item of bindings) {
    if (
      !whenMatches(
        typeof item.when === "string" ? item.when : undefined,
        values,
      )
    )
      continue;
    if (item.transform === "use_or_generate_request_id") {
      if (rootValues.request_id !== undefined) result = rootValues.request_id;
      continue;
    }
    if (typeof item.param === "string") {
      let candidate = values[item.param];
      if (candidate !== undefined) {
        if (item.transform === "parse_json_parameter") {
          candidate = parseJsonParameter(item.param, candidate);
        }
        result = candidate;
      }
    } else if (item.value !== undefined) {
      result = item.value;
    }
  }
  return result !== undefined ? result : values[arg];
}

function buildRequestBody(
  command: GeneratedCommand,
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
): string {
  const body: Record<string, unknown> = {};
  let hasBodyBindings = false;
  for (const binding of command.bindings ?? []) {
    if (binding.target !== "body" || !Array.isArray(binding.key)) continue;
    hasBodyBindings = true;
    if (
      !whenMatches(
        typeof binding.when === "string" ? binding.when : undefined,
        values,
      )
    )
      continue;
    const value =
      typeof binding.param === "string" ? values[binding.param] : binding.value;
    if (value === undefined) continue;
    let target = body;
    for (const part of binding.key.slice(0, -1) as string[]) {
      const nested = target[part];
      if (typeof nested !== "object" || nested === null) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    if (binding.transform === "parse_json_parameter") {
      target[binding.key.at(-1) as string] = parseJsonParameter(
        typeof binding.param === "string"
          ? binding.param
          : (binding.key.at(-1) as string),
        value,
      );
    } else if (
      typeof value === "string" &&
      value.toLowerCase().startsWith("file://")
    ) {
      target[binding.key.at(-1) as string] = loadFileContents(value);
    } else {
      target[binding.key.at(-1) as string] = value;
    }
  }
  if (!hasBodyBindings && typeof command.operation?.body === "string") {
    const direct = boundValueFor(
      command,
      values,
      rootValues,
      command.operation.body,
    );
    if (direct === undefined || direct === null) return "";
    if (typeof direct === "string") {
      return loadFileContents(direct) ?? direct;
    }
    return JSON.stringify(direct);
  }
  return Object.keys(body).length ? JSON.stringify(body) : "";
}

async function runGeneratedWrite(
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  settings: RootSettings,
  spec: ServiceSpec,
  index: Index,
  rc: Rc,
  command: GeneratedCommand,
): Promise<void> {
  const requestBody = buildRequestBody(command, values, rootValues);
  await runGeneratedOperation(
    values,
    rootValues,
    settings,
    spec,
    index,
    rc,
    command,
    requestBody,
  );
}

async function runGeneratedGet(
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  settings: RootSettings,
  spec: ServiceSpec,
  index: Index,
  rc: Rc,
  command: GeneratedCommand,
): Promise<void> {
  if (values.all_pages === true && values.limit !== undefined) {
    err(
      "UsageError: If you provide the --all option you cannot provide the --limit option\n",
    );
    throw new Exit(1);
  }
  await runGeneratedOperation(
    values,
    rootValues,
    settings,
    spec,
    index,
    rc,
    command,
    "",
  );
}

async function runGeneratedOperation(
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  settings: RootSettings,
  spec: ServiceSpec,
  index: Index,
  rc: Rc,
  command: GeneratedCommand,
  requestBody: string,
): Promise<void> {
  const operation = command.operation as OperationSpec;
  const boundValue = (arg: string) =>
    boundValueFor(command, values, rootValues, arg);
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
  if (
    (
      process.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING ?? ""
    ).toLowerCase() !== "true"
  ) {
    warnFilePermissions(configPath(settings.configFile));
    if (config.key_file)
      warnFilePermissions(expandUser(String(config.key_file)));
  }
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const endpointOpt = (rootValues.endpoint ?? config.endpoint) as
    string | undefined;
  const region = (rootValues.region ??
    process.env.OCI_CLI_REGION ??
    config.region) as string | undefined;
  const regionMetadata =
    region && !endpointOpt
      ? await loadExternalRegionMetadata(region, index.regions)
      : undefined;
  const serviceParams: Record<string, string> = {};
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const value = boundValue(arg);
    if (value !== undefined) serviceParams[name] = String(value);
  }
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) serviceParams[name] = String(value);
  }
  const { resolved } = resolveEndpoint(client, index.regions, {
    region,
    endpoint: endpointOpt,
    regionMetadata,
    serviceParams,
    realmSpecific: configBool(
      rootValues.realm_specific_endpoint ??
        values.realm_specific_endpoint ??
        config.realm_specific_service_endpoint_template_enabled,
    ),
    dualStack: configBool(
      rootValues.enable_dual_stack ??
        values.enable_dual_stack ??
        config.dual_stack_endpoint_enabled,
    ),
  });
  let path = operation.path;
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const value = boundValue(arg);
    if (value !== undefined)
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(`${resolved}${path}`);
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const allPages = values.all_pages === true;
  const limit = values.limit;
  const pageSize = values.page_size;
  if ((allPages || limit !== undefined) && pageSize !== undefined)
    url.searchParams.set("limit", String(pageSize));
  const baseUrl = new URL(url);
  const headers: Record<string, string> =
    operation.http === "GET" ? {} : { "content-type": "application/json" };
  if (operation.http !== "GET" && operation.client.startsWith("log_analytics."))
    headers.expect = "100-continue";
  for (const [name, param] of Object.entries(operation.headerParams ?? {})) {
    const value =
      param.value ?? (param.arg ? boundValue(param.arg) : undefined);
    if (value !== undefined) headers[name] = String(value);
  }
  if (
    operation.headerParams?.["opc-retry-token"] &&
    headers["opc-retry-token"] === undefined
  )
    headers["opc-retry-token"] = randomBytes(22).toString("base64url");
  if (rootValues.no_retry !== true) headers["opc-client-retries"] = "true";
  if (rootValues.request_id !== undefined) {
    const requestIdHeader =
      operation.headerParams?.["opc-request-id"] !== undefined
        ? "opc-request-id"
        : "opc-client-request-id";
    headers[requestIdHeader] = String(rootValues.request_id);
  }
  const keyPath = expandUser(String(config.key_file));
  const pem = readFileSync(keyPath, "utf8");
  const keyId = `${config.tenancy}/${config.user}/${config.fingerprint}`;
  const req = {
    method: operation.http,
    url: url.toString(),
    headers,
    body: requestBody,
  };
  prepareContentLength(req);
  let privateKey;
  try {
    privateKey = loadPrivateKey(pem, config.pass_phrase as string | null);
  } catch (e) {
    if (e instanceof InvalidPrivateKey) {
      err(`${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }
  const connectionTimeout = timeoutSecondsFor(
    rootValues.connection_timeout ?? config.connection_timeout,
  );
  const readTimeout = timeoutSecondsFor(
    rootValues.read_timeout ?? config.read_timeout,
  );
  const hasNoneRetry =
    command.bindings?.some((b) => b.transform === "NoneRetryStrategy") === true;
  const maxAttempts =
    rootValues.no_retry === true || hasNoneRetry
      ? 1
      : Math.max(1, Number(rootValues.max_retries) || 8);
  let response: Response;
  let raw: string;
  const pageItems: unknown[] = [];
  let nextPage: string | null = null;
  let page = url.searchParams.get("page");
  do {
    const pageUrl = new URL(baseUrl);
    if (page !== null) pageUrl.searchParams.set("page", page);
    else pageUrl.searchParams.delete("page");
    req.url = pageUrl.toString();
    for (let attempt = 1; ; attempt++) {
      delete req.headers.date;
      delete req.headers.authorization;
      signRequest(req, { keyId, privateKey });
      const controller = new AbortController();
      const connectionTimer =
        connectionTimeout === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new DOMException("Connection timed out", "TimeoutError"),
                ),
              connectionTimeout * 1000,
            );
      const readTimer =
        readTimeout === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new DOMException("Response read timed out", "TimeoutError"),
                ),
              readTimeout * 1000,
            );
      try {
        response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body ? { body: req.body } : {}),
          ...(connectionTimer === undefined && readTimer === undefined
            ? {}
            : { signal: controller.signal }),
        });
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        raw = await response.text();
      } catch (e) {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        if (readTimer !== undefined) clearTimeout(readTimer);
        if (attempt >= maxAttempts) throw e;
        const delay = Math.min(
          1000 * 2 ** (attempt - 1) + Math.random() * 1000,
          30000,
        );
        await Bun.sleep(delay);
        continue;
      } finally {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        if (readTimer !== undefined) clearTimeout(readTimer);
      }
      if (attempt >= maxAttempts || !retryableResponse(response, raw)) break;
      const delay = Math.min(
        1000 * 2 ** (attempt - 1) + Math.random() * 1000,
        30000,
      );
      await Bun.sleep(delay);
    }
    if (rootValues.debug === true) {
      err(`DEBUG:oci.base_client: Request: ${req.method} ${req.url}\n`);
      err(`DEBUG:oci.base_client: Response status: ${response.status}\n`);
    }
    nextPage = response.headers.get("opc-next-page");
    if (
      allPages &&
      response.ok &&
      operation.responseType?.startsWith("list[")
    ) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "items" in parsed &&
          Array.isArray(parsed.items)
        )
          pageItems.push(...parsed.items);
      } catch {
        // Keep ordinary response handling for a malformed list body.
      }
    }
    page = nextPage;
    if (!allPages || !operation.responseType?.startsWith("list[")) break;
  } while (page !== null);
  if (!response.ok) {
    err(formatServiceError(operation, url, response, raw));
    throw new Exit(1);
  }
  renderGeneratedResponse(
    operation,
    response,
    raw,
    pageItems,
    allPages,
    rootValues,
    rc,
  );
}

function formatServiceError(
  operation: OperationSpec,
  url: URL | string,
  response: Response,
  raw: string,
): string {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      details = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies still produce the standard ServiceError envelope.
  }
  const timestamp = new Date().toISOString().replace(/Z$/, "000+00:00");
  const serviceError = {
    ...details,
    client_version: "Oracle-PythonSDK/2.192.0, Oracle-PythonCLI/3.96.3",
    logging_tips:
      "Please run the OCI CLI command using --debug flag to find more debug information.",
    "opc-request-id": response.headers.get("opc-request-id") ?? "",
    operation_name: operation.method,
    request_endpoint: `${operation.http} ${url.toString()}`,
    status: response.status,
    timestamp,
    troubleshooting_tips:
      "See [https://docs.oracle.com/iaas/Content/API/References/apierrors.htm] for more information about resolving this error. If you are unable to resolve this issue, run this CLI command with --debug option and contact Oracle support and provide them the full error message.",
  };
  return `ServiceError:\n${JSON.stringify(sortJson(serviceError), null, 4)}\n`;
}

function renderGeneratedResponse(
  operation: OperationSpec,
  response: Response,
  raw: string,
  pageItems: unknown[],
  allPages: boolean,
  rootValues: Record<string, unknown>,
  rc: Rc,
): void {
  const hasBody = raw.trim().length > 0;
  let value: unknown;
  if (hasBody) {
    try {
      const parsed: unknown = JSON.parse(raw);
      value =
        typeof parsed === "string"
          ? parsed
          : operation.method === "get_namespace"
            ? raw
            : mapResponseKeys(
                allPages && operation.responseType?.startsWith("list[")
                  ? pageItems
                  : operation.responseType?.startsWith("list[") &&
                      parsed &&
                      typeof parsed === "object" &&
                      "items" in parsed &&
                      Array.isArray(parsed.items)
                    ? parsed.items
                    : parsed,
              );
    } catch {
      value = raw;
    }
  }
  const output: Record<string, unknown> = {};
  if (hasBody) output.data = value;
  const etag = response.headers.get("etag");
  const hasNextPage = response.headers.get("opc-next-page");
  if (etag !== null) output.etag = etag;
  if (hasNextPage !== null && !allPages) {
    output["opc-next-page"] = hasNextPage;
    err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
  if (Object.keys(output).length === 0) return;
  let query = rootValues.query;
  if (typeof query === "string" && query.startsWith("query://")) {
    const queryName = query.slice("query://".length);
    query = rc.cannedQueries[queryName];
    if (query === undefined) {
      err(
        `UsageError: Query ${queryName} is not defined in your OCI CLI configuration file: ${rc.path}\n`,
      );
      throw new Exit(1);
    }
  }
  const rendered =
    typeof query === "string" ? applyQuery(output, query) : output;
  if (rendered === null || (Array.isArray(rendered) && rendered.length === 0)) {
    err("Query returned empty result, no output to show.\n");
  } else {
    const format = rootValues.output ?? "json";
    const tableValue =
      rendered &&
      typeof rendered === "object" &&
      !Array.isArray(rendered) &&
      "data" in rendered
        ? (rendered as Record<string, unknown>).data
        : rendered;
    if (format === "table") out(renderTable(tableValue));
    else if (rootValues.raw_output && typeof rendered === "string")
      out(`${rendered}\n`);
    else out(`${JSON.stringify(sortJson(rendered), null, 2)}\n`);
  }
}

function timeoutSecondsFor(value: unknown): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  return undefined;
}

function retryableResponse(response: Response, raw: string): boolean {
  if (response.status === 429) return true;
  if (response.status >= 500 && response.status !== 501) return true;
  if (response.status !== 409) return false;
  try {
    const body: unknown = JSON.parse(raw);
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      (body.code === "IncorrectState" || body.code === "LockConflict")
    );
  } catch {
    return false;
  }
}

function warnFilePermissions(file: string) {
  try {
    if ((statSync(file).mode & 0o077) === 0) return;
  } catch {
    return;
  }
  err(
    `WARNING: Permissions on ${file} are too open. \n` +
      "To fix this please try executing the following command: \n" +
      `oci setup repair-file-permissions --file ${file} \n` +
      "Alternatively to hide this warning, you may set the environment variable, OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: \n" +
      "export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True\n\n",
  );
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

function mapResponseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapResponseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        mapResponseKeys(item),
      ]),
    );
  return value;
}

function renderTable(value: unknown): string {
  const rows: unknown[][] = Array.isArray(value)
    ? value.map((item) => (Array.isArray(item) ? item : [item]))
    : [Array.isArray(value) ? value : [value]];
  let headers: string[];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value[0] &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0])
  ) {
    headers = Object.keys(value[0] as Record<string, unknown>);
    for (let i = 0; i < rows.length; i++)
      rows[i] = headers.map(
        (key) => (value[i] as Record<string, unknown>)[key],
      );
  } else {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    headers = Array.from({ length: width }, (_, i) => `Column${i + 1}`);
  }
  const cell = (v: unknown) =>
    v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cell(row[i]).length)),
  );
  const border = `+${widths.map((w) => `-${"-".repeat(w)}-`).join("+")}+`;
  const line = (values: string[]) =>
    `| ${values.map((v, i) => v.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return `${border}\n${line(headers)}\n${border}\n${rows.map((row) => line(headers.map((_, i) => cell(row[i])))).join("\n")}${rows.length ? "\n" : ""}${border}\n`;
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

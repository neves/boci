// Click's invocation flow for the oci command tree (click.core main → Group.invoke →
// resolve_command → make_context), reproduced so boci fails, helps and dispatches exactly
// like the Reference CLI. See ADR 0003 and the usage parity cases.
import { closeSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkFileAccessibility } from "../lib/accessibility.ts";
import {
  DEFAULT_LOCATION,
  DEFAULT_PROFILE,
  expandUser,
  fromFile,
} from "./config.ts";
import { parseConfig, sectionItems } from "../lib/configparser.ts";
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
  TimestampRangeError,
  pyRepr,
  convert,
  errorHint,
  processingOrder,
} from "./convert.ts";
import { getCloseMatches } from "../lib/difflib.ts";
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
import { CUSTOM_HANDLERS, isImplemented } from "./registry.ts";
import {
  type OutputFileHandle,
  openClickFileForWrite,
  openClickFileForProgram,
  validateClickFileForRead,
  validateOsNamespace,
} from "./click-file.ts";
import { Exit, type Env, type Invocation } from "../lib/io.ts";
import { parseJsonParameter, repr } from "./json-input.ts";
import { waitForState, waitUntilResponse } from "./waiter.ts";
import { paginateSdkList } from "./pagination.ts";
import {
  ProgramFile,
  type ProgramFiles,
  ProgramAbort,
  ProgramConfirm,
  ProgramEcho,
  ProgramExit,
  ProgramHeaders,
  ProgramListCall,
  ProgramSecret,
  ProgramSleep,
  type ProgramAnswer,
  ProgramLookup,
  ProgramRaise,
  ProgramRender,
  ProgramRenderData,
  ProgramResponse,
  ProgramSdkCall,
  ProgramServiceError,
  type ProgramSdkOutcome,
  ProgramUnsupported,
  type ProgramContext,
  ProgramUsageError,
  ProgramWaitUntil,
  runProgram,
} from "./program.ts";
import {
  type GeneratedCommand,
  type OperationResult,
  usageCheckFailure,
  tierBCheckFailure,
  callOperation,
  callSdkOperation,
  confirmUnderWrapExceptions,
  keyTypes,
  outputBinding,
  parseSdkResponseData,
} from "./operation.ts";
import { printResult, renderCliData, type OutputOptions } from "./output.ts";
import {
  type StdinReader,
  createStdinReader,
  promptHiddenConfirmed,
} from "./stdin.ts";
import { writeDownload } from "./download.ts";

/** Click's prog name. boci answers as `oci` so usage text matches what scripts expect. */
const PROG = "oci";
const INTERACTIVE_SUGGESTION =
  "For OCI CLI commands and parameters suggestion, auto completion and other useful features, try the Interactive mode by typing `oci -i`.";

function usage(io: Invocation, commandPath: string, doc: HelpDoc): string {
  const f = new HelpFormatter(helpWidth(io));
  f.writeUsage(commandPath, doc.usage);
  return f.getvalue().replace(/\n+$/, "");
}

/** Click's stock UsageError.show (before the root callback patches it): stderr.
 * `usageText` is null when Click raised the error without a context. */
function showStock(
  io: Invocation,
  usageText: string | null,
  message: string,
): never {
  if (usageText !== null) io.err(`${usageText}\n\n`);
  io.err(`Error: ${message}\n`);
  throw new Exit(2);
}

/** cli_util.update_click_help_message, installed by the root callback: stdout. */
function showPatched(
  io: Invocation,
  usageText: string | null,
  message: string,
): never {
  if (usageText !== null) io.out(`${usageText}\n\n`);
  io.out(`Error: ${message}\n\n`);
  io.out(`${INTERACTIVE_SUGGESTION}\n`);
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

/** One invocation: its exit code. Output goes to the invocation's sinks; nothing exits. */
export async function run(io: Invocation): Promise<number> {
  try {
    await main(io);
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    if (e instanceof TimestampRangeError) {
      io.err(e.message + "\n");
      return 1;
    }
    throw e;
  }
}

async function main(io: Invocation): Promise<void> {
  const argv = io.argv;
  const index = await loadIndex();
  const rootUsage = () => usage(io, PROG, index.rootHelpDoc);

  // 1. Root context: interspersed, unknown options ignored, so root options are taken
  //    from anywhere on the command line (that's why `oci os ns get --help` works).
  let root: ReturnType<OptionParser["parse"]>;
  try {
    root = new OptionParser(index.globalParams, index.rootHelpDoc.parse).parse(
      argv,
    );
  } catch (e) {
    if (e instanceof UsageError)
      showStock(io, usageFor(e, rootUsage), e.message);
    throw e;
  }
  // Root params in Click's processing order: eager first (--version exits here), then type
  // conversion. Errors still use the stock display: the root callback hasn't run yet.
  // TODO(rung 0): --release-info, --latest-version, --cli-rc-file, --generate-*-json-input.
  const rootValues: Record<string, unknown> = {};
  for (const p of processingOrder(root.order, index.globalParams)) {
    if (p.name === "version" && root.opts.version !== undefined) {
      io.out(`${REFERENCE_VERSION}\n`);
      throw new Exit(0);
    }
    if (root.opts[p.name] === undefined) continue;
    try {
      rootValues[p.name] = convert(p, root.opts[p.name], index.datetime);
    } catch (e) {
      if (e instanceof BadParameter)
        showStock(
          io,
          rootUsage(),
          `Invalid value for ${errorHint(p)}: ${e.message}`,
        );
      throw e;
    }
  }
  // --cli-rc-file is eager with a default, so its callback (rc loading) always runs.
  const rc = loadRc(
    (rootValues.cli_rc_file as string | undefined) ?? RC_DEFAULT_LOCATION,
    io.env,
    io.cwd,
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
    for (const m of messages) io.err(`${style(m, "red", io.isTTY(2))}\n`);
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
        io.err(`${style(collisions.join("\n"), "red", io.isTTY(2))}\n`);
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
    await printRootHelp(io, index, rootHelpDoc);
    throw new Exit(0);
  }

  // boci-only Extension commands (ADR 0005): handled before OCI config/key checks.
  if (rest[0] === "update") {
    const { runUpdate } = await import("../commands/update.ts");
    await runUpdate(io, rest.slice(1), root.opts.help === true);
  }

  // 3. Resolve the service. Only the core commands and the first service named anywhere
  //    in argv are registered (dynamic_loader.load_service_from_command).
  const typedName = rest[0] as string;
  const rootAlias = resolveAlias(io, rc, "oci", typedName, true, (n) => {
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
          showStock(io, usageFor(e, rootUsage), e.message);
        throw e;
      }
    }
    showStock(
      io,
      rootUsage(),
      noSuchCommand(typedName, rootCommandOrder(index, loaded)),
    );
  }
  const name = rootAlias.target;

  // 4. Root callback runs: UsageError.show is now patched to stdout.
  if (has(root.opts, "max_retries") && root.opts.no_retry === true) {
    showPatched(
      io,
      rootUsage(),
      "The option --max-retries is not applicable when using the --no-retry flag.",
    );
  }
  const settings = resolveRootSettings(io, rootValues, rc, rootUsage);
  if (typedName !== "profile") checkKeyForSecurity(io, settings); // invoked_subcommand is the typed name
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
      io.err(
        `${groupHelp(commandPath, group.helpDoc, children(spec, node, canon.slice(1)), helpWidth(io))}\n`,
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
          io,
          usageFor(e, () => usage(io, commandPath, group.helpDoc)),
          e.message,
        );
      throw e;
    }
    if (parsed.args.length === 0)
      showPatched(
        io,
        usage(io, commandPath, group.helpDoc),
        "Missing command.",
      );
    const childName = parsed.args[0] as string;
    const commands = node.commands;
    const resolved = resolveAlias(
      io,
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
              io,
              usageFor(e, () => usage(io, commandPath, group.helpDoc)),
              e.message,
            );
          throw e;
        }
      }
      showPatched(
        io,
        usage(io, commandPath, group.helpDoc),
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
        io,
        usageFor(e, () => usage(io, commandPath, cmd.helpDoc)),
        e.message,
      );
    throw e;
  }
  if (helpRequested) {
    // cli_util.help_callback: eager, prints when the root saw a help flag.
    io.out(`${commandHelp(commandPath, cmd.helpDoc, helpWidth(io))}\n`);
    throw new Exit(0);
  }
  const generateFull = rootValues.generate_full_command_json_input === true;
  const generateParam = rootValues.generate_param_json_input;
  if (generateFull && typeof generateParam === "string") {
    io.err(
      "UsageError: Cannot specify both the --generate-full-command-json-input and --generate-param-json-input parameters\n",
    );
    throw new Exit(1);
  }
  if (generateFull) {
    io.out(
      `${renderJsonExample(cmd.jsonExamples?.full ?? {}, spec.jsonExamplePool)}\n`,
    );
    throw new Exit(0);
  }
  if (typeof generateParam === "string") {
    const example = cmd.jsonExamples?.params[generateParam];
    if (example !== undefined)
      io.out(
        `${renderJsonExample({ __bociJsonRef: example }, spec.jsonExamplePool)}\n`,
      );
    else
      io.err(
        `Option ${generateParam} is not a recognized complex type, so no example JSON can be produced. Invoke help for this command (--help/-h/-?) to see available documentation on this option\n`,
      );
    throw new Exit(0);
  }
  const fromJson = parsed.opts.from_json;
  const fromJsonDefaults: Record<string, unknown> = {};
  if (typeof fromJson === "string") {
    // Its keys camelize by the command's complex types, matched by key name.
    const input = parseJsonParameter(io, "from-json", fromJson, {
      complexTypes: specCmd.complexTypes,
      models: spec.models,
    });
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      io.err("We expect a JSON object to be provided to --from-json\n");
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
  let osObjectGetOutputFile: OutputFileHandle | undefined;
  try {
    for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
      if (p.name === "from_json") continue;
      const rawVal =
        parsed.opts[p.name] !== undefined
          ? parsed.opts[p.name]
          : fromJsonDefaults[p.name];
      if (rawVal === undefined || rawVal === null) continue;
      try {
        values[p.name] = convert(p, rawVal, index.datetime);
        if (
          specCmd.program &&
          p.typeClass === "click.types.File" &&
          typeof values[p.name] === "string"
        ) {
          values[p.name] = await openClickFileForProgram(
            io,
            values[p.name] as string,
            (p as { fileMode?: string }).fileMode ?? "r",
          );
        }
        if (
          name === "os" &&
          (p.name === "namespace" || p.name === "namespace_name")
        ) {
          validateOsNamespace(values[p.name]);
        }
        if (name === "os" && key === "object get") {
          if (p.name === "file" && typeof values[p.name] === "string") {
            osObjectGetOutputFile = openClickFileForWrite(
              io,
              values[p.name] as string,
            );
          } else if (
            p.name === "encryption_key_file" &&
            typeof values[p.name] === "string"
          ) {
            validateClickFileForRead(io, values[p.name] as string);
          }
        } else if (name === "os" && key === "object put") {
          if (
            (p.name === "file" || p.name === "encryption_key_file") &&
            typeof values[p.name] === "string"
          ) {
            validateClickFileForRead(io, values[p.name] as string);
          }
        } else if (name === "os" && key === "object resume-put") {
          if (p.name === "file" && typeof values[p.name] === "string") {
            validateClickFileForRead(io, values[p.name] as string);
          }
        } else if (
          name === "os" &&
          (key === "object bulk-upload" ||
            key === "object bulk-download" ||
            key === "object sync")
        ) {
          if (
            p.name === "encryption_key_file" &&
            typeof values[p.name] === "string"
          ) {
            validateClickFileForRead(io, values[p.name] as string);
          }
        } else if (name === "setup" && key === "keys") {
          if (
            p.name === "passphrase_file" &&
            typeof values[p.name] === "string"
          ) {
            validateClickFileForRead(io, values[p.name] as string);
          }
        }
      } catch (e) {
        if (e instanceof BadParameter)
          showPatched(
            io,
            usage(io, commandPath, cmd.helpDoc),
            `Invalid value for ${errorHint(p)}: ${e.message}`,
          );
        throw e;
      }
    }
    if (parsed.args.length && !cmd.helpDoc.parse.allowExtra) {
      const n = parsed.args.length;
      showPatched(
        io,
        usage(io, commandPath, cmd.helpDoc),
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
      if (p.isFlag && p.default !== null && p.default !== undefined) continue;
      if (!isMissing(values[p.name] ?? parsed.opts[p.name])) continue;
      const rcVal = lookupDefault(defaults, rc, path, p);
      if (rcVal !== undefined && rcVal !== null) {
        values[p.name] = convertDefaultValue(io.env, p, rcVal, index.datetime);
        continue;
      }
      if (p.required && !p.isFlag) missing.push(p.name.replaceAll("_", "-"));
    }
    if (missing.length) {
      io.err(
        `${usage(io, commandPath, cmd.helpDoc)}\n\nError: Missing option(s) --${missing.join(", --")}.\n`,
      );
      throw new Exit(1);
    }
    const customHandler = CUSTOM_HANDLERS.get(canon.join(" "));
    const http = specCmd.operation?.http ?? "";
    const engineRoute =
      (key === "ns get" && name === "os") ||
      (isImplemented(`${name} ${key}`, specCmd) &&
        (["GET", "HEAD", "DELETE", "POST", "PUT", "PATCH"].includes(http) ||
          Boolean(specCmd.program && specCmd.sdkOperations?.length)));
    if (!customHandler) {
      // A Tier A wrapper's own checks run before it delegates; the generated callback
      // then checks its path params first thing (both before JSON parsing). A Tier B
      // wrapper's compiled checks run too, though its happy path may not be implemented.
      // Object Storage looks the namespace up (a request) before any callback runs.
      const namespaceFirst =
        name === "os" &&
        (specCmd.params ?? []).some(
          (p) =>
            (p.name === "namespace" || p.name === "namespace_name") &&
            values[p.name] === undefined,
        );
      // A programmed wrapper the Engine runs raises its own checks as it runs (below).
      const failure =
        specCmd.program && engineRoute
          ? undefined
          : engineRoute
            ? usageCheckFailure(specCmd, values)
            : namespaceFirst
              ? undefined
              : tierBCheckFailure(specCmd, values);
      if (failure?.wrapped === false)
        showPatched(io, usage(io, commandPath, cmd.helpDoc), failure.message);
      if (failure) {
        io.err(`UsageError: ${failure.message}\n`);
        throw new Exit(1);
      }
    }
    // A programmed wrapper sees complex options as the strings Click gives it (an
    // empty "{}" is truthy); it and the generated command parse them where oci does.
    const parseFirst = !(engineRoute && specCmd.program);
    // The command oci runs (a Tier A wrapper's delegate) camelizes keys by its types.
    const keys = customHandler ? undefined : keyTypes(specCmd, spec.models);
    const renames = specCmd.delegate?.renames ?? {};
    for (const p of processingOrder(parsed.order, cmd.params ?? [])) {
      if (parseFirst && values[p.name] !== undefined && isComplexParam(p)) {
        const parsedAs =
          Object.entries(renames).find(
            ([, custom]) => custom === p.name,
          )?.[0] ?? p.name;
        values[p.name] = parseJsonParameter(io, parsedAs, values[p.name], keys);
      }
    }

    if (customHandler) {
      await customHandler({
        io,
        values,
        rootValues,
        settings,
        rc,
        index,
        spec,
        usageText: () => usage(io, commandPath, cmd.helpDoc),
        usageError: (message) =>
          showPatched(io, usage(io, commandPath, cmd.helpDoc), message),
        outputFile: osObjectGetOutputFile,
      });
      return;
    }

    if (engineRoute) {
      let command: GeneratedCommand = specCmd;
      let callValues = values;
      const output: OutputOptions = {
        query: rootValues.query,
        output: rootValues.output,
        rawOutput: rootValues.raw_output,
        rc,
      };
      if (specCmd.program) {
        const stdin = createStdinReader(io);
        const wrapperRootValues: Record<string, unknown> = { ...rootValues };
        const wrapperSettings: RootSettings = { ...settings };
        const wrapperOutput: OutputOptions = { ...output };
        const loadContextDefaults = (): Record<string, unknown> => {
          const stringKeys: [string, string][] = [
            ["region", "region"],
            ["endpoint", "endpoint"],
            ["cert_bundle", "cert-bundle"],
            ["output", "output"],
            ["query", "query"],
            ["generate_param_json_input", "generate-param-json-input"],
            ["auth", "auth"],
          ];
          const boolKeys: [string, string][] = [
            ["debug", "debug"],
            ["raw_output", "raw_output"],
            [
              "generate_full_command_json_input",
              "generate-full-command-json-input",
            ],
            ["no_retry", "no_retry"],
            ["realm_specific_endpoint", "realm-specific-endpoint"],
            ["enable_dual_stack", "enable-dual-stack"],
          ];
          const lookupGlobal = (paramName: string) => {
            const names = [paramName];
            for (const alias of rc.parameterAliases[`--${paramName}`] ?? []) {
              names.push(
                alias.startsWith("--") ? alias.slice(2) : alias.slice(1),
              );
            }
            const leafParam = (cmd.params ?? []).find((p) =>
              p.opts.includes(`--${paramName}`),
            );
            if (leafParam) {
              for (const o of leafParam.opts) {
                const n = o.startsWith("--") ? o.slice(2) : o.slice(1);
                if (!names.includes(n)) names.push(n);
              }
            }
            const hierarchy = path
              .map((_, i) => path.slice(0, path.length - i).join("."))
              .concat([""]);
            for (const prefix of hierarchy) {
              for (const n of names) {
                const k = prefix ? `${prefix}.${n}` : n;
                if (defaults.has(k)) return defaults.get(k);
              }
            }
            return undefined;
          };
          for (const [key, paramName] of stringKeys) {
            if (
              wrapperRootValues[key] === undefined ||
              wrapperRootValues[key] === null
            ) {
              const rcVal = lookupGlobal(paramName);
              if (rcVal !== undefined && rcVal !== null) {
                wrapperRootValues[key] = rcVal;
              }
            }
          }
          if (
            wrapperRootValues.output === undefined ||
            wrapperRootValues.output === null
          )
            wrapperRootValues.output = "json";
          if (
            wrapperRootValues.auth === undefined ||
            wrapperRootValues.auth === null
          )
            wrapperRootValues.auth = wrapperSettings.auth ?? "api_key";
          else if (
            wrapperSettings.auth === null &&
            typeof wrapperRootValues.auth === "string"
          )
            wrapperSettings.auth = wrapperRootValues.auth;
          for (const [key, paramName] of boolKeys) {
            if (!wrapperRootValues[key]) {
              const rcVal = lookupGlobal(paramName);
              if (rcVal !== undefined && rcVal !== null) {
                const globalParam = index.globalParams.find(
                  (p) => p.name === key,
                );
                wrapperRootValues[key] = convertDefaultValue(
                  io.env,
                  globalParam ?? {
                    kind: "option",
                    name: key,
                    opts: [`--${paramName}`],
                    secondaryOpts: [],
                    multiple: false,
                    count: false,
                    nargs: 1,
                    isFlag: true,
                    typeClass: "click.types.BoolParamType",
                  },
                  rcVal,
                  index.datetime,
                );
              }
            }
          }
          wrapperOutput.output = wrapperRootValues.output;
          wrapperOutput.query = wrapperRootValues.query;
          wrapperOutput.rawOutput = wrapperRootValues.raw_output;
          return {
            region: wrapperRootValues.region ?? null,
            endpoint: wrapperRootValues.endpoint ?? null,
            cert_bundle: wrapperRootValues.cert_bundle ?? null,
            output: wrapperRootValues.output,
            query: wrapperRootValues.query ?? null,
            generate_param_json_input:
              wrapperRootValues.generate_param_json_input ?? null,
            auth: wrapperRootValues.auth,
            debug: Boolean(wrapperRootValues.debug),
            raw_output: Boolean(wrapperRootValues.raw_output),
            generate_full_command_json_input: Boolean(
              wrapperRootValues.generate_full_command_json_input,
            ),
            no_retry: Boolean(wrapperRootValues.no_retry),
            realm_specific_endpoint: Boolean(
              wrapperRootValues.realm_specific_endpoint,
            ),
            enable_dual_stack: Boolean(wrapperRootValues.enable_dual_stack),
          };
        };
        // @cli_util.confirm_delete_option prompts inside wrap_exceptions before the callback runs.
        if (
          specCmd.program.wrapExceptions &&
          !specCmd.generated &&
          (specCmd.params ?? []).some(
            (p) => p.callback === "oci_cli.cli_util.confirmation_callback",
          ) &&
          values.force !== true
        ) {
          const confirmed = await confirmUnderWrapExceptions(
            io,
            "Are you sure you want to delete this resource?",
            false,
            stdin,
          );
          if (!confirmed) {
            io.err("Abort: \n");
            throw new Exit(1);
          }
        }
        const generated = await runWrapper(
          io,
          specCmd,
          values,
          () => usage(io, commandPath, cmd.helpDoc),
          spec.models,
          {
            region: () => {
              try {
                const region =
                  wrapperRootValues.region ??
                  io.env.OCI_CLI_REGION ??
                  fromFile(
                    wrapperSettings.configFile,
                    wrapperSettings.profile,
                    io.env,
                    io.cwd,
                  ).region;
                return typeof region === "string" ? region : undefined;
              } catch {
                return undefined; // no config: not modeled
              }
            },
            tenancy: () => {
              if (typeof io.env.OCI_CLI_TENANCY === "string") {
                return io.env.OCI_CLI_TENANCY;
              }
              try {
                const cfg = fromFile(
                  wrapperSettings.configFile,
                  wrapperSettings.profile,
                  io.env,
                  io.cwd,
                );
                return typeof cfg.tenancy === "string" ? cfg.tenancy : null;
              } catch {
                return null;
              }
            },
            namespace: async () => {
              // client.get_namespace(): `os ns get`, its ServiceError and all.
              const nsCall = {
                command: spec.commands["ns get"] as GeneratedCommand,
                values: {},
                rootValues: wrapperRootValues,
                settings: wrapperSettings,
                spec,
                index,
              };
              const result = await callOperation(io, nsCall);
              if (!result.response.ok) printResult(io, result, { rc });
              return String(JSON.parse(result.raw));
            },
            sdkCall: async (opIndex, posArgs, kwArgs, region) => {
              const op = specCmd.sdkOperations?.[opIndex];
              if (!op) throw new ProgramUnsupported(`sdk[${opIndex}]`);
              const callRootValues =
                region !== undefined
                  ? { ...wrapperRootValues, region }
                  : wrapperRootValues;
              const result = await callSdkOperation(io, {
                operation: op,
                posArgs,
                kwArgs,
                rootValues: callRootValues,
                settings: wrapperSettings,
                spec,
                index,
              });
              if (!result.response.ok) return new ProgramServiceError(result);
              return new ProgramResponse(result, parseSdkResponseData(result), {
                opIndex,
                posArgs,
                kwArgs,
                region,
              });
            },
            listCall: async (call) => {
              const op = specCmd.sdkOperations?.[call.opIndex];
              if (!op) throw new ProgramUnsupported(`sdk[${call.opIndex}]`);
              const callRootValues =
                call.region !== undefined
                  ? { ...wrapperRootValues, region: call.region }
                  : wrapperRootValues;
              return paginateSdkList({
                mode: call.mode,
                multipleKeys: call.multipleKeys,
                recordLimit: call.recordLimit,
                pageSize: call.pageSize,
                kwArgs: call.kwArgs,
                fetchPage: async (pageKwArgs) => {
                  const result = await callSdkOperation(io, {
                    operation: op,
                    posArgs: [],
                    kwArgs: pageKwArgs,
                    rootValues: callRootValues,
                    settings: wrapperSettings,
                    spec,
                    index,
                  });
                  if (!result.response.ok)
                    return new ProgramServiceError(result);
                  return new ProgramResponse(
                    result,
                    parseSdkResponseData(result),
                    {
                      opIndex: call.opIndex,
                      posArgs: [],
                      kwArgs: pageKwArgs,
                      region: call.region,
                    },
                  );
                },
              });
            },
            waitUntil: async (wait) => {
              const call = wait.response.call;
              if (!call)
                throw new ProgramUnsupported("wait_until without sdk call");
              const op = specCmd.sdkOperations?.[call.opIndex];
              if (!op) throw new ProgramUnsupported(`sdk[${call.opIndex}]`);
              const callRootValues =
                call.region !== undefined
                  ? { ...wrapperRootValues, region: call.region }
                  : wrapperRootValues;
              const outcome = await waitUntilResponse({
                initial: wait.response.result,
                property: wait.property,
                states: wait.states,
                maxWaitSeconds: wait.maxWaitSeconds,
                maxIntervalSeconds: wait.maxIntervalSeconds,
                succeedOnNotFound: wait.succeedOnNotFound,
                poll: () =>
                  callSdkOperation(io, {
                    operation: op,
                    posArgs: call.posArgs,
                    kwArgs: call.kwArgs,
                    rootValues: callRootValues,
                    settings: wrapperSettings,
                    spec,
                    index,
                  }),
              });
              switch (outcome.kind) {
                case "response":
                  return new ProgramResponse(
                    outcome.result,
                    parseSdkResponseData(outcome.result),
                    call,
                  );
                case "timeout":
                  return new ProgramRaise(
                    "MaximumWaitTimeExceeded",
                    "Maximum wait time has been exceeded.",
                  );
                case "negative-interval":
                  return new ProgramRaise(
                    "ValueError",
                    "sleep length must be non-negative",
                  );
                case "error":
                  return new ProgramServiceError(outcome.result);
              }
            },
            render: (response) => {
              printResult(io, response.result, wrapperOutput);
            },
            renderData: (r) => {
              const hasAllPagesParam = (specCmd.params ?? []).some(
                (p) => p.name === "all_pages",
              );
              const headerEntries =
                r.headers instanceof ProgramHeaders
                  ? r.headers.entries()
                  : r.headers
                    ? Object.entries(r.headers)
                    : null;
              renderCliData(io, r.data, headerEntries, wrapperOutput, {
                displayAllHeaders: r.displayAllHeaders,
                nestDataInDataAttribute: r.nestDataInDataAttribute,
                hasAllPagesParam,
              });
            },
            serviceError: (result) => {
              printResult(io, result, wrapperOutput);
            },
            sleep: (seconds) => Bun.sleep(seconds * 1000),
          },
          [],
          {
            region: undefined,
            env: io.env,
            loadContextDefaults,
            requestId:
              typeof wrapperRootValues.request_id === "string"
                ? wrapperRootValues.request_id
                : null,
          },
          stdin,
        );
        if (generated === "unsupported") {
          await notImplemented(io, argv, commandPath);
          return;
        }
        // The wrapper returned without invoking a generated command (or finished via SDK calls).
        if (generated === undefined) return;
        command = generated.command;
        callValues = generated.kwargs;
        const failure = usageCheckFailure(command, callValues);
        if (failure) {
          io.err(`UsageError: ${failure.message}\n`);
          throw new Exit(1);
        }
      }
      const call = {
        command,
        values: callValues,
        rootValues,
        settings,
        spec,
        index,
      };
      const result = await callOperation(io, call);
      const downloadTo = outputBinding(command);
      if (downloadTo !== undefined && result.response.ok) {
        const file = callValues[downloadTo];
        await writeDownload(
          io,
          result.response,
          file instanceof ProgramFile ? (file.name ?? "") : String(file),
        );
        return;
      }
      printResult(io, await waitForState(io, call, result, output), output);
      return;
    }
    await notImplemented(io, argv, commandPath);
  } finally {
    if (osObjectGetOutputFile?.fd !== undefined) {
      try {
        closeSync(osObjectGetOutputFile.fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
  }
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

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJsonKeys(child)]),
  );
}

function renderJsonExample(
  value: unknown,
  pool: Record<string, unknown>,
): string {
  const resolve = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(resolve);
    if (typeof current !== "object" || current === null) return current;
    const record = current as Record<string, unknown>;
    if (typeof record.__bociJsonRef === "string")
      return resolve(pool[record.__bociJsonRef]);
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, resolve(child)]),
    );
  };
  return JSON.stringify(sortJsonKeys(resolve(value)), null, 2).replace(
    /\{\s*"__bociJsonNumber":\s*"(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"\s*\}/g,
    "$1",
  );
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

function convertDefaultValue(
  env: Env,
  p: ParamSpec & { typeClass?: string; datetimeRounding?: string | null },
  value: string,
  datetime?: Index["datetime"],
): unknown {
  const expanded = expandVars(value, env);
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

/** What a wrapper program looks up or runs outside its kwargs (ProgramContext), on demand. */
type WrapperLookups = {
  region: () => string | undefined;
  tenancy: () => string | null;
  namespace: () => Promise<string>;
  sdkCall: (
    opIndex: number,
    posArgs: unknown[],
    kwArgs: Record<string, unknown>,
    region?: string,
  ) => Promise<ProgramSdkOutcome>;
  listCall: (call: ProgramListCall) => Promise<ProgramSdkOutcome>;
  waitUntil: (wait: ProgramWaitUntil) => Promise<ProgramSdkOutcome>;
  render: (response: ProgramResponse) => void;
  renderData: (render: ProgramRenderData) => void;
  serviceError: (result: OperationResult) => void;
  sleep: (seconds: number) => Promise<void>;
};

/**
 * Runs a programmed Tier B/C wrapper: executes any direct SDK calls and render_response
 * statements, and returns the generated command it invokes (when it uses ctx.invoke)
 * plus that command's kwargs, undefined when it finishes without invoking, or
 * "unsupported" for a path the Engine doesn't model.
 */
async function runWrapper(
  io: Invocation,
  command: ServiceSpec["commands"][string],
  values: Record<string, unknown>,
  usageText: () => string,
  models: ServiceSpec["models"],
  lookups: WrapperLookups,
  answers: ProgramAnswer[] = [],
  context: ProgramContext = {},
  // One reader for every prompt: the program runs again after each answer.
  stdin: StdinReader = createStdinReader(io),
): Promise<
  | { command: GeneratedCommand; kwargs: Record<string, unknown> }
  | undefined
  | "unsupported"
> {
  const program = command.program as NonNullable<typeof command.program>;
  const ctx: ProgramContext = {
    ...context,
    region: lookups.region,
    tenancy: lookups.tenancy,
  };
  try {
    const {
      kwargs,
      names,
      target = 0,
    } = runProgram(
      program.body,
      values,
      command.params ?? [],
      (name, value, camelize = true) =>
        parseJsonParameter(
          io,
          name,
          value,
          camelize
            ? {
                complexTypes: command.complexTypes,
                models,
              }
            : undefined,
        ),
      answers,
      programFiles(io),
      ctx,
    );
    if (!kwargs) return undefined;
    const variant = command.variants?.[target - 1];
    const invoked =
      target === 0
        ? {
            operation: command.operation,
            bindings: (command as GeneratedCommand).bindings,
            params: command.generated?.params ?? [],
            complexTypes: command.generated?.complexTypes,
            callback: command.generated?.callback,
          }
        : variant && {
            ...variant,
            params: variant.generated.params,
            complexTypes: variant.generated.complexTypes,
            callback: variant.generated.callback,
          };
    if (!invoked) return "unsupported";
    // A keyword the generated callback doesn't take: Python raises a TypeError at the call.
    const accepted = new Set(invoked.params.map((p) => p.name));
    const unexpected = names?.find((name) => !accepted.has(name));
    if (unexpected !== undefined) {
      if (!program.wrapExceptions || !invoked.callback) return "unsupported";
      const fn = invoked.callback.slice(invoked.callback.lastIndexOf(".") + 1);
      io.err(
        `TypeError: ${fn}() got an unexpected keyword argument ${pyRepr(unexpected)}\n`,
      );
      throw new Exit(1);
    }
    // Bytes, or a file opened for reading, go out only as the direct request body; a
    // `--file` opened for writing only as a download's output.
    const bodyArg = invoked.operation?.body;
    const directBody =
      invoked.bindings?.find(
        (binding) =>
          binding.target === "kwarg" &&
          Array.isArray(binding.key) &&
          binding.key[0] === bodyArg,
      )?.param ?? bodyArg;
    const output = invoked.bindings?.find((b) => b.target === "output")?.param;
    if (
      Object.entries(kwargs).some(([name, v]) =>
        v instanceof ProgramFile
          ? /[wax+]/.test(v.mode)
            ? name !== output || v.name === undefined
            : name !== directBody
          : v instanceof Uint8Array && name !== directBody,
      )
    )
      return "unsupported";
    return {
      command: {
        operation: invoked.operation,
        bindings: invoked.bindings,
        params: invoked.params,
        complexTypes: invoked.complexTypes ?? {},
      },
      kwargs,
    };
  } catch (e) {
    if (e instanceof ProgramUnsupported) return "unsupported";
    if (e instanceof ProgramConfirm) {
      // click.confirm under wrap_exceptions; then the program runs again, answered.
      if (!program.wrapExceptions) return "unsupported";
      const yes = await confirmUnderWrapExceptions(io, e.message, false, stdin);
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        [...answers, yes],
        context,
        stdin,
      );
    }
    if (e instanceof ProgramSecret) {
      if (!program.wrapExceptions) return "unsupported";
      // click.prompt(hide_input=True, confirmation_prompt=True) under wrap_exceptions.
      const secret = await promptHiddenConfirmed(
        io,
        stdin,
        `${e.message}: `,
        true,
      );
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        [...answers, secret],
        context,
        stdin,
      );
    }
    if (e instanceof ProgramLookup) {
      const namespace = await lookups.namespace();
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          namespace,
        },
        stdin,
      );
    }
    if (e instanceof ProgramSdkCall) {
      let outcome: ProgramSdkOutcome;
      try {
        outcome = await lookups.sdkCall(
          e.opIndex,
          e.posArgs,
          e.kwArgs,
          e.region,
        );
      } catch (sdkErr) {
        if (sdkErr instanceof ProgramUnsupported) return "unsupported";
        if (sdkErr instanceof ProgramRaise) outcome = sdkErr;
        else throw sdkErr;
      }
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          sdkResults: [...(ctx.sdkResults ?? []), outcome],
        },
        stdin,
      );
    }
    if (e instanceof ProgramListCall) {
      let outcome: ProgramSdkOutcome;
      try {
        outcome = await lookups.listCall(e);
      } catch (listErr) {
        if (listErr instanceof ProgramUnsupported) return "unsupported";
        if (listErr instanceof ProgramRaise) outcome = listErr;
        else throw listErr;
      }
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          listResults: [...(ctx.listResults ?? []), outcome],
        },
        stdin,
      );
    }
    if (e instanceof ProgramWaitUntil) {
      let outcome: ProgramSdkOutcome;
      try {
        outcome = await lookups.waitUntil(e);
      } catch (waitErr) {
        if (waitErr instanceof ProgramUnsupported) return "unsupported";
        if (waitErr instanceof ProgramRaise) outcome = waitErr;
        else throw waitErr;
      }
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          waitResults: [...(ctx.waitResults ?? []), outcome],
        },
        stdin,
      );
    }
    if (e instanceof ProgramRender) {
      lookups.render(e.response);
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          renderedCount: (ctx.renderedCount ?? 0) + 1,
        },
        stdin,
      );
    }
    if (e instanceof ProgramRenderData) {
      lookups.renderData(e);
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          renderedCount: (ctx.renderedCount ?? 0) + 1,
        },
        stdin,
      );
    }
    if (e instanceof ProgramEcho) {
      if (e.toStderr) io.err(e.text);
      else io.out(e.text);
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          echoCount: (ctx.echoCount ?? 0) + 1,
        },
        stdin,
      );
    }
    if (e instanceof ProgramSleep) {
      await lookups.sleep(e.seconds);
      return runWrapper(
        io,
        command,
        values,
        usageText,
        models,
        lookups,
        answers,
        {
          ...ctx,
          sleepCount: (ctx.sleepCount ?? 0) + 1,
        },
        stdin,
      );
    }
    if (e instanceof ProgramExit) {
      if (e.output) io.err(e.output);
      throw new Exit(e.code);
    }
    if (e instanceof ProgramServiceError) {
      lookups.serviceError(e.result);
      return undefined;
    }
    if (e instanceof ProgramAbort) {
      if (!program.wrapExceptions) return "unsupported";
      io.err("Abort: \n");
      throw new Exit(1);
    }
    if (e instanceof ProgramRaise) {
      // cli_util.wrap_exceptions: sys.exit(...) → stderr, exit 1.
      if (!program.wrapExceptions) return "unsupported";
      io.err(
        e.cls === "RequiredValueNotInDefaultOrUserInputError"
          ? `${usageText()}\n\nError: ${e.message}\n`
          : `${e.cls}: ${e.message}\n`,
      );
      throw new Exit(1);
    }
    if (!(e instanceof ProgramUsageError)) throw e;
    if (!program.wrapExceptions) showPatched(io, usageText(), e.message);
    io.err(`UsageError: ${e.message}\n`);
    throw new Exit(1);
  }
}

/** What a wrapper program's `open()` and `os.path.exists()` see: files under the cwd. */
function programFiles(io: Invocation): ProgramFiles {
  return {
    open(path, mode) {
      if (/[wax+]/.test(mode)) throw new ProgramUnsupported("open() to write");
      const resolved = resolve(io.cwd, path);
      try {
        checkFileAccessibility(resolved, "r");
        return new ProgramFile(mode, readFileSync(resolved));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EACCES")
          throw new ProgramRaise(
            "PermissionError",
            `[Errno 13] Permission denied: ${pyRepr(path)}`,
          );
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          throw new ProgramRaise(
            "FileNotFoundError",
            `[Errno 2] No such file or directory: ${pyRepr(path)}`,
          );
        throw new ProgramUnsupported("open()");
      }
    },
    exists: (path) => path !== "" && existsSync(resolve(io.cwd, path)),
    isfile: (path) => {
      try {
        return path !== "" && statSync(resolve(io.cwd, path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Exit code for "boci doesn't implement this yet" (oci itself uses 0, 1 and 2). */
export const NOT_IMPLEMENTED = 3;

/**
 * The command is valid but boci can't run it yet. With BOCI_FALLBACK set (e.g. to `oci`),
 * hand the untouched argv, stdin and stdio to the Reference CLI and return its exit code.
 */
async function notImplemented(
  io: Invocation,
  argv: string[],
  commandPath: string,
): Promise<never> {
  const fallback = io.env.BOCI_FALLBACK;
  const depth = Number(io.env.BOCI_FALLBACK_DEPTH ?? "0");
  if (fallback && depth === 0) {
    const bin =
      Bun.which(fallback, { PATH: io.env.PATH ?? "", cwd: io.cwd }) ?? fallback;
    const cmd =
      process.platform === "win32" && /\.[mc]?[jt]s$/i.test(bin)
        ? [
            Bun.which("bun", {
              PATH: io.env.PATH ?? process.env.PATH ?? "",
            }) ?? process.execPath,
            bin,
            ...argv,
          ]
        : [bin, ...argv];
    const options = {
      cwd: io.cwd,
      env: { ...io.env, BOCI_FALLBACK_DEPTH: String(depth + 1) },
    };
    if (io.inheritStdio) {
      await io.inheritStdio.flush(); // boci's warnings come before the child's output
      const proc = Bun.spawn(cmd, {
        ...options,
        stdio: ["inherit", "inherit", "inherit"],
      });
      throw new Exit(await proc.exited);
    }
    const proc = Bun.spawn(cmd, {
      ...options,
      stdin: io.stdin === undefined ? "ignore" : new Blob([io.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    io.out(stdout);
    io.err(stderr);
    throw new Exit(code);
  }
  io.err(
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

async function printRootHelp(io: Invocation, index: Index, doc: HelpDoc) {
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
  io.out(
    `${rootHelp(doc, core, index.services, index.ociHelp, index.ociUserHelp, helpWidth(io))}\n`,
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
  io: Invocation,
  values: Record<string, unknown>,
  rc: Rc,
  rootUsage: () => string,
): RootSettings {
  const env = io.env;
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
        io,
        rootUsage(),
        `Invalid value for OCI_CLI_AUTH: invalid choice: ${env.OCI_CLI_AUTH}. (choose from ${AUTH_CHOICES.join(", ")})`,
      );
    }
    auth = env.OCI_CLI_AUTH;
  }
  return { configFile, profile, auth };
}

/** cli_root.check_key_for_security: warn when the API key lacks the OCI_API_KEY label. */
function checkKeyForSecurity(io: Invocation, s: RootSettings) {
  if (s.auth !== null && s.auth !== "api_key") return;
  let keyFile = keyFileFor(io, s.configFile, s.profile);
  if (io.env.OCI_CLI_KEY_FILE !== undefined) keyFile = io.env.OCI_CLI_KEY_FILE;
  if (
    (io.env.SUPPRESS_LABEL_WARNING ?? "").toLowerCase() === "true" ||
    !keyFile
  )
    return;
  let content: string;
  try {
    content = readFileSync(resolve(io.cwd, keyFile), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      io.err(
        `FileNotFoundError: [Errno 2] No such file or directory: ${pyRepr(keyFile)}\n`,
      );
      throw new Exit(1);
    }
    return;
  }
  if (content.replace(/\s+$/u, "").endsWith("OCI_API_KEY")) return;
  const message =
    `Warning: To increase security of your API key located at ${keyFile}, append an extra line with 'OCI_API_KEY' at the end. ` +
    "For more information, refer to https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm. " +
    "To suppress the warning, set the env variable SUPPRESS_LABEL_WARNING=True";
  io.err(`${style(message, "yellow", io.isTTY(2))}\n`);
}

/** cli_root.get_key_file: configparser read of the config (missing file → none). */
function keyFileFor(
  io: Invocation,
  configFile: string,
  profile: string,
): string | null {
  const path = expandUser(configFile, io.env);
  let text: string;
  try {
    text = readFileSync(resolve(io.cwd, path), "utf8");
  } catch {
    return null;
  }
  try {
    const items = sectionItems(parseConfig(text, path), profile);
    const keyFile = items?.get("key_file");
    return keyFile ? expandUser(keyFile, io.env) : null;
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
  io: Invocation,
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
        io.err(
          `${style(`Could not use '${name}' as an alias for '${shadowed}' as it belongs to an existing command under '${chain}'`, "red", io.isTTY(2))}\n`,
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

// oci_cli_rc: oci's CLI-specific settings file (cli_root.eager_load_cli_rc_file).
import { existsSync, readFileSync } from "node:fs";
import { expandUser } from "./config.ts";
import {
  type ParsedConfig,
  parseConfig,
  sectionItems,
} from "./configparser.ts";

export const RC_DEFAULT_LOCATION = "~/.oci/oci_cli_rc";
export const RC_FALLBACK_LOCATION = "~/.oci/cli-defaults";

export type Rc = {
  /** The file that was read, or the value given when none was found. */
  path: string;
  parsed: ParsedConfig | null;
  settings: Record<string, string>;
  cannedQueries: Record<string, string>;
  globalCommandAliases: Record<string, string>;
  commandSequenceAliases: Record<string, Record<string, string>>;
  parameterAliases: Record<string, string[]>;
};

/** os.path.expandvars: $NAME and ${NAME}; unknown variables are left as-is. */
export function expandVars(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!path.includes("$")) return path;
  return path.replace(/\$(\w+|\{[^}]*\})/g, (m, name: string) => {
    const key = name.startsWith("{") ? name.slice(1, -1) : name;
    return env[key] ?? m;
  });
}

const expand = (p: string, env: Record<string, string | undefined>) =>
  expandVars(expandUser(p, env), env);

/** Find and read the rc file: given value, $OCI_CLI_RC_FILE, default, fallback. */
export function loadRc(
  value: string,
  env: Record<string, string | undefined> = process.env,
): Rc {
  const candidates = [
    expand(value, env),
    ...(env.OCI_CLI_RC_FILE !== undefined
      ? [expand(env.OCI_CLI_RC_FILE, env)]
      : []),
    expand(RC_DEFAULT_LOCATION, env),
    expand(RC_FALLBACK_LOCATION, env),
  ];
  const found = candidates.find((p) => existsSync(p));
  const rc: Rc = {
    path: found ?? value,
    parsed: null,
    settings: {},
    cannedQueries: {},
    globalCommandAliases: {},
    commandSequenceAliases: {},
    parameterAliases: {},
  };
  if (!found) return rc;
  let text = "";
  try {
    text = readFileSync(found, "utf8");
  } catch {
    // configparser.read() silently skips unreadable files.
    return rc;
  }
  rc.parsed = parseConfig(text, found);
  // oci reads these sections with default_section=None: no DEFAULT inheritance.
  const section = (name: string) =>
    [...(rc.parsed?.sections.get(name) ?? new Map())] as [string, string][];
  rc.settings = Object.fromEntries(section("OCI_CLI_SETTINGS"));
  rc.cannedQueries = Object.fromEntries(section("OCI_CLI_CANNED_QUERIES"));
  for (const [alias, target] of section("OCI_CLI_COMMAND_ALIASES")) {
    if (!target.includes(".")) rc.globalCommandAliases[alias] = target;
    else {
      const parts = target.split(".");
      const chain = parts.slice(0, -1).join(" ");
      rc.commandSequenceAliases[chain] ??= {};
      (rc.commandSequenceAliases[chain] as Record<string, string>)[alias] =
        parts[parts.length - 1] as string;
    }
  }
  for (const [alias, canonical] of section("OCI_CLI_PARAM_ALIASES")) {
    if (!alias.startsWith("-")) continue;
    (rc.parameterAliases[canonical] ??= []).push(alias);
  }
  return rc;
}

/** cli_root.load_default_values: the profile's section of the rc file (DEFAULT inherited). */
export function rcDefaults(
  rc: Rc,
  profile: string,
): Map<string, string | null> {
  if (!rc.parsed) return new Map();
  return sectionItems(rc.parsed, profile) ?? new Map();
}

/**
 * cli_util.get_default_value_from_defaults_file: most specific command chain first
 * (compute.instance.launch.x → compute.instance.x → compute.x → x), and for each chain
 * the param name, its rc aliases, then its own long/short option names.
 */
export function lookupDefault(
  defaults: Map<string, string | null>,
  rc: Rc,
  chain: string[],
  param: { name: string; opts: string[] },
): string | null | undefined {
  const paramName = param.name.replaceAll("_", "-");
  const names = [paramName];
  for (const alias of rc.parameterAliases[`--${paramName}`] ?? []) {
    names.push(alias.startsWith("--") ? alias.slice(2) : alias.slice(1));
  }
  for (const o of param.opts) {
    const n = o.startsWith("--") ? o.slice(2) : o.slice(1);
    if (!names.includes(n)) names.push(n);
  }
  const hierarchy = chain
    .map((_, i) => chain.slice(0, chain.length - i).join("."))
    .concat([""]);
  for (const prefix of hierarchy) {
    for (const n of names) {
      const key = prefix ? `${prefix}.${n}` : n;
      if (defaults.has(key)) return defaults.get(key);
    }
  }
  return undefined;
}

// oci_cli_rc: oci's CLI-specific settings file (cli_root.eager_load_cli_rc_file).
import type { Env } from "./io.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
export function expandVars(path: string, env: Env): string {
  if (!path.includes("$")) return path;
  return path.replace(/\$(\w+|\{[^}]*\})/g, (m, name: string) => {
    const key = name.startsWith("{") ? name.slice(1, -1) : name;
    return env[key] ?? m;
  });
}

const expand = (p: string, env: Record<string, string | undefined>) =>
  expandVars(expandUser(p, env), env);

/** Find and read the rc file: given value, $OCI_CLI_RC_FILE, default, fallback. */
export function loadRc(value: string, env: Env, cwd: string): Rc {
  const candidates = [
    expand(value, env),
    ...(env.OCI_CLI_RC_FILE !== undefined
      ? [expand(env.OCI_CLI_RC_FILE, env)]
      : []),
    expand(RC_DEFAULT_LOCATION, env),
    expand(RC_FALLBACK_LOCATION, env),
  ];
  const found = candidates.find((p) => existsSync(resolve(cwd, p)));
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
    text = readFileSync(resolve(cwd, found), "utf8");
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

/** cli_root.populate_parameter_aliases: messages for single-dash aliases longer than one letter. */
export function badAliasMessages(rc: Rc): string[] {
  const out: string[] = [];
  for (const aliases of Object.values(rc.parameterAliases)) {
    for (const alias of aliases) {
      if (!alias.startsWith("--") && alias.length > 2) {
        out.push(
          `Could not create an alias for ${alias} as aliases need to be prefixed with '--' or be a single dash followed by a single letter. For example: --alias, -a`,
        );
      }
    }
  }
  return out;
}

/** parameter_alias.remove_redundant_aliases: drop aliases equal to their canonical option. */
export function effectiveAliases(rc: Rc): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rc.parameterAliases).map(([canonical, aliases]) => [
      canonical,
      aliases.filter((a) => a !== canonical),
    ]),
  );
}

type AliasableParam = { name: string; opts: string[] };

/**
 * parameter_alias.add_alias_to_command_params: extend each param's opts with the aliases of
 * any of its options (including aliases added on the way), unless another param of the
 * same command already uses that name. Returns new params and the collision messages.
 */
export function applyParamAliases<T extends AliasableParam>(
  params: T[],
  aliases: Record<string, string[]>,
): { params: T[]; collisions: string[] } {
  const copies = params.map((p) => ({ ...p, opts: [...p.opts] }));
  const collisions: string[] = [];
  for (const param of copies) {
    const opts = param.opts;
    for (let i = 0; i < opts.length; i++) {
      const extra = aliases[opts[i] as string];
      if (!extra) continue;
      const clash = copies.find(
        (other) =>
          other.name !== param.name &&
          extra.some((a) => other.opts.includes(a)),
      );
      if (clash) {
        const a = extra.find((x) => clash.opts.includes(x)) as string;
        const msg = `Could not add alias ${a} to param ${opts[0]} as it conflicts with existing options for parameter ${clash.opts[0]}`;
        if (!collisions.includes(msg)) collisions.push(msg);
      } else opts.push(...extra);
    }
  }
  return { params: copies, collisions };
}

/** click.formatting.join_options: options sorted by prefix length (stable), ", "-joined. */
export function joinOptions(opts: string[]): string {
  const prefixLen = (o: string) =>
    /^[\p{L}\p{N}]/u.test(o) ? 0 : o[1] === o[0] ? 2 : 1;
  return opts
    .map((o, i) => ({ o, i, len: prefixLen(o) }))
    .sort((a, b) => a.len - b.len || a.i - b.i)
    .map(({ o }) => o)
    .join(", ");
}

/** Rewrite help-record terms for params whose option list grew. */
export function aliasRecords(
  records: [string, string][],
  before: AliasableParam[],
  after: AliasableParam[],
): [string, string][] {
  const changes = before
    .map(
      (p, i) =>
        [
          joinOptions(p.opts),
          joinOptions((after[i] as AliasableParam).opts),
        ] as const,
    )
    .filter(([a, b]) => a !== b);
  return records.map(([term, help]) => {
    for (const [old, now] of changes) {
      if (term === old || term.startsWith(`${old} `))
        return [now + term.slice(old.length), help] as [string, string];
    }
    return [term, help];
  });
}

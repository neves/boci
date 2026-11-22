// Port of oci.config.from_file (OCI Python SDK): locate the config file, read a profile
// (inheriting [DEFAULT]) with configparser semantics, and validate it the same way.
import type { Env } from "../lib/io.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ConfigParserError,
  parseConfig,
  sectionItems,
} from "../lib/configparser.ts";

export const DEFAULT_LOCATION = "~/.oci/config";
export const FALLBACK_DEFAULT_LOCATION = "~/.oraclebmc/config";
export const DEFAULT_PROFILE = "DEFAULT";
export const CONFIG_FILE_PATH_ENV_VAR_NAME = "OCI_CONFIG_FILE";
const DEBUG_INFO =
  "For more info about config file and how to get required information, see https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm";

export type ConfigErrorType =
  | "ConfigFileNotFound"
  | "ProfileNotFound"
  | "InvalidKeyFilePath"
  | "ValueError"
  | ConfigParserError["type"];

export class ConfigError extends Error {
  constructor(
    message: string,
    public type: ConfigErrorType,
  ) {
    super(message);
  }
}

export type Config = Record<string, string | boolean | null>;

/** os.path.expanduser */
export function expandUser(path: string, env: Env): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/");
  const user = path.slice(1, slash === -1 ? undefined : slash);
  if (user) return path; // ~otheruser: left alone (not resolved without pwd lookup)
  const home = env.HOME ?? homedir();
  return (
    home.replace(/\/+$/, "") + (slash === -1 ? "" : path.slice(slash)) || "/"
  );
}

const isFile = (p: string, cwd: string) => {
  try {
    return statSync(resolve(cwd, p)).isFile();
  } catch {
    return false;
  }
};

/** oci.config._get_config_path_with_fallback */
export function configPath(
  fileLocation: string,
  env: Env,
  cwd: string,
): string {
  const expanded = expandUser(fileLocation, env);
  if (fileLocation !== DEFAULT_LOCATION || isFile(expanded, cwd))
    return expanded;
  const fromEnv = env[CONFIG_FILE_PATH_ENV_VAR_NAME];
  if (fromEnv) return expandUser(fromEnv, env);
  const fallback = expandUser(FALLBACK_DEFAULT_LOCATION, env);
  if (isFile(fallback, cwd)) return fallback;
  return expanded;
}

function asBool(x: string | boolean | null): boolean {
  if (typeof x === "boolean") return x;
  const v = String(x).toLowerCase();
  if (["1", "yes", "true", "on"].includes(v)) return true;
  if (["0", "no", "false", "off"].includes(v)) return false;
  throw new ConfigError(
    `${JSON.stringify(x).replace(/^"|"$/g, "'")} is not a valid alias for True/False`,
    "ValueError",
  );
}

export function fromFile(
  fileLocation = DEFAULT_LOCATION,
  profileName = DEFAULT_PROFILE,
  env: Env,
  cwd: string,
): Config {
  const path = configPath(fileLocation, env, cwd);
  if (!existsSync(resolve(cwd, path)) || !isFile(path, cwd)) {
    throw new ConfigError(
      `Could not find config file at ${path}, please follow the instructions in the link to setup the config file https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm`,
      "ConfigFileNotFound",
    );
  }
  let parsed: ReturnType<typeof parseConfig>;
  try {
    parsed = parseConfig(readFileSync(resolve(cwd, path), "utf8"), path);
  } catch (e) {
    if (e instanceof ConfigParserError)
      throw new ConfigError(e.message, e.type);
    throw e;
  }
  const items = sectionItems(parsed, profileName);
  if (!items) {
    throw new ConfigError(
      `Profile '${profileName}' not found in config file ${path} ${DEBUG_INFO}`,
      "ProfileNotFound",
    );
  }
  const config: Config = {
    log_requests: false,
    additional_user_agent: "",
    pass_phrase: null,
  };
  for (const [k, v] of items) config[k] = v;
  config.log_requests = asBool(config.log_requests as string | boolean);
  if ("key_content" in config) {
    throw new ConfigError(
      `'key_content' cannot be specified in a config file for security reasons. To use this key you must add it to the config programmatically. ${DEBUG_INFO}`,
      "ValueError",
    );
  }
  if ("key_file" in config) {
    const keyPath = expandUser(String(config.key_file), env);
    if (!isFile(keyPath, cwd)) {
      const line = lineOf(
        String(config.key_file),
        resolve(cwd, path),
        profileName,
      );
      throw new ConfigError(
        `Config file ${path} is invalid: the key_file's value '${keyPath}'${line ? ` at line ${line}` : ""} must be a valid file path. ${DEBUG_INFO}`,
        "InvalidKeyFilePath",
      );
    }
  }
  return config;
}

/** oci.config.get_linenum_from_file */
function lineOf(key: string, filename: string, profile: string): number | null {
  const token = `[${profile}]`;
  let found = false;
  const lines = readFileSync(filename, "utf8")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith("#")) continue;
    if (line.includes(token)) found = true;
    if (found && line.includes(key)) return i + 1;
  }
  return null;
}

import { existsSync, readFileSync } from "node:fs";
import { expandUser } from "../core/config.ts";
import { parseConfig, sectionItems } from "../lib/configparser.ts";
import { type Env, Exit, type Invocation } from "../lib/io.ts";

function fileStatus(path: string | null | undefined, env: Env): string {
  if (!path) return "not_configured";
  return existsSync(expandUser(path, env)) ? "present" : "missing";
}

export function runProfileCurrent(
  io: Invocation,
  opts: {
    settings: { configFile: string; profile: string; auth: string | null };
  },
): void {
  const { configFile, profile, auth } = opts.settings;
  const resolvedConfig = expandUser(configFile, io.env);
  if (!existsSync(resolvedConfig)) {
    io.err(`ClickException: Config file not found: ${resolvedConfig}\n`);
    throw new Exit(1);
  }
  const parsed = parseConfig(
    readFileSync(resolvedConfig, "utf8"),
    resolvedConfig,
  );
  const items = sectionItems(parsed, profile);
  if (!items) {
    io.err(
      `ClickException: Profile ${profile} not found in config file ${resolvedConfig}\n`,
    );
    throw new Exit(1);
  }

  const keyFile = items.get("key_file");
  const securityTokenFile = items.get("security_token_file");
  const delegationTokenFile = items.get("delegation_token_file");
  const authType = auth ?? (securityTokenFile ? "security_token" : "api_key");

  const data: Record<string, unknown> = {
    active: true,
    "auth-type": authType,
    "config-file": resolvedConfig,
    "delegation-token-file-status": fileStatus(delegationTokenFile, io.env),
    fingerprint: items.get("fingerprint") ?? null,
    "key-file-status": fileStatus(keyFile, io.env),
    name: profile,
    region: items.get("region") ?? null,
    "security-token-file-status": fileStatus(securityTokenFile, io.env),
    tenancy: items.get("tenancy") ?? null,
    user: items.get("user") ?? null,
  };

  io.out(`${JSON.stringify({ data }, null, 2)}\n`);
}

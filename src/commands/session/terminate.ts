import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Config,
  ConfigError,
  configPath,
  DEFAULT_PROFILE,
  expandUser,
  fromFile,
} from "../../core/config.ts";
import {
  applyConfigEnvVars,
  warnFilePermissions,
} from "../../core/operation.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  ConfigParserError,
  formatParsedConfig,
  parseConfig,
} from "../../lib/configparser.ts";
import { Exit, type Env } from "../../lib/io.ts";

function configProvidedByEnv(env: Env, auth: string | null, region: unknown) {
  if (env.OCI_CLI_USER === undefined || env.OCI_CLI_TENANCY === undefined)
    return false;
  if (env.OCI_CLI_REGION === undefined && !region) return false;
  if (auth === "pkcs11") return true;
  return (
    env.OCI_CLI_FINGERPRINT !== undefined &&
    (env.OCI_CLI_KEY_FILE !== undefined ||
      env.OCI_CLI_KEY_CONTENT !== undefined)
  );
}

export async function runSessionTerminate({
  io,
  settings,
  rootValues,
}: CustomCommandContext) {
  const { env, cwd } = io;
  const { configFile, profile, auth } = settings;
  const fail = (message: string): never => {
    io.err(`${message}\n`);
    throw new Exit(1);
  };

  const region = rootValues.region || env.OCI_CLI_REGION;
  let config: Config = {};
  if (!configProvidedByEnv(env, auth, region)) {
    try {
      config = fromFile(configFile, profile, env, cwd);
      if (
        env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING?.toLowerCase() !== "true"
      )
        warnFilePermissions(io, configPath(configFile, env, cwd));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      if (
        error.type === "ProfileNotFound" ||
        error.type === "InvalidKeyFilePath"
      ) {
        if (auth !== "instance_principal" && auth !== "resource_principal")
          fail(`ERROR: ${error.message}`);
      } else {
        fail(`${error.type}: ${error.message}`);
      }
    }
  }
  applyConfigEnvVars(config, env);
  if (!config.security_token_file)
    fail(
      "ERROR: Cannot terminate a profile that does not have a value for 'security_token_file'",
    );

  const path = expandUser(configFile, env);
  const file = Bun.file(resolve(cwd, path));
  try {
    const text = (await file.exists()) ? await file.text() : "";
    const parsed = parseConfig(text, path);
    if (profile === DEFAULT_PROFILE)
      fail("ERROR: Cannot terminate DEFAULT profile");
    if (!parsed.sections.has(profile)) fail("ERROR: Profile does not exist");

    // ConfigParser(default_section="") preserves DEFAULT in its original position.
    const updated = parseConfig(text, path, "");
    updated.sections.delete(profile);
    await Bun.write(file, formatParsedConfig(updated, ""));

    const session = resolve(cwd, expandUser("~/.oci/sessions", env), profile);
    const entry = await lstat(session).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry?.isSymbolicLink())
      fail("OSError: Cannot call rmtree on a symbolic link");
    if (entry && !entry.isDirectory())
      fail(`NotADirectoryError: [Errno 20] Not a directory: '${session}'`);
    if (entry) await rm(session, { recursive: true });
  } catch (error) {
    if (error instanceof Exit) throw error;
    if (error instanceof ConfigParserError)
      fail(`${error.type}: ${error.message}`);
    throw error;
  }
  io.err(`Successfully removed profile: ${profile} from config: ${path}\n`);
}

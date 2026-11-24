// Custom `oci session` commands (port of oci_cli/cli_session.py).
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getPosixMode } from "../lib/posixMode.ts";
import {
  type Config,
  ConfigError,
  DEFAULT_PROFILE,
  configPath,
  expandUser,
  fromFile,
} from "../core/config.ts";
import {
  ConfigParserError,
  parseConfig,
  sectionItems,
} from "../lib/configparser.ts";
import { pyRepr } from "../core/convert.ts";
import {
  type RegionsSpec,
  loadExternalRegionMetadata,
  resolveEndpoint,
} from "../core/endpoint.ts";
import { type Env, Exit, type Invocation } from "../lib/io.ts";
import {
  type ClientSettings,
  applyConfigEnvVars,
  confirmUnderWrapExceptions,
  createServiceClient,
  promptFromStdin,
  sendServiceRequest,
  warnFilePermissions,
} from "../core/operation.ts";
import { formatServiceError } from "../core/output.ts";
import type { Rc } from "../core/rc.ts";
import { readConfigFile } from "../utils/configFile.ts";
import { normalizePosixPath } from "../utils/posixPath.ts";
import {
  DEFAULT_KEY_NAME,
  DEFAULT_PROFILE_NAME,
  PRIVATE_KEY_FILENAME_SUFFIX,
  PRIVATE_KEY_LABEL,
  PUBLIC_KEY_FILENAME_SUFFIX,
  type StdinReader,
  applyUserOnlyAccessPermissions,
  confirmClick,
  createDirectory,
  createStdinReader,
  generateKey,
  promptForPassphrase,
  promptForRegion,
  publicKeyToFingerprint,
  removeProfileFromConfig,
  serializePrivateKey,
  serializePublicKey,
  writeConfig,
} from "./setup.ts";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "../core/signer.ts";
import { type Index, type ServiceSpec, loadService } from "../core/spec.ts";
import {
  BadZipFileError,
  type ZipEntryInput,
  readZip,
  writeZipFile,
} from "../lib/zip.ts";

import {
  SecurityTokenDecodeError,
  SecurityTokenKeyError,
  decodeSecurityToken,
  isSecurityTokenValid,
} from "../core/security-token.ts";
import { fetchTransportFromEnv } from "../core/transport.ts";
import { isNoProxyHost } from "../utils/isNoProxyHost.ts";
import { openUrlInBrowser as openBrowser } from "../utils/openUrlInBrowser.ts";
import { publicKeyToJwk as toJwk } from "../utils/publicKeyToJwk.ts";

export {
  SecurityTokenDecodeError,
  SecurityTokenKeyError,
  decodeSecurityToken,
  fetchTransportFromEnv,
  isNoProxyHost,
  isSecurityTokenValid,
  openBrowser,
  toJwk,
};

/**
 * Port of `datetime.datetime.fromtimestamp(exp).strftime("%Y-%m-%d %H:%M:%S")`,
 * honoring `env.TZ` (important for in-process runs where `process.env.TZ` differs).
 */
export function formatLocalTimestamp(
  epochSeconds: number,
  tz?: string,
): string {
  const date = new Date(epochSeconds * 1000);
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const get = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? "00";
      return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
    } catch {
      // Fall through to process local time if TZ is not a recognized IANA zone.
    }
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Port of `cli_util.build_config(ctx.obj)` for session commands.
 * Unlike `create_config_and_signer_based_on_click_context`, `ConfigFileNotFound` is not
 * intercepted with an interactive setup prompt; `@cli_util.wrap_exceptions` formats it as
 * `ConfigFileNotFound: <message>`.
 */
function buildSessionConfig(
  io: Invocation,
  settings: ClientSettings,
  rootValues: Record<string, unknown>,
): Config {
  let config: Config;
  try {
    config = fromFile(settings.configFile, settings.profile, io.env, io.cwd);
  } catch (e) {
    if (e instanceof ConfigError) {
      if (e.type === "ProfileNotFound" || e.type === "InvalidKeyFilePath") {
        io.err(`ERROR: ${e.message}\n`);
        throw new Exit(1);
      }
      io.err(`${e.type}: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }
  if (
    (io.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING ?? "").toLowerCase() !==
    "true"
  ) {
    warnFilePermissions(io, configPath(settings.configFile, io.env, io.cwd));
  }
  applyConfigEnvVars(config, io.env);
  const regionOverride =
    typeof rootValues.region === "string" && rootValues.region
      ? rootValues.region
      : io.env.OCI_CLI_REGION;
  if (regionOverride) {
    config.region = regionOverride;
  }
  if (typeof rootValues.endpoint === "string" && rootValues.endpoint) {
    config.endpoint = rootValues.endpoint;
  } else {
    delete config.endpoint;
  }
  return config;
}

/** `oci session validate [--local]` (port of `cli_session.validate`). */
export async function runSessionValidate(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    rootValues: Record<string, unknown>;
    settings: ClientSettings;
    index: Pick<Index, "regions">;
  },
): Promise<void> {
  const { values, rootValues, index } = opts;
  const sessionSettings: ClientSettings = {
    ...opts.settings,
    auth: "security_token",
  };
  const clientConfig = buildSessionConfig(io, sessionSettings, rootValues);
  const profileName = sessionSettings.profile;

  const securityTokenLocation = clientConfig.security_token_file;
  if (typeof securityTokenLocation !== "string" || !securityTokenLocation) {
    io.err(
      `ERROR: No security_token_file was found in config for profile: ${profileName}\n`,
    );
    throw new Exit(1);
  }

  // cli_session.validate checks os.path.exists(security_token_location) without expanduser.
  const tokenPath = resolve(io.cwd, securityTokenLocation);
  if (!existsSync(tokenPath)) {
    io.err(
      `ERROR: 'security_token_file' not found: ${securityTokenLocation}\n`,
    );
    throw new Exit(1);
  }

  const token = readFileSync(tokenPath, "utf8");
  let jwtPayload: Record<string, unknown>;
  try {
    jwtPayload = decodeSecurityToken(token);
  } catch (e) {
    if (e instanceof SecurityTokenDecodeError) {
      io.err(`${e.name}: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }

  if (values.local === true) {
    try {
      if (!isSecurityTokenValid(jwtPayload)) {
        io.err("Session has expired\n");
        throw new Exit(1);
      }
    } catch (e) {
      if (e instanceof SecurityTokenKeyError) {
        io.err(`${e.name}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
  } else {
    const iamSpec = await loadService("iam");
    const identityClient = iamSpec.clients["identity.identity"];
    if (!identityClient) {
      throw new Error("Missing identity.identity client in iam spec");
    }
    const sc = await createServiceClient(io, {
      client: identityClient,
      values,
      rootValues,
      settings: sessionSettings,
      index,
    });
    const { url, response, raw } = await sendServiceRequest(io, sc, {
      method: "GET",
      pathTemplate: "/regions",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      if (response.status === 401) {
        io.err("Session was deemed invalid by service\n");
        throw new Exit(1);
      }
      io.err(
        formatServiceError(
          { http: "GET", method: "list_regions" },
          url,
          response,
          raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }
  }

  if (!("exp" in jwtPayload) || jwtPayload.exp === undefined) {
    io.err("KeyError: 'exp'\n");
    throw new Exit(1);
  }
  const expiryTime = formatLocalTimestamp(Number(jwtPayload.exp), io.env.TZ);
  io.err(`Session is valid until ${expiryTime}\n`);
}

/** `oci session refresh` (port of `cli_session.refresh`). */
export async function runSessionRefresh(
  io: Invocation,
  opts: {
    rootValues: Record<string, unknown>;
    settings: ClientSettings;
    index: Pick<Index, "regions">;
  },
): Promise<void> {
  const { rootValues, settings, index } = opts;
  const clientConfig = buildSessionConfig(io, settings, rootValues);

  const securityTokenFile = clientConfig.security_token_file;
  if (typeof securityTokenFile !== "string" || !securityTokenFile) {
    io.err(
      "ERROR: Cannot refresh a profile that does not have a value for 'security_token_file'\n",
    );
    throw new Exit(1);
  }

  const expandedTokenLocation = expandUser(securityTokenFile, io.env);
  const resolvedTokenPath = resolve(io.cwd, expandedTokenLocation);
  if (!existsSync(resolvedTokenPath)) {
    io.out(
      `ERROR: Cannot refresh token, 'security_token_file' does not exist: ${expandedTokenLocation}\n`,
    );
    throw new Exit(1);
  }

  const token = readFileSync(resolvedTokenPath, "utf8");

  const keyFile = clientConfig.key_file;
  if (typeof keyFile !== "string") {
    io.err(
      "TypeError: expected str, bytes or os.PathLike object, not NoneType\n",
    );
    throw new Exit(1);
  }
  const expandedKeyPath = expandUser(keyFile, io.env);
  const resolvedKeyPath = resolve(io.cwd, expandedKeyPath);
  let pem: string;
  try {
    pem = readFileSync(resolvedKeyPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      io.err(
        `FileNotFoundError: [Errno 2] No such file or directory: '${expandedKeyPath}'\n`,
      );
      throw new Exit(1);
    }
    throw e;
  }

  const loadRefreshKey = (passPhrase: string | null): KeyObject => {
    try {
      return loadPrivateKey(pem, passPhrase);
    } catch (e) {
      if (e instanceof InvalidPrivateKey) {
        io.err(`InvalidPrivateKey: ${e.message}\n`);
        throw new Exit(1);
      }
      if (e instanceof TypeError) {
        io.err(`TypeError: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
  };

  let privateKey: KeyObject;
  try {
    privateKey = loadRefreshKey(
      (clientConfig.pass_phrase as string | null) ?? null,
    );
  } catch (e) {
    if (e instanceof MissingPrivateKeyPassphrase) {
      const prompted = io.promptSecret
        ? ((await io.promptSecret("Private key passphrase:")) ?? "")
        : promptFromStdin(io, "Private key passphrase:");
      privateKey = loadRefreshKey(prompted);
    } else {
      throw e;
    }
  }

  const region =
    typeof clientConfig.region === "string" && clientConfig.region
      ? clientConfig.region
      : undefined;
  if (!region) {
    io.err("ValueError: Must supply either a region or an endpoint.\n");
    throw new Exit(1);
  }

  const regionMetadata = await loadExternalRegionMetadata(
    region,
    index.regions,
    io.env,
  );
  const { resolved: authEndpoint } = resolveEndpoint(
    { serviceName: "auth" },
    index.regions,
    {
      region,
      realmSpecific: false,
      dualStack: false,
      env: io.env,
      regionMetadata,
    },
  );
  const refreshUrl = `${authEndpoint}/v1/authentication/refresh`;
  io.err(`Attempting to refresh token from ${refreshUrl}\n`);

  const body = JSON.stringify({ currentToken: token });
  const req = {
    method: "POST",
    url: refreshUrl,
    headers: {
      "content-type": "application/json",
    } as Record<string, string>,
    body,
  };
  prepareContentLength(req);
  signRequest(req, { keyId: `ST$${token}`, privateKey }, true);

  const transport = fetchTransportFromEnv(refreshUrl, io.env, io.cwd);
  const init: RequestInit & { proxy?: string; tls?: { ca: string } } = {
    method: req.method,
    headers: req.headers,
    body: req.body,
    ...transport,
  };
  const response = await fetch(req.url, init);
  const raw = await response.text();

  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      io.err(
        `JSONDecodeError: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      throw new Exit(1);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("token" in parsed)
    ) {
      io.err("KeyError: 'token'\n");
      throw new Exit(1);
    }
    const refreshedToken = String(
      (parsed as Record<string, unknown>).token ?? "",
    );
    writeFileSync(resolvedTokenPath, refreshedToken, "utf8");
    applyUserOnlyAccessPermissions(resolvedTokenPath);
    io.err("Successfully refreshed token\n");
    return;
  }

  if (response.status === 401) {
    io.err(
      "Your session is no longer valid and cannot be refreshed. Please use 'oci session authenticate' to create a new session.\n",
    );
    throw new Exit(1);
  }

  // Reference CLI (oci-cli 3.96.3) writes this message to stdout with the 'sesison' spelling.
  io.out(`ERROR: Failed to refresh sesison. Error: ${raw}\n`);
  throw new Exit(1);
}

const ZIP_FILE_FORMAT = "zip";
const CONFIG_KEY_FILE_SUFFIX = "_file";
const TOKEN_FILE_SUFFIX = "_token";

const isSessionFileKey = (key: string): boolean =>
  key.endsWith(CONFIG_KEY_FILE_SUFFIX) || key.endsWith(TOKEN_FILE_SUFFIX);

/** POSIX `os.path.basename`: unlike `node:path.basename`, `'a/b/'` yields `''`. */
function posixBasename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Port of `cli_session.translate_config_filepaths_to_prefix`. */
export function translateConfigFilepathsToPrefix(
  config: Map<string, string>,
  prefix = "",
): Map<string, string> {
  const translated = new Map<string, string>();
  for (const [key, value] of config) {
    if (isSessionFileKey(key)) {
      const base = posixBasename(value);
      translated.set(
        key,
        prefix ? `${prefix.replace(/[\\/]+$/, "")}/${base}` : base,
      );
    } else {
      translated.set(key, value);
    }
  }
  return translated;
}

/** Port of CPython `ConfigParser.write` (default `space_around_delimiters=True`) for one section. */
export function formatConfigSection(
  profile: string,
  entries: Map<string, string>,
): string {
  let out = `[${profile}]\n`;
  for (const [key, value] of entries) {
    const formatted = value
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replaceAll("\n", "\n\t");
    out += `${key} = ${formatted}\n`;
  }
  out += "\n";
  return out;
}

/** `oci session export --output-file <path> [--force]` (port of `cli_session.export`). */
export async function runSessionExport(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    settings: ClientSettings;
  },
): Promise<void> {
  const { values, settings } = opts;
  const configFile = expandUser(settings.configFile, io.env);
  const profile = settings.profile;

  const resolvedConfigPath = resolve(io.cwd, configFile);
  let profileMap: Map<string, string | null> | undefined;
  const configText = readConfigFile(resolvedConfigPath) ?? undefined;

  if (configText === undefined) {
    profileMap = profile === "DEFAULT" ? new Map() : undefined;
  } else {
    try {
      const parsed = parseConfig(configText, configFile);
      profileMap = sectionItems(parsed, profile);
    } catch (e) {
      if (e instanceof ConfigParserError) {
        io.err(`${e.type}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
  }

  if (!profileMap) {
    io.err(`KeyError: '${profile}'\n`);
    throw new Exit(1);
  }

  const profileToExport = new Map<string, string>();
  for (const [k, v] of profileMap) {
    profileToExport.set(k, v ?? "");
  }

  if (!profileToExport.has("security_token_file")) {
    io.err(
      "ERROR: Specified profile is not a valid token profile. Please specify valid token profile with --profile\n",
    );
    throw new Exit(1);
  }

  const outputFile = String(values.output_file ?? "");
  const force = values.force === true;
  const zipFilename = `${outputFile}.${ZIP_FILE_FORMAT}`;
  const resolvedZipPath = resolve(io.cwd, zipFilename);

  if (existsSync(resolvedZipPath) && !force) {
    const confirmed = await confirmUnderWrapExceptions(
      io,
      `File ${zipFilename} already exists, do you want to overwrite it?`,
      false,
    );
    if (!confirmed) {
      io.err("Export canceled.\n");
      return;
    }
  }

  io.err(`Exporting profile: ${profile} from config file: ${configFile}\n`);

  const translated = translateConfigFilepathsToPrefix(profileToExport);
  const exportedConfig = formatConfigSection(profile, translated);
  const archiveEntries = new Map<string, ZipEntryInput>();
  archiveEntries.set("config", {
    name: "config",
    data: Buffer.from(exportedConfig, "utf8"),
    mode: 0o100644,
  });

  for (const [key, value] of profileToExport) {
    if (!isSessionFileKey(key)) continue;
    const expanded = expandUser(value, io.env);
    if (!expanded) {
      io.err("FileNotFoundError: [Errno 2] No such file or directory: ''\n");
      throw new Exit(1);
    }
    const diskPath = resolve(io.cwd, expanded);
    let data: Buffer;
    let mode: number;
    let mtime: Date;
    try {
      const st = statSync(diskPath);
      if (st.isDirectory()) {
        io.err(`IsADirectoryError: [Errno 21] Is a directory: '${expanded}'\n`);
        throw new Exit(1);
      }
      data = readFileSync(diskPath);
      mode = (st.mode & ~0o777) | getPosixMode(diskPath);
      mtime = st.mtime;
    } catch (e) {
      if (e instanceof Exit) throw e;
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        io.err(
          `FileNotFoundError: [Errno 2] No such file or directory: '${expanded}'\n`,
        );
        throw new Exit(1);
      }
      if (code === "EISDIR") {
        io.err(`IsADirectoryError: [Errno 21] Is a directory: '${expanded}'\n`);
        throw new Exit(1);
      }
      throw e;
    }
    const entryName = posixBasename(expanded);
    archiveEntries.set(entryName, {
      name: entryName,
      data,
      mode,
      mtime,
    });
  }

  const archiveDir = dirname(resolvedZipPath);
  if (archiveDir && !existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  writeZipFile(resolvedZipPath, [...archiveEntries.values()]);
  io.err(`Export file written to: ${normalizePosixPath(resolvedZipPath)}\n`);
}

const SESSION_PROFILE_NAME_PATTERN = /^[A-Za-z0-9._\-@]+$/;

/** Port of `cli_session.validate_profile_name` under `@cli_util.wrap_exceptions`. */
function validateSessionProfileName(io: Invocation, profileName: string): void {
  if (!profileName) {
    io.err("UsageError: Profile name must be a non-empty string.\n");
    throw new Exit(1);
  }
  if (!SESSION_PROFILE_NAME_PATTERN.test(profileName)) {
    io.err(
      `UsageError: Invalid profile name '${profileName}'. Profile names may only contain letters, numbers, '.', '_', '-', or '@'.\n`,
    );
    throw new Exit(1);
  }
  if (profileName === "." || profileName === "..") {
    io.err(
      `UsageError: Invalid profile name '${profileName}': Profile name cannot be '.' or '..'.\n`,
    );
    throw new Exit(1);
  }
}

/** Port of `click.prompt(text)` (no default) under `@cli_util.wrap_exceptions`. */
async function promptUnderWrapExceptions(
  io: Invocation,
  stdin: StdinReader,
  text: string,
): Promise<string> {
  const prompt = `${text}: `;
  while (true) {
    io.out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err("Abort: \n");
      throw new Exit(1);
    }
    if (line) return line;
  }
}

/** Match CPython `zipfile.ZipFile._extract_member` relative path normalization. */
function normalizeZipMemberPath(name: string): string {
  const parts = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.join("/");
}

/** `oci session import --session-archive <path> [--force]` (port of `cli_session.import_session`). */
export async function runSessionImport(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    settings: ClientSettings;
  },
): Promise<void> {
  const { values, settings } = opts;
  const sessionArchive = String(values.session_archive ?? "");
  const force = values.force === true;
  const resolvedArchivePath = resolve(io.cwd, sessionArchive);

  if (!existsSync(resolvedArchivePath)) {
    io.err(`File ${sessionArchive} does not exist.\n`);
    throw new Exit(1);
  }

  const configFile = expandUser(settings.configFile, io.env);
  const resolvedConfigPath = resolve(io.cwd, configFile);
  const configText = readConfigFile(resolvedConfigPath) ?? undefined;

  const currentProfiles = new Set<string>(["DEFAULT"]);
  if (configText !== undefined) {
    try {
      const parsed = parseConfig(configText, configFile);
      for (const section of parsed.sections.keys()) {
        currentProfiles.add(section);
      }
    } catch (e) {
      if (e instanceof ConfigParserError) {
        io.err(`${e.type}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
  }

  let archiveBytes: Buffer;
  try {
    const st = statSync(resolvedArchivePath);
    if (st.isDirectory()) {
      io.err(
        `IsADirectoryError: [Errno 21] Is a directory: '${sessionArchive}'\n`,
      );
      throw new Exit(1);
    }
    archiveBytes = readFileSync(resolvedArchivePath);
  } catch (e) {
    if (e instanceof Exit) throw e;
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EISDIR") {
      io.err(
        `IsADirectoryError: [Errno 21] Is a directory: '${sessionArchive}'\n`,
      );
      throw new Exit(1);
    }
    throw e;
  }

  let zipEntries: ReturnType<typeof readZip>;
  try {
    zipEntries = readZip(archiveBytes);
  } catch (e) {
    if (e instanceof BadZipFileError) {
      io.err(`BadZipFile: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }

  const extracted = new Map<string, Buffer>();
  for (const entry of zipEntries) {
    if (entry.name.endsWith("/")) continue;
    const norm = normalizeZipMemberPath(entry.name);
    if (norm) extracted.set(norm, entry.data);
  }

  const archivedConfigBytes = extracted.get("config");
  if (!archivedConfigBytes) {
    io.err(
      `Session archive ${sessionArchive} is invalid. Did not contain file 'config'.\n`,
    );
    throw new Exit(1);
  }

  let archivedConfig: ReturnType<typeof parseConfig>;
  try {
    archivedConfig = parseConfig(
      archivedConfigBytes.toString("utf8"),
      "config",
    );
  } catch (e) {
    if (e instanceof ConfigParserError) {
      io.err(`${e.type}: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }

  const archivedProfiles = ["DEFAULT", ...archivedConfig.sections.keys()];
  let archivedProfileName = archivedProfiles[archivedProfiles.length - 1]!;
  const rawArchivedProfile = sectionItems(archivedConfig, archivedProfileName)!;
  const archivedProfile = new Map<string, string>();
  for (const [k, v] of rawArchivedProfile) {
    archivedProfile.set(k, v ?? "");
  }

  validateSessionProfileName(io, archivedProfileName);

  if (!archivedProfile.has("security_token_file")) {
    io.err(
      "ERROR: Cannot import non token based profile (profile must contain value for security_token_file).\n",
    );
    throw new Exit(1);
  }

  if (force) {
    try {
      removeProfileFromConfig(
        resolvedConfigPath,
        configFile,
        archivedProfileName,
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        io.err(
          `FileNotFoundError: [Errno 2] No such file or directory: '${configFile}'\n`,
        );
        throw new Exit(1);
      }
      throw e;
    }
  }

  let stdin: StdinReader | undefined;
  while (currentProfiles.has(archivedProfileName) && !force) {
    stdin ??= createStdinReader(io);
    archivedProfileName = await promptUnderWrapExceptions(
      io,
      stdin,
      `Config already contains a profile with the same name as the archived profile: ${archivedProfileName}. Provide an alternative name for the imported profile`,
    );
    validateSessionProfileName(io, archivedProfileName);
  }

  const defaultTokenDirectory = `${expandUser("~", io.env).replace(/[\\/]+$/, "")}/.oci/sessions`;
  const importedResourcesDir = `${defaultTokenDirectory}/${archivedProfileName}`;
  const resolvedTokenDir = normalizePosixPath(resolve(defaultTokenDirectory));
  const resolvedResourcesDir = normalizePosixPath(
    resolve(importedResourcesDir),
  );
  if (
    resolvedResourcesDir !== resolvedTokenDir &&
    !resolvedResourcesDir.startsWith(`${resolvedTokenDir}/`)
  ) {
    io.out(
      `ERROR: Invalid profile name: ${archivedProfileName} in session-archive. Attempted to create a session outside ${defaultTokenDirectory}\n`,
    );
    throw new Exit(1);
  }

  if (!existsSync(importedResourcesDir)) {
    mkdirSync(importedResourcesDir, { recursive: true });
  }

  for (const [key, value] of archivedProfile) {
    if (!isSessionFileKey(key)) continue;
    const normalizedRef = normalizeZipMemberPath(value);
    const data = normalizedRef ? extracted.get(normalizedRef) : undefined;
    if (!data) {
      io.err(
        `FileNotFoundError: [Errno 2] No such file or directory: '${value}'\n`,
      );
      throw new Exit(1);
    }
    const destPath = `${importedResourcesDir}/${posixBasename(value)}`;
    writeFileSync(destPath, data);
    applyUserOnlyAccessPermissions(`${importedResourcesDir}/${value}`);
  }

  const translated = translateConfigFilepathsToPrefix(
    archivedProfile,
    importedResourcesDir,
  );
  try {
    writeConfig(resolvedConfigPath, {
      userId: translated.get("user_id"),
      fingerprint: translated.get("fingerprint"),
      keyFile: translated.get("key_file"),
      tenancy: translated.get("tenancy"),
      region: translated.get("region"),
      passPhrase: translated.get("pass_phrase"),
      profileName: archivedProfileName,
      securityTokenFile: translated.get("security_token_file"),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      io.err(
        `FileNotFoundError: [Errno 2] No such file or directory: '${configFile}'\n`,
      );
      throw new Exit(1);
    }
    throw e;
  }

  io.err(`Imported profile ${archivedProfileName} written to: ${configFile}\n`);
  io.out(
    `\n    Try out your newly imported session credentials with the following example command:\n\n    oci iam region list --config-file ${configFile} --profile ${archivedProfileName} --auth security_token\n\n`,
  );
}

const BOOTSTRAP_SERVICE_PORT = 8181;
const OCI_CLI_UPST_TOKEN_MAX_TTL = 60;
const OCI_CLI_UPST_TOKEN_MIN_TTL = 5;

const IDENTITY_DATA_PLANE_CLIENT: Record<string, unknown> = {
  basePath: "/v1",
  endpointTemplate: "https://auth.{region}.{secondLevelDomain}",
  endpointTemplatePerRealm: {},
  serviceName: "dataplane",
  regionalClient: true,
};

const AUTH_CALLBACK_HTML = `
            <script type='text/javascript'>
                hash = window.location.hash

                // remove leading '#' so that python can detect it
                if (hash[0] === '#') {
                    hash = hash.substr(1)
                }

                console.log(hash)

                function reqListener () {
                    console.log(this.responseText);
                    document.write('Authorization completed! Please close this window and return to your terminal to finish the bootstrap process.')
                }

                var oReq = new XMLHttpRequest();
                oReq.addEventListener("load", reqListener);
                oReq.open("GET", "/token?" + hash);
                oReq.send();
            </script>
            `;

type UserSession = {
  userOcid: string;
  tenancyOcid: string;
  region: string;
  token: string;
  publicKey: KeyObject;
  privateKey: KeyObject | null;
  fingerprint: string;
};

function profileNameError(profileName: string): string | null {
  if (!profileName) {
    return "Profile name must be a non-empty string.";
  }
  if (!SESSION_PROFILE_NAME_PATTERN.test(profileName)) {
    return `Invalid profile name '${profileName}'. Profile names may only contain letters, numbers, '.', '_', '-', or '@'.`;
  }
  if (profileName === "." || profileName === "..") {
    return `Invalid profile name '${profileName}': Profile name cannot be '.' or '..'.`;
  }
  return null;
}

/** Port of `cli_session.get_oci_cli_profile_env_var_error` + `cli_profile_util.load_config`. */
function getOciCliProfileEnvVarError(
  io: Invocation,
  configFile: string,
  profileName: string,
): string | null {
  const nameErr = profileNameError(profileName);
  if (nameErr) return nameErr;

  const resolvedPath = configPath(configFile, io.env, io.cwd);
  const diskPath = resolve(io.cwd, resolvedPath);
  const text = readConfigFile(diskPath);
  if (text === null) {
    return `Config file not found: ${resolvedPath}`;
  }

  let parsed: ReturnType<typeof parseConfig>;
  try {
    parsed = parseConfig(text, resolvedPath);
  } catch (e) {
    if (e instanceof ConfigParserError) {
      return `Could not read config file ${resolvedPath}: ${e.message}`;
    }
    throw e;
  }

  const exists =
    profileName === DEFAULT_PROFILE
      ? parsed.defaults.size > 0
      : parsed.sections.has(profileName);
  if (!exists) {
    return `Profile '${profileName}' not found in config file ${resolvedPath}`;
  }
  return null;
}

/** Port of `cli_setup_bootstrap.get_console_auth_url`. */
export function getConsoleAuthUrl(
  region: string,
  regions: RegionsSpec,
  enableDualStack = false,
  realmOverride?: { realmKey: string; realmDomainComponent: string },
): string {
  const lower = region.toLowerCase();
  const realmKey = realmOverride?.realmKey ?? regions.regionRealms[lower] ?? "";
  const realmDomain =
    realmOverride?.realmDomainComponent ?? regions.realms[realmKey] ?? "";
  if (enableDualStack && realmKey === "oc1") {
    return `https://login.${region}.ds.oci.${realmDomain}/v1/oauth2/authorize`;
  }
  return `https://login.${region}.${realmDomain}/v1/oauth2/authorize`;
}

/** Port of `cli_util.get_public_key_from_file` (rejects non-public PEM keys). */
function loadPemPublicKeyFromFile(diskPath: string): KeyObject {
  const raw = readFileSync(diskPath, "utf8");
  if (!/-----BEGIN [A-Z0-9 ]*PUBLIC KEY-----/.test(raw)) {
    throw new Error("Not a PEM public key");
  }
  return createPublicKey({ key: raw, format: "pem" });
}

/** Parse Python `int(s)` (base 10) for `--session-expiration-in-minutes`. */
function parsePythonInt(io: Invocation, value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    io.err(
      `ValueError: invalid literal for int() with base 10: ${pyRepr(value)}\n`,
    );
    throw new Exit(1);
  }
  return Number.parseInt(trimmed, 10);
}

/** Port of `cli_setup.prompt_session_for_profile`. */
async function promptSessionForProfile(
  io: Invocation,
  stdin: StdinReader,
  defaultConfigLocation: string,
): Promise<string> {
  const diskConfigPath = resolve(io.cwd, defaultConfigLocation);
  if (!existsSync(diskConfigPath)) {
    return DEFAULT_PROFILE_NAME;
  }
  let parsed: ReturnType<typeof parseConfig>;
  try {
    parsed = parseConfig(
      readConfigFile(diskConfigPath) ?? "",
      defaultConfigLocation,
    );
  } catch (e) {
    if (e instanceof ConfigParserError) {
      return DEFAULT_PROFILE_NAME;
    }
    throw e;
  }
  const enteredName = await promptUnderWrapExceptions(
    io,
    stdin,
    "Enter the name of the profile you would like to create",
  );
  validateSessionProfileName(io, enteredName);
  const sections = [...parsed.sections.keys()].map((s) => s.toUpperCase());
  if (parsed.defaults.size > 0) sections.push(DEFAULT_PROFILE_NAME);
  const enteredUpper = enteredName.toUpperCase();
  if (sections.includes(enteredUpper)) {
    io.out(
      `Profile ${enteredUpper} already exists in config. Cannot specify a profile that conflicts with any existing profile(s): ${sections.join(", ")}\n`,
    );
  }
  return enteredName;
}

/** Port of `cli_setup_bootstrap.create_user_session`. */
async function createBrowserUserSession(
  io: Invocation,
  stdin: StdinReader,
  opts: {
    region: string;
    tenancyName?: string;
    identityProviderName?: string;
    enableDualStack: boolean;
    regions: RegionsSpec;
    regionDisplayOrder: string[];
    port: number;
    openBrowserFn: (url: string, env: Env) => boolean;
  },
): Promise<UserSession> {
  let region = opts.region;
  if (region === "") {
    region = await promptForRegion(io, stdin, opts.regions, true);
  }

  let resolveToken!: (token: string) => void;
  const tokenPromise = new Promise<string>((resolveFn) => {
    resolveToken = resolveFn;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port,
      hostname: "0.0.0.0",
      fetch(req) {
        const reqUrl = new URL(req.url);
        if (reqUrl.pathname === "/") {
          return new Response(AUTH_CALLBACK_HTML, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              connection: "close",
            },
          });
        }
        const securityToken = reqUrl.searchParams.get("security_token");
        if (securityToken) {
          setTimeout(() => resolveToken(securityToken), 10);
        }
        return new Response("", {
          status: 200,
          headers: { connection: "close" },
        });
      },
    });
  } catch (e) {
    const err = e as { code?: string; errno?: number; message?: string };
    if (
      err?.code === "EADDRINUSE" ||
      err?.code === "FailedToOpenSocket" ||
      err?.message?.toLowerCase().includes("port")
    ) {
      io.out(
        `Could not complete bootstrap process because port ${opts.port} is already in use.\n`,
      );
      throw new Exit(1);
    }
    throw e;
  }

  try {
    const { privateKey, publicKey } = generateKey();
    const fingerprint = publicKeyToFingerprint(publicKey);
    const jwkContent = toJwk(publicKey);
    const publicKeyJwk = Buffer.from(jwkContent, "utf8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_");

    if (region in opts.regions.shortNames) {
      region = opts.regions.shortNames[region]!;
    }

    const lowerRegion = region.toLowerCase();
    const isBuiltInRegion =
      !(lowerRegion in opts.regions.shortNames) &&
      opts.regions.regions.includes(lowerRegion);
    const externalMeta = isBuiltInRegion
      ? undefined
      : await loadExternalRegionMetadata(region, opts.regions, io.env);

    if (!isBuiltInRegion && !externalMeta) {
      const validList = opts.regionDisplayOrder.map((r) => `'${r}'`).join(", ");
      io.out(
        `Error: ${region} is not a valid region. Valid regions are \n[${validList}]\n`,
      );
      throw new Exit(1);
    }

    const consoleUrl = getConsoleAuthUrl(
      region,
      opts.regions,
      opts.enableDualStack,
      externalMeta
        ? {
            realmKey: externalMeta.realmKey,
            realmDomainComponent: externalMeta.realmDomainComponent,
          }
        : undefined,
    );

    const query = new URLSearchParams();
    query.set("action", "login");
    query.set("client_id", "iaas_console");
    query.set("response_type", "token id_token");
    query.set("nonce", randomUUID());
    query.set("scope", "openid");
    query.set("public_key", publicKeyJwk);
    query.set("redirect_uri", `http://localhost:${opts.port}`);
    if (opts.tenancyName) {
      query.set("tenant", opts.tenancyName);
    }
    if (opts.identityProviderName) {
      query.set("provider", opts.identityProviderName);
    }

    const authUrl = `${consoleUrl}?${query.toString()}`;
    if (opts.openBrowserFn(authUrl, io.env)) {
      io.out("    Please switch to newly opened browser window to log in!\n");
      io.out(
        "    You can also open the following URL in a web browser window to continue:\n",
      );
      io.out(`${authUrl}\n`);
    } else {
      io.out(
        "    Open the following URL in a web browser window to continue:\n",
      );
      io.out(`${authUrl}\n`);
    }

    const token = await tokenPromise;
    io.out("    Completed browser authentication process!\n");

    let tokenData: Record<string, unknown>;
    try {
      tokenData = decodeSecurityToken(token);
    } catch (e) {
      if (e instanceof SecurityTokenDecodeError) {
        io.err(`${e.name}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
    if (!("sub" in tokenData)) {
      io.err("KeyError: 'sub'\n");
      throw new Exit(1);
    }
    if (!("tenant" in tokenData)) {
      io.err("KeyError: 'tenant'\n");
      throw new Exit(1);
    }

    return {
      userOcid: String(tokenData.sub),
      tenancyOcid: String(tokenData.tenant),
      region,
      token,
      publicKey,
      privateKey,
      fingerprint,
    };
  } finally {
    await server.stop();
  }
}

/** Port of `cli_setup_bootstrap.persist_user_session` for `session authenticate`. */
async function persistUserSession(
  io: Invocation,
  stdin: StdinReader,
  userSession: UserSession,
  opts: {
    profileName?: string;
    configLocation?: string;
    tokenLocation?: string;
    usePassphrase: boolean;
    persistOnlyPublicKey: boolean;
  },
): Promise<{ profileName: string; configLocation: string }> {
  const defaultOciDir = `${expandUser("~", io.env).replace(/[\\/]+$/, "")}/.oci`;
  const defaultConfigLocation = `${defaultOciDir}/config`;
  const defaultTokenDir = `${defaultOciDir}/sessions`;

  let profileName = opts.profileName;
  if (!profileName) {
    profileName = await promptSessionForProfile(
      io,
      stdin,
      defaultConfigLocation,
    );
  }
  const configLocation = opts.configLocation || defaultConfigLocation;
  const tokenDir = opts.tokenLocation ?? defaultTokenDir;

  const sessionAuthLocation = resolve(
    io.cwd,
    `${tokenDir.replace(/[\\/]+$/, "")}/${profileName}`,
  );
  if (!existsSync(sessionAuthLocation)) {
    createDirectory(sessionAuthLocation);
  }

  const publicKeyFilePath = `${sessionAuthLocation}/${DEFAULT_KEY_NAME}${PUBLIC_KEY_FILENAME_SUFFIX}`;
  const privateKeyFilePath = `${sessionAuthLocation}/${DEFAULT_KEY_NAME}${PRIVATE_KEY_FILENAME_SUFFIX}`;

  writeFileSync(publicKeyFilePath, serializePublicKey(userSession.publicKey));
  applyUserOnlyAccessPermissions(publicKeyFilePath);

  let keyPassphrase: string | null = null;
  if (opts.usePassphrase) {
    keyPassphrase = await promptForPassphrase(io, stdin, true);
  }

  if (!opts.persistOnlyPublicKey && userSession.privateKey) {
    writeFileSync(
      privateKeyFilePath,
      `${serializePrivateKey(userSession.privateKey, keyPassphrase)}${PRIVATE_KEY_LABEL}`,
    );
    applyUserOnlyAccessPermissions(privateKeyFilePath);
  }

  const tokenFilePath = `${sessionAuthLocation}/token`;
  writeFileSync(tokenFilePath, userSession.token, "utf8");
  applyUserOnlyAccessPermissions(tokenFilePath);

  const resolvedConfigPath = resolve(io.cwd, configLocation);
  removeProfileFromConfig(resolvedConfigPath, configLocation, profileName);

  if (
    keyPassphrase &&
    !(await confirmClick(
      io,
      stdin,
      "Do you want to write your passphrase to the config file? (If not, you will need to enter it when prompted each time you run an oci command)",
      false,
      true,
    ))
  ) {
    keyPassphrase = null;
  }

  writeConfig(resolvedConfigPath, {
    userId: null,
    fingerprint: userSession.fingerprint,
    keyFile: opts.persistOnlyPublicKey
      ? "Update_private_key_path"
      : privateKeyFilePath,
    tenancy: userSession.tenancyOcid,
    region: userSession.region,
    passPhrase: keyPassphrase,
    profileName,
    securityTokenFile: tokenFilePath,
  });

  return { profileName, configLocation };
}

/** `oci session authenticate` (port of `cli_session.authenticate`). */
export async function runSessionAuthenticate(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    rootValues: Record<string, unknown>;
    settings: ClientSettings;
    rc: Rc;
    index: Pick<Index, "regions">;
    spec?: Pick<ServiceSpec, "commands">;
    browserPort?: number;
    openBrowserFn?: (url: string, env: Env) => boolean;
  },
): Promise<void> {
  const { values, rootValues, rc, index } = opts;
  let effectiveSettings: ClientSettings = { ...opts.settings };
  const stdin = createStdinReader(io);

  let region: string | undefined =
    typeof rootValues.region === "string" && rootValues.region
      ? rootValues.region
      : io.env.OCI_CLI_REGION;
  if (region === undefined) {
    region = await promptForRegion(io, stdin, index.regions, true);
  }

  // prompt_to_use_oci_cli_profile
  let profileName =
    typeof values.profile_name === "string" && values.profile_name
      ? values.profile_name
      : undefined;
  const envProfile =
    io.env.OCI_CLI_PROFILE &&
    io.env.OCI_CLI_PROFILE === effectiveSettings.profile
      ? io.env.OCI_CLI_PROFILE
      : undefined;
  const ignoreEnvProfile = () => {
    effectiveSettings = {
      ...effectiveSettings,
      profile: rc.settings.default_profile ?? DEFAULT_PROFILE,
    };
  };

  if (profileName) {
    validateSessionProfileName(io, profileName);
    if (
      envProfile &&
      getOciCliProfileEnvVarError(io, effectiveSettings.configFile, envProfile)
    ) {
      ignoreEnvProfile();
    }
  } else if (envProfile) {
    const envProfileError = getOciCliProfileEnvVarError(
      io,
      effectiveSettings.configFile,
      envProfile,
    );
    const useEnvProfile = await confirmClick(
      io,
      stdin,
      `OCI_CLI_PROFILE is set to '${envProfile}'. Do you want to use this profile for the new session?`,
      true,
      true,
    );
    if (useEnvProfile && !envProfileError) {
      profileName = envProfile;
    } else if (envProfileError) {
      ignoreEnvProfile();
      if (useEnvProfile) {
        io.err(
          `WARNING: Cannot use profile '${envProfile}' from OCI_CLI_PROFILE for session authentication: ${envProfileError}. Continuing with the default session authentication flow.\n`,
        );
      }
    }
  }

  let persistOnlyPublicKey = false;
  const defaultTokenDir = `${expandUser("~", io.env).replace(/[\\/]+$/, "")}/.oci/sessions`;
  const tokenLocation =
    typeof values.token_location === "string"
      ? values.token_location
      : defaultTokenDir;

  let userSession: UserSession;
  if (values.no_browser === true) {
    const expRaw =
      values.session_expiration_in_minutes !== undefined &&
      values.session_expiration_in_minutes !== null
        ? String(values.session_expiration_in_minutes)
        : String(OCI_CLI_UPST_TOKEN_MAX_TTL);
    const expInt = parsePythonInt(io, expRaw);
    if (expInt > OCI_CLI_UPST_TOKEN_MAX_TTL) {
      io.out("Session expiration cannot be longer than 60 minutes\n");
      throw new Exit(1);
    }
    if (expInt < OCI_CLI_UPST_TOKEN_MIN_TTL) {
      io.out("Session expiration cannot be shorter than 5 minutes\n");
      throw new Exit(1);
    }

    const sc = await createServiceClient(io, {
      client: IDENTITY_DATA_PLANE_CLIENT,
      values,
      rootValues,
      settings: effectiveSettings,
      index,
    });

    const expandedTokenDir = resolve(io.cwd, expandUser(tokenLocation, io.env));
    mkdirSync(expandedTokenDir, { recursive: true });

    let publicKey: KeyObject;
    let privateKey: KeyObject | null;
    const publicKeyFilePath =
      typeof values.public_key_file_path === "string" &&
      values.public_key_file_path
        ? values.public_key_file_path
        : undefined;
    if (publicKeyFilePath) {
      persistOnlyPublicKey = true;
      try {
        publicKey = loadPemPublicKeyFromFile(
          resolve(io.cwd, publicKeyFilePath),
        );
      } catch {
        io.out(
          "Could not load public key from public-key-file-path provided\n",
        );
        throw new Exit(1);
      }
      privateKey = null;
    } else {
      const pair = generateKey();
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
    }

    const fingerprint = publicKeyToFingerprint(publicKey);
    const publicKeySerialized = serializePublicKey(publicKey);
    const body = JSON.stringify({
      publicKey: publicKeySerialized,
      sessionExpirationInMinutes: expRaw,
    });

    const { url, response, raw } = await sendServiceRequest(io, sc, {
      method: "POST",
      pathTemplate: "/token/upst/actions/GenerateUpst",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      io.err(
        formatServiceError(
          { http: "POST", method: "generate_user_security_token" },
          url,
          response,
          raw,
          sc.targetService,
        ),
      );
      throw new Exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      io.err(
        `JSONDecodeError: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      throw new Exit(1);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("token" in parsed)
    ) {
      io.err("KeyError: 'token'\n");
      throw new Exit(1);
    }
    const token = String((parsed as Record<string, unknown>).token ?? "");
    let tokenData: Record<string, unknown>;
    try {
      tokenData = decodeSecurityToken(token);
    } catch (e) {
      if (e instanceof SecurityTokenDecodeError) {
        io.err(`${e.name}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
    if (!("sub" in tokenData)) {
      io.err("KeyError: 'sub'\n");
      throw new Exit(1);
    }
    if (!("tenant" in tokenData)) {
      io.err("KeyError: 'tenant'\n");
      throw new Exit(1);
    }

    userSession = {
      userOcid: String(tokenData.sub),
      tenancyOcid: String(tokenData.tenant),
      region,
      token,
      publicKey,
      privateKey,
      fingerprint,
    };
  } else {
    const enableDualStack = rootValues.enable_dual_stack === true;
    const regionHelp = opts.spec?.commands.authenticate?.helpDoc.records.find(
      ([opt]) => opt.startsWith("--region"),
    )?.[1];
    const regionDisplayOrder = regionHelp
      ? regionHelp.split(",").filter(Boolean)
      : index.regions.regions;
    userSession = await createBrowserUserSession(io, stdin, {
      region,
      tenancyName:
        typeof values.tenancy_name === "string" && values.tenancy_name
          ? values.tenancy_name
          : undefined,
      identityProviderName:
        typeof values.identity_provider_name === "string" &&
        values.identity_provider_name
          ? values.identity_provider_name
          : undefined,
      enableDualStack,
      regions: index.regions,
      regionDisplayOrder,
      port: opts.browserPort ?? BOOTSTRAP_SERVICE_PORT,
      openBrowserFn: opts.openBrowserFn ?? openBrowser,
    });
  }

  const persisted = await persistUserSession(io, stdin, userSession, {
    profileName,
    configLocation:
      typeof values.config_location === "string" && values.config_location
        ? values.config_location
        : undefined,
    tokenLocation,
    usePassphrase: values.use_passphrase === true,
    persistOnlyPublicKey,
  });

  io.out(`Config written to: ${persisted.configLocation}\n`);
  io.out(
    `\n    Try out your newly created session credentials with the following example command:\n\n    oci iam region list --config-file ${persisted.configLocation} --profile ${persisted.profileName} --auth security_token\n\n`,
  );
}

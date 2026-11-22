// Custom `oci session` commands (port of oci_cli/cli_session.py).
import type { KeyObject } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Config,
  ConfigError,
  configPath,
  expandUser,
  fromFile,
} from "./config.ts";
import {
  ConfigParserError,
  parseConfig,
  sectionItems,
} from "./configparser.ts";
import { loadExternalRegionMetadata, resolveEndpoint } from "./endpoint.ts";
import { type Env, Exit, type Invocation } from "./io.ts";
import {
  type ClientSettings,
  applyConfigEnvVars,
  confirmUnderWrapExceptions,
  createServiceClient,
  promptFromStdin,
  sendServiceRequest,
  warnFilePermissions,
} from "./operation.ts";
import { formatServiceError } from "./output.ts";
import {
  type StdinReader,
  applyUserOnlyAccessPermissions,
  createStdinReader,
  removeProfileFromConfig,
  writeConfig,
} from "./setup.ts";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "./signer.ts";
import { type Index, loadService } from "./spec.ts";
import {
  BadZipFileError,
  type ZipEntryInput,
  readZip,
  writeZipFile,
} from "./zip.ts";

export class SecurityTokenDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export class SecurityTokenKeyError extends Error {
  constructor(key: string) {
    super(`'${key}'`);
    this.name = "KeyError";
  }
}

function decodeBase64UrlSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new SecurityTokenDecodeError("Invalid padding");
  }
  const rem = segment.length % 4;
  if (rem === 1) {
    throw new SecurityTokenDecodeError("Invalid padding");
  }
  const padded = rem === 0 ? segment : segment + "=".repeat(4 - rem);
  return Buffer.from(
    padded.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
}

/**
 * Port of `oci.auth.security_token_container.SecurityTokenContainer(None, token)`
 * (`jwt.decode(jwt=security_token, options={"verify_signature": False})`).
 */
export function decodeSecurityToken(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new SecurityTokenDecodeError("Not enough segments");
  }
  const [headerSeg, payloadSeg] = parts as [string, string, string];
  let header: unknown;
  try {
    header = JSON.parse(decodeBase64UrlSegment(headerSeg).toString("utf8"));
  } catch {
    throw new SecurityTokenDecodeError("Invalid header string");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new SecurityTokenDecodeError(
      "Invalid header string: must be a json object",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlSegment(payloadSeg).toString("utf8"));
  } catch {
    throw new SecurityTokenDecodeError("Invalid payload string");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SecurityTokenDecodeError(
      "Invalid payload string: must be a json object",
    );
  }
  return payload as Record<string, unknown>;
}

/** Port of `SecurityTokenContainer.valid()`: `not (int(time.time()) > self.jwt['exp'])`. */
export function isSecurityTokenValid(
  jwtPayload: Record<string, unknown>,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!("exp" in jwtPayload) || jwtPayload.exp === undefined) {
    throw new SecurityTokenKeyError("exp");
  }
  return !(nowEpochSeconds > Number(jwtPayload.exp));
}

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

/** Check whether `hostname` matches a comma-separated NO_PROXY / no_proxy list. */
export function isNoProxyHost(hostname: string, noProxy?: string): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const withoutPort = entry.includes(":")
      ? (entry.split(":")[0] ?? entry)
      : entry;
    const bare = withoutPort.startsWith(".")
      ? withoutPort.slice(1)
      : withoutPort;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Resolve proxy URL and custom CA bundle from invocation env (mirrors Python requests). */
export function fetchTransportFromEnv(
  url: string,
  env: Env,
  cwd: string,
): { proxy?: string; tls?: { ca: string } } {
  const parsed = new URL(url);
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  let proxy: string | undefined;
  if (!isNoProxyHost(parsed.hostname, noProxy)) {
    const raw =
      parsed.protocol === "https:"
        ? (env.HTTPS_PROXY ?? env.https_proxy)
        : (env.HTTP_PROXY ?? env.http_proxy);
    if (raw) proxy = raw;
  }
  const caPath = env.REQUESTS_CA_BUNDLE ?? env.CURL_CA_BUNDLE;
  let tls: { ca: string } | undefined;
  if (caPath) {
    const resolvedCa = resolve(cwd, expandUser(caPath, env));
    if (existsSync(resolvedCa)) {
      tls = { ca: readFileSync(resolvedCa, "utf8") };
    }
  }
  return {
    ...(proxy ? { proxy } : {}),
    ...(tls ? { tls } : {}),
  };
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
      translated.set(key, prefix ? join(prefix, base) : base);
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
  let configText: string | undefined;
  try {
    configText = readFileSync(resolvedConfigPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
      throw e;
    }
  }

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
      mode = st.mode;
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
  io.err(`Export file written to: ${resolvedZipPath}\n`);
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
  let configText: string | undefined;
  try {
    configText = readFileSync(resolvedConfigPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
      throw e;
    }
  }

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

  const defaultTokenDirectory = join(
    expandUser("~", io.env),
    ".oci",
    "sessions",
  );
  const importedResourcesDir = join(defaultTokenDirectory, archivedProfileName);
  const resolvedTokenDir = resolve(defaultTokenDirectory);
  const resolvedResourcesDir = resolve(importedResourcesDir);
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
    const destPath = join(importedResourcesDir, posixBasename(value));
    writeFileSync(destPath, data);
    applyUserOnlyAccessPermissions(join(importedResourcesDir, value));
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

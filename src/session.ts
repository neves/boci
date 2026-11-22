// Custom `oci session` commands (port of oci_cli/cli_session.py).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Config, ConfigError, configPath, fromFile } from "./config.ts";
import { Exit, type Invocation } from "./io.ts";
import {
  type ClientSettings,
  applyConfigEnvVars,
  createServiceClient,
  sendServiceRequest,
  warnFilePermissions,
} from "./operation.ts";
import { formatServiceError } from "./output.ts";
import { type Index, loadService } from "./spec.ts";

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
  if (typeof rootValues.region === "string" && rootValues.region) {
    config.region = rootValues.region;
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

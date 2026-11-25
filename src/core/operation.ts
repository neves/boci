import { fetchTransportFromEnv } from "./transport.ts";
// The API operation behind a Generated command: parameter values in, the service's response
// out. Config and key loading, endpoint resolution, the request (path, query, headers, body
// bindings), signing, timeouts, retries and --all pagination all live here, in the order
// oci's generated command and the Python SDK's base client do them.
import {
  ConnectionPhaseTimeout,
  connectionErrorReport,
  isConnectionError,
  isCertificateError,
  isRetryableTransportError,
  fetchWithConnectionTimeout,
} from "./connection-timeout.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPosixMode } from "../lib/posixMode.ts";
import { randomBytes, type KeyObject } from "node:crypto";
import {
  type Config,
  ConfigError,
  configPath,
  expandUser,
  fromFile,
} from "./config.ts";
import { loadExternalRegionMetadata, resolveEndpoint } from "./endpoint.ts";
import { resolveInstancePrincipal } from "./instance-principal.ts";
import { resolveResourcePrincipal } from "./resource-principal.ts";
import { Exit, type Invocation } from "../lib/io.ts";
import { pyStrip } from "../lib/configparser.ts";
import { failingCheck, truthy, type UsageCheck } from "./checks.ts";
import { loadFileContents, parseJsonParameter } from "./json-input.ts";
import {
  ProgramFile,
  ProgramHttpResponse,
  ProgramRaise,
  ProgramUnsupported,
} from "./program.ts";
import {
  SecurityTokenDecodeError,
  SecurityTokenKeyError,
  decodeSecurityToken,
  isSecurityTokenValid,
} from "./security-token.ts";
import { type StdinReader, createStdinReader } from "./stdin.ts";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "./signer.ts";
import type { Index, OperationSpec, ServiceSpec } from "./spec.ts";
import type { KeyTypes, Models } from "./camelize.ts";

export type OperationCall = {
  /** A Generated command whose operation is supported by the generic engine. */
  command: GeneratedCommand;
  /** The Leaf command's converted parameter values, by canonical name. */
  values: Record<string, unknown>;
  /** The root (global) options' converted values. */
  rootValues: Record<string, unknown>;
  /** Where the config comes from (the root callback's settings). */
  settings: { configFile: string; profile: string; auth: string | null };
  /** The command's Service: its SDK clients name the endpoint templates. */
  spec: Pick<ServiceSpec, "clients" | "models">;
  index: Pick<Index, "regions">;
  /** Reuse an authenticated client across a multi-step wrapper. */
  serviceClient?: ServiceClient;
  /** Shared stdin reader when invoked after wrapper prompts. */
  stdin?: StdinReader;
  /** Delete confirmation already ran before wrapper/validation checks. */
  skipDeleteConfirm?: boolean;
  /** Update confirmation already ran before JSON parameter parsing. */
  skipUpdateConfirm?: boolean;
};

export type OperationResult = {
  responseModels?: Models[string];
  operation: OperationSpec;
  /** The first page's URL (a ServiceError's request_endpoint). */
  url: URL;
  /** The last response and its body. */
  response: Response;
  raw: string;
  /** Raw bytes when responseType is "stream". */
  bytes?: Uint8Array;
  /** --all was given. */
  allPages: boolean;
  /** With --all on a list operation, every page's items in order. */
  pageItems: unknown[];
  /** With --all on a collection model operation, every page's raw body in order. */
  rawPages?: string[];
  /** SDK client serviceName for ServiceError.target_service. */
  targetService?: string;
  /** Outbound opc-request-id header, used by ServiceError when the response omits it. */
  requestId?: string;
};

export type ClientSettings = {
  configFile: string;
  profile: string;
  auth: string | null;
};

export type ServiceClient = {
  client: Record<string, unknown>;
  targetService?: string;
  index: Pick<Index, "regions">;
  rootValues: Record<string, unknown>;
  keyId: string;
  privateKey: KeyObject;
  delegationToken?: string;
  endpointOpt?: string;
  region?: string;
  /** Region explicitly present in config / --region / OCI_CLI_REGION (ctx.obj['config']['region']). */
  configRegion?: string;
  regionMetadata?: Awaited<ReturnType<typeof loadExternalRegionMetadata>>;
  realmSpecific: boolean;
  dualStack: boolean;
  connectionTimeout?: number;
  readTimeout?: number;
  maxAttempts: number;
};

export type ServiceRequestOptions = {
  method: string;
  pathTemplate: string;
  pathParams?: Record<string, string>;
  queryParams?: [string, string][];
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  requestIdHeader?: "opc-request-id" | "opc-client-request-id";
  noRetry?: boolean;
  rawResponse?: boolean;
  decompress?: boolean;
  /** Whether to sign content-length, content-type and x-content-sha256 (default true). */
  enforceContentHeaders?: boolean;
};

export type ServiceResponse = {
  url: URL;
  response: Response;
  raw: string;
  requestId?: string;
};

/** How the command that parses complex params camelizes their keys (ticket 19). */
export function keyTypes(
  command: GeneratedCommand,
  models: Models | undefined,
): KeyTypes {
  return {
    complexTypes: command.delegate?.complexTypes ?? command.complexTypes,
    models,
  };
}

export type GeneratedCommand = Pick<
  ServiceSpec["commands"][string],
  "operation" | "otherOperations" | "params" | "complexTypes" | "delegate"
> & {
  bindings?: Record<string, unknown>[];
};

export function hasDeleteConfirm(
  command: Pick<ServiceSpec["commands"][string], "operation" | "params">,
): boolean {
  return (
    (command.params ?? []).some(
      (p) => p.callback === "oci_cli.cli_util.confirmation_callback",
    ) || command.operation?.http === "DELETE"
  );
}

export async function confirmDeleteIfNeeded(
  io: Invocation,
  command: Pick<ServiceSpec["commands"][string], "operation" | "params">,
  values: Record<string, unknown>,
  stdin?: StdinReader,
): Promise<boolean> {
  if (!hasDeleteConfirm(command) || values.force === true) return false;
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
  return true;
}

export async function confirmUpdateIfNeeded(
  io: Invocation,
  command: Pick<ServiceSpec["commands"][string], "operation" | "delegate">,
  values: Record<string, unknown>,
  stdin?: StdinReader,
): Promise<boolean> {
  if (values.force === true) return false;
  const confirmParams = command.operation?.updateConfirm;
  if (!confirmParams?.length) return false;
  const renames = command.delegate?.renames ?? {};
  if (
    !confirmParams.some((genName) =>
      hasUpdateValue(values[renames[genName] ?? genName]),
    )
  )
    return false;
  const names = confirmParams.map((p) => p.replaceAll("_", "-")).join(" and ");
  const confirmed = await confirmUnderWrapExceptions(
    io,
    `WARNING: Updates to ${names} will replace any existing values. Are you sure you want to continue?`,
    false,
    stdin,
  );
  if (!confirmed) {
    io.err("Abort: \n");
    throw new Exit(1);
  }
  return true;
}

const isBlank = (value: unknown) =>
  typeof value === "string" && pyStrip(value) === "";

/** A Tier A wrapper's own blank checks and compiled argument checks. */
export function wrapperUsageCheckFailure(
  command: Pick<ServiceSpec["commands"][string], "delegate" | "params">,
  values: Record<string, unknown>,
): { message: string; wrapped: boolean } | undefined {
  const delegate = command.delegate;
  for (const check of delegate?.blankChecks ?? []) {
    if (isBlank(values[check.param]))
      return {
        message: check.message,
        wrapped: delegate?.wrapExceptions === true,
      };
  }
  const failed = failingCheck(delegate?.checks, values, command.params ?? []);
  if (failed !== undefined)
    return { message: failed, wrapped: delegate?.wrapExceptions === true };
  return undefined;
}

/**
 * The generated callback's own UsageError checks (always under wrap_exceptions):
 * path-param blank checks, `--all` with truthy `--limit`, and `--sort-by` without
 * `--availability-domain` or `--all`.
 */
export function generatedUsageCheckFailure(
  command: Pick<ServiceSpec["commands"][string], "delegate" | "operation">,
  values: Record<string, unknown>,
): { message: string; wrapped: boolean } | undefined {
  const renames = command.delegate?.renames ?? {};
  for (const arg of Object.values(command.operation?.pathParams ?? {})) {
    if (!isBlank(values[arg])) continue;
    const generated =
      Object.entries(renames).find(([, custom]) => custom === arg)?.[0] ?? arg;
    return {
      message: `Parameter --${generated.replaceAll("_", "-")} cannot be whitespace or empty string`,
      wrapped: true,
    };
  }
  if (
    command.operation?.paginated !== false &&
    truthy(values.all_pages) &&
    truthy(values.limit)
  ) {
    return {
      message:
        "If you provide the --all option you cannot provide the --limit option",
      wrapped: true,
    };
  }
  if (
    command.operation?.sortByRequiresAd &&
    truthy(values.sort_by) &&
    !truthy(values.availability_domain) &&
    !truthy(values.all_pages)
  ) {
    return {
      message:
        "You must provide an --availability-domain when doing a --sort-by, unless you specify the --all parameter",
      wrapped: true,
    };
  }
  return undefined;
}

/**
 * The first UsageError the command raises before any request: a Tier A wrapper's own
 * blank checks, then its other argument checks (`wrapped` says whether the wrapper has
 * wrap_exceptions), then the generated callback's own checks (always under wrap_exceptions).
 */
export function usageCheckFailure(
  command: Pick<
    ServiceSpec["commands"][string],
    "delegate" | "operation" | "params"
  >,
  values: Record<string, unknown>,
): { message: string; wrapped: boolean } | undefined {
  return (
    wrapperUsageCheckFailure(command, values) ??
    generatedUsageCheckFailure(command, values)
  );
}

/**
 * The first compiled check of a Tier B wrapper that fires, for commands whose happy path
 * the Engine does not run yet. Stops at the first check that did not compile: it might
 * have fired first.
 */
export function tierBCheckFailure(
  command: ServiceSpec["commands"][string],
  values: Record<string, unknown>,
): { message: string; wrapped: boolean } | undefined {
  if (command.tier !== "B") return undefined;
  const compiled: UsageCheck[] = [];
  for (const check of command.survey?.checks ?? []) {
    if (check.test === undefined) break;
    compiled.push({ test: check.test, message: check.message });
  }
  const message = failingCheck(compiled, values, command.params ?? []);
  return message === undefined
    ? undefined
    : { message, wrapped: command.survey?.wrapExceptions === true };
}

function hasUpdateValue(value: unknown): boolean {
  if (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === ""
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

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
  io: Invocation,
  command: GeneratedCommand,
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  arg: string,
  keys: KeyTypes,
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
          candidate = parseJsonParameter(io, item.param, candidate, keys);
        }
        result = candidate;
      }
    } else if (item.value !== undefined) {
      result = item.value;
    }
  }
  return result !== undefined ? result : values[arg];
}

/** Python's json.dumps defaults used by the OCI CLI: ASCII escapes and spaced separators. */
function serializeRequestJson(value: unknown): string {
  const compact = JSON.stringify(value);
  if (compact === undefined) return "";
  const ascii: string[] = [];
  for (const char of compact) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      ascii.push(char);
    } else if (codePoint <= 0xffff) {
      ascii.push(`\\u${codePoint.toString(16).padStart(4, "0")}`);
    } else {
      const value = codePoint - 0x10000;
      const high = 0xd800 + (value >> 10);
      const low = 0xdc00 + (value & 0x3ff);
      ascii.push(`\\u${high.toString(16)}\\u${low.toString(16)}`);
    }
  }

  const result: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of ascii) {
    result.push(char);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "," || char === ":") result.push(" ");
  }
  return result.join("");
}

function buildRequestBody(
  io: Invocation,
  command: GeneratedCommand,
  values: Record<string, unknown>,
  rootValues: Record<string, unknown>,
  keys: KeyTypes,
): string | Uint8Array | ProgramFile {
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
    let value =
      typeof binding.param === "string" ? values[binding.param] : binding.value;
    if (value === undefined) {
      // An unconditional binding sends the unset option as None, e.g. a param a
      // Tier A wrapper made optional where its generated command required it.
      if (typeof binding.param !== "string" || binding.when !== undefined)
        continue;
      value = null;
    }
    let target = body;
    for (const part of binding.key.slice(0, -1) as string[]) {
      const nested = target[part];
      if (typeof nested !== "object" || nested === null) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    if (binding.transform === "parse_json_parameter") {
      target[binding.key.at(-1) as string] = parseJsonParameter(
        io,
        typeof binding.param === "string"
          ? binding.param
          : (binding.key.at(-1) as string),
        value,
        keys,
      );
    } else if (
      typeof value === "string" &&
      value.toLowerCase().startsWith("file://")
    ) {
      target[binding.key.at(-1) as string] = loadFileContents(io, value);
    } else {
      target[binding.key.at(-1) as string] = value;
    }
  }
  if (!hasBodyBindings && typeof command.operation?.body === "string") {
    const direct = boundValueFor(
      io,
      command,
      values,
      rootValues,
      command.operation.body,
      keys,
    );
    if (direct === undefined || direct === null) {
      return command.params?.some(
        (param) => param.name === command.operation?.body,
      )
        ? ""
        : "{}";
    }
    // A wrapper's `file.read()` bytes, or the open file itself: sent as they are.
    if (direct instanceof Uint8Array || direct instanceof ProgramFile)
      return direct;
    if (typeof direct === "string") {
      // The email data-plane command treats raw_message as file content; other
      // generated direct-body parameters are passed through as raw strings.
      return command.operation?.body === "raw_message"
        ? (loadFileContents(io, direct) ?? direct)
        : direct;
    }
    return serializeRequestJson(direct);
  }
  return hasBodyBindings ? serializeRequestJson(body) : "";
}

/**
 * Build a reusable authenticated OCI service client for one CLI invocation (config,
 * permissions warning, auth principal/key, endpoint metadata, timeout & retry settings).
 */
export async function createServiceClient(
  io: Invocation,
  opts: {
    client: Record<string, unknown>;
    values?: Record<string, unknown>;
    rootValues: Record<string, unknown>;
    settings: ClientSettings;
    index: Pick<Index, "regions">;
    noRetry?: boolean;
  },
): Promise<ServiceClient> {
  const { client, values = {}, rootValues, settings, index, noRetry } = opts;
  const isInstancePrincipal = settings.auth === "instance_principal";
  const isInstanceOboUser = settings.auth === "instance_obo_user";
  const isResourcePrincipal = settings.auth === "resource_principal";
  const configOptional = isInstancePrincipal || isResourcePrincipal;
  let config: Config = {};
  let configLoaded = false;
  try {
    config = fromFile(settings.configFile, settings.profile, io.env, io.cwd);
    configLoaded = true;
  } catch (e) {
    if (e instanceof ConfigError) {
      if (e.type === "ConfigFileNotFound") {
        if (!configOptional) {
          const message = e.message.split(", please follow")[0] as string;
          io.out(
            `ERROR: ${message}\nDo you want to create a new config file? [Y/n]: `,
          );
          io.err("Abort: \n");
          throw new Exit(1);
        }
      } else {
        io.err(`ERROR: ${e.message}\n`);
        throw new Exit(1);
      }
    } else {
      throw e;
    }
  }
  const suppressPermWarning =
    (io.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING ?? "").toLowerCase() ===
    "true";
  if (configLoaded && !suppressPermWarning) {
    warnFilePermissions(io, configPath(settings.configFile, io.env, io.cwd));
  }
  applyConfigEnvVars(config, io.env);
  let principal:
    { keyId: string; privateKey: KeyObject; region?: string } | undefined;
  let delegationToken: string | undefined;
  if (isInstancePrincipal || isInstanceOboUser) {
    if (isInstanceOboUser) {
      const tokenLocation = config.delegation_token_file;
      if (tokenLocation === undefined || tokenLocation === null) {
        io.err(
          "ERROR: Please specify the location of the delegation_token_file in the config.\n",
        );
        throw new Exit(1);
      }
      const expanded = expandUser(String(tokenLocation), io.env);
      const resolvedPath = resolve(io.cwd, expanded);
      if (!existsSync(resolvedPath)) {
        io.err(`ERROR: delegation_token_file not found at ${expanded}\n`);
        throw new Exit(1);
      }
      delegationToken = pyStrip(readFileSync(resolvedPath, "utf8"));
    }
    try {
      principal = await resolveInstancePrincipal({
        env: io.env,
        regions: index.regions,
        federationEndpoint: rootValues.federation_endpoint as
          string | undefined,
        authPurpose: isInstanceOboUser
          ? undefined
          : (rootValues.auth_purpose as string | undefined),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      io.err(
        `ERROR: Failed retrieving certificates from localhost. Instance principal auth is only possible from OCI compute instances. \nException: ${msg}\n`,
      );
      throw new Exit(1);
    }
  } else if (isResourcePrincipal) {
    try {
      principal = await resolveResourcePrincipal({
        env: io.env,
        regions: index.regions,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      io.err(`ERROR: ${msg}\n`);
      throw new Exit(1);
    }
  }
  const endpointOpt = (rootValues.endpoint ?? config.endpoint) as
    string | undefined;
  const configRegion = (rootValues.region ??
    io.env.OCI_CLI_REGION ??
    config.region) as string | undefined;
  const region = (configRegion ?? principal?.region) as string | undefined;
  const regionMetadata =
    region && !endpointOpt
      ? await loadExternalRegionMetadata(region, index.regions, io.env)
      : undefined;
  let keyId: string;
  let privateKey: KeyObject;
  if (principal) {
    keyId = principal.keyId;
    privateKey = principal.privateKey;
  } else if (settings.auth === "security_token") {
    const tokenFile = config.security_token_file;
    if (!tokenFile) {
      io.err(
        "ERROR: Config value for 'security_token_file' must be specified when using --auth security_token\n",
      );
      throw new Exit(1);
    }
    const tokenPath = expandUser(String(tokenFile), io.env);
    if (!existsSync(resolve(io.cwd, tokenPath))) {
      io.err(
        `ERROR: File specified by 'security_token_file' does not exist: ${tokenPath}\n`,
      );
      throw new Exit(1);
    }
    if (!suppressPermWarning) warnFilePermissions(io, tokenPath);
    const token = readFileSync(resolve(io.cwd, tokenPath), "utf8");
    const keyPath = expandUser(String(config.key_file), io.env);
    const pem = readFileSync(resolve(io.cwd, keyPath), "utf8");
    const loadWithErrors = (passPhrase: string | null): KeyObject => {
      try {
        return loadPrivateKey(pem, passPhrase);
      } catch (e) {
        if (e instanceof InvalidPrivateKey) {
          io.err(`${e.message}\n`);
          throw new Exit(1);
        }
        if (e instanceof TypeError) {
          io.err(`TypeError: ${e.message}\n`);
          throw new Exit(1);
        }
        throw e;
      }
    };
    try {
      privateKey = loadWithErrors(config.pass_phrase as string | null);
    } catch (e) {
      if (e instanceof MissingPrivateKeyPassphrase) {
        const prompted = io.promptSecret
          ? ((await io.promptSecret("Private key passphrase:")) ?? "")
          : promptFromStdin(io, "Private key passphrase:");
        privateKey = loadWithErrors(prompted);
      } else {
        throw e;
      }
    }
    let jwtPayload: Record<string, unknown>;
    try {
      jwtPayload = decodeSecurityToken(token);
      if (!isSecurityTokenValid(jwtPayload)) {
        io.out(
          "ERROR: This CLI session has expired, so it cannot currently be used to run commands\n",
        );
        const confirmed = await confirmUnderWrapExceptions(
          io,
          "Do you want to re-authenticate your CLI session profile?",
          true,
        );
        if (!confirmed) throw new Exit(1);
        io.err("ERROR: 'oci session authenticate' is not implemented yet.\n");
        throw new Exit(1);
      }
    } catch (e) {
      if (
        e instanceof SecurityTokenDecodeError ||
        e instanceof SecurityTokenKeyError
      ) {
        io.err(`${e.name}: ${e.message}\n`);
        throw new Exit(1);
      }
      throw e;
    }
    keyId = `ST$${token}`;
    if (configLoaded && config.key_file && !suppressPermWarning) {
      warnFilePermissions(io, keyPath);
    }
  } else {
    if (
      configLoaded &&
      config.key_file &&
      !configOptional &&
      !suppressPermWarning
    ) {
      warnFilePermissions(io, expandUser(String(config.key_file), io.env));
    }
    keyId = `${config.tenancy}/${config.user}/${config.fingerprint}`;
    const keyPath = expandUser(String(config.key_file), io.env);
    const pem = readFileSync(resolve(io.cwd, keyPath), "utf8");
    const loadWithErrors = (passPhrase: string | null): KeyObject => {
      try {
        return loadPrivateKey(pem, passPhrase);
      } catch (e) {
        if (e instanceof InvalidPrivateKey) {
          io.err(`${e.message}\n`);
          throw new Exit(1);
        }
        if (e instanceof TypeError) {
          io.err(`TypeError: ${e.message}\n`);
          throw new Exit(1);
        }
        throw e;
      }
    };
    try {
      privateKey = loadWithErrors(config.pass_phrase as string | null);
    } catch (e) {
      if (e instanceof MissingPrivateKeyPassphrase) {
        const prompted = io.promptSecret
          ? ((await io.promptSecret("Private key passphrase:")) ?? "")
          : promptFromStdin(io, "Private key passphrase:");
        privateKey = loadWithErrors(prompted);
      } else {
        throw e;
      }
    }
  }
  const connectionTimeout = timeoutSecondsFor(
    rootValues.connection_timeout ?? config.connection_timeout,
  );
  const readTimeout = timeoutSecondsFor(
    rootValues.read_timeout ?? config.read_timeout,
  );
  const maxAttempts =
    rootValues.no_retry === true || noRetry
      ? 1
      : Math.max(1, Number(rootValues.max_retries) || 8);
  return {
    client,
    targetService:
      typeof client.serviceName === "string" ? client.serviceName : undefined,
    index,
    rootValues,
    keyId,
    privateKey,
    ...(delegationToken !== undefined ? { delegationToken } : {}),
    endpointOpt,
    region,
    configRegion,
    regionMetadata,
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
    connectionTimeout,
    readTimeout,
    maxAttempts,
  };
}

/** Resolve endpoint + encoded path + query params for a service request. */
export function buildServiceUrl(
  io: Invocation,
  sc: ServiceClient,
  pathTemplate: string,
  pathParams: Record<string, string> = {},
  queryParams: [string, string][] = [],
): URL {
  const serviceParams: Record<string, string> = { ...pathParams };
  for (const [k, v] of queryParams) serviceParams[k] = v;
  const { resolved } = resolveEndpoint(sc.client, sc.index.regions, {
    env: io.env,
    region: sc.region,
    endpoint: sc.endpointOpt,
    regionMetadata: sc.regionMetadata,
    serviceParams,
    realmSpecific: sc.realmSpecific,
    dualStack: sc.dualStack,
  });
  let path = pathTemplate;
  for (const [name, value] of Object.entries(pathParams)) {
    // The SDK quotes path parameters with urllib.parse.quote. Object Storage
    // treats slashes as part of a name; other clients preserve them.
    const encoded = encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const replacement =
      sc.targetService === "object_storage"
        ? encoded
        : encoded.replaceAll("%2F", "/");
    path = path.replaceAll(`{${name}}`, replacement);
  }
  const url = new URL(`${resolved}${path}`);
  for (const [name, value] of queryParams) {
    url.searchParams.set(name, value);
  }
  return url;
}

/** Send one signed HTTP request with the client's timeouts, retries and debug logging. */
export async function sendServiceRequest(
  io: Invocation,
  sc: ServiceClient,
  opts: ServiceRequestOptions,
): Promise<ServiceResponse> {
  const url = buildServiceUrl(
    io,
    sc,
    opts.pathTemplate,
    opts.pathParams,
    opts.queryParams,
  );
  const headers: Record<string, string> = { ...opts.headers };
  const useRetry = sc.rootValues.no_retry !== true && opts.noRetry !== true;
  if (useRetry && headers["opc-client-retries"] === undefined) {
    headers["opc-client-retries"] = "true";
  }
  if (sc.rootValues.request_id !== undefined) {
    const reqIdHeader = opts.requestIdHeader ?? "opc-client-request-id";
    headers[reqIdHeader] = String(sc.rootValues.request_id);
  }
  const req = {
    method: opts.method,
    url: url.toString(),
    headers,
    body: opts.body ?? "",
  };
  prepareContentLength(req);
  const maxAttempts = opts.noRetry ? 1 : sc.maxAttempts;
  let response: Response;
  let raw = "";
  for (let attempt = 1; ; attempt++) {
    delete req.headers.date;
    delete req.headers.authorization;
    if (sc.delegationToken !== undefined) {
      req.headers["opc-obo-token"] = sc.delegationToken;
    }
    signRequest(
      req,
      { keyId: sc.keyId, privateKey: sc.privateKey },
      opts.enforceContentHeaders ?? true,
      sc.delegationToken !== undefined
        ? ["date", "(request-target)", "host", "opc-obo-token"]
        : undefined,
    );
    assertLatin1Headers(io, req.headers);
    const controller = new AbortController();
    const readTimer =
      sc.connectionTimeout !== undefined || sc.readTimeout === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new DOMException("Response read timed out", "TimeoutError"),
              ),
            sc.readTimeout * 1000,
          );
    try {
      const init: RequestInit & { decompress?: boolean } = {
        method: req.method,
        headers: req.headers,
        ...(req.body !== "" && req.body !== undefined
          ? { body: req.body }
          : {}),
        ...(readTimer === undefined ? {} : { signal: controller.signal }),
        ...(opts.decompress === false ? { decompress: false } : {}),
      };
      response =
        sc.connectionTimeout === undefined
          ? await fetch(req.url, {
              ...init,
              ...fetchTransportFromEnv(req.url, io.env, io.cwd),
            })
          : await fetchWithConnectionTimeout(
              io,
              url,
              req,
              sc.connectionTimeout * 1000,
              controller.signal,
              opts.decompress,
              (sc.readTimeout ?? 0) * 1000,
            );
      if (opts.rawResponse && response.ok) {
        raw = "";
      } else {
        raw = await response.text();
      }
    } catch (e) {
      if (readTimer !== undefined) clearTimeout(readTimer);
      if (attempt >= maxAttempts || !isRetryableTransportError(e)) {
        if (sc.rootValues.debug !== true) {
          if (e instanceof ConnectionPhaseTimeout) {
            io.err(e.report());
            throw new Exit(1);
          }
          if (isCertificateError(e)) {
            io.err(connectionErrorReport("SSLException", req.method, url));
            throw new Exit(1);
          }
          if (isConnectionError(e)) {
            io.err(connectionErrorReport("RequestException", req.method, url));
            throw new Exit(1);
          }
        }
        throw e;
      }
      const delay = Math.min(
        1000 * 2 ** (attempt - 1) + Math.random() * 1000,
        30000,
      );
      await Bun.sleep(delay);
      continue;
    } finally {
      if (readTimer !== undefined) clearTimeout(readTimer);
    }
    if (attempt >= maxAttempts || !retryableResponse(response, raw)) break;
    const delay = Math.min(
      1000 * 2 ** (attempt - 1) + Math.random() * 1000,
      30000,
    );
    await Bun.sleep(delay);
  }
  if (sc.rootValues.debug === true) {
    io.err(`DEBUG:oci.base_client: Request: ${req.method} ${req.url}\n`);
    io.err(`DEBUG:oci.base_client: Response status: ${response.status}\n`);
  }
  return { url, response, raw, requestId: req.headers["opc-request-id"] };
}

/** The parameter a download command streams the response body into (its `--file`). */
export function outputBinding(command: GeneratedCommand): string | undefined {
  const binding = command.bindings?.find((b) => b.target === "output");
  return typeof binding?.param === "string" ? binding.param : undefined;
}

/**
 * Send the command's request and return the response (any status). Usage, config, key and
 * file:// problems are reported on the invocation's sinks and end it with Exit(1); a network
 * error that outlives the retries is thrown.
 */
export async function callOperation(
  io: Invocation,
  call: OperationCall,
): Promise<OperationResult> {
  const { command, values, rootValues, settings, spec, index } = call;
  const operation = command.operation as OperationSpec;
  if (!call.skipDeleteConfirm) {
    await confirmDeleteIfNeeded(io, command, values, call.stdin);
  }
  if (
    operation.paginated !== false &&
    truthy(values.all_pages) &&
    truthy(values.limit)
  ) {
    io.err(
      "UsageError: If you provide the --all option you cannot provide the --limit option\n",
    );
    throw new Exit(1);
  }
  if (
    operation.sortByRequiresAd &&
    truthy(values.sort_by) &&
    !truthy(values.availability_domain) &&
    !truthy(values.all_pages)
  ) {
    io.err(
      "UsageError: You must provide an --availability-domain when doing a --sort-by, unless you specify the --all parameter\n",
    );
    throw new Exit(1);
  }
  if (!call.skipUpdateConfirm) {
    await confirmUpdateIfNeeded(io, command, values, call.stdin);
  }
  const keys = keyTypes(command, spec.models);
  let requestBody: string | Uint8Array = "";
  // A file-like body: the SDK signer defaults its content-type to octet-stream.
  let streamBody = false;
  if (operation.http !== "GET") {
    const built = buildRequestBody(io, command, values, rootValues, keys);
    streamBody = built instanceof ProgramFile;
    requestBody = built instanceof ProgramFile ? built.read() : built;
  }
  const boundValue = (arg: string) =>
    boundValueFor(io, command, values, rootValues, arg, keys);
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const hasNoneRetry =
    command.bindings?.some((b) => b.transform === "NoneRetryStrategy") === true;
  const sc =
    call.serviceClient ??
    (await createServiceClient(io, {
      client,
      values,
      rootValues,
      settings,
      index,
      noRetry: hasNoneRetry,
    }));
  const pathParams: Record<string, string> = {};
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const fixed = operation.fixedPathParams?.[name];
    if (fixed !== undefined) {
      pathParams[name] = fixed;
      continue;
    }
    const value = boundValue(arg);
    if (value === undefined || value === null || isBlank(value)) {
      io.err(
        `ValueError: Parameter ${name} cannot be None, whitespace or empty string\n`,
      );
      throw new Exit(1);
    }
    pathParams[name] = String(value);
  }
  const queryOrder = Object.keys(operation.queryParams ?? {});
  const upsertQueryParam = (
    params: [string, string][],
    key: string,
    val: string,
  ) => {
    const existing = params.findIndex(([k]) => k === key);
    if (existing >= 0) {
      params[existing] = [key, val];
      return;
    }
    const targetRank = queryOrder.indexOf(key);
    if (targetRank >= 0) {
      const insertAt = params.findIndex(([k]) => {
        const rank = queryOrder.indexOf(k);
        return rank >= 0 && rank > targetRank;
      });
      if (insertAt >= 0) {
        params.splice(insertAt, 0, [key, val]);
        return;
      }
    }
    params.push([key, val]);
  };
  const queryParams: [string, string][] = [];
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) queryParams.push([name, String(value)]);
  }
  const allPages = values.all_pages === true;
  const limit = values.limit;
  const pageSize = values.page_size;
  if ((allPages || limit !== undefined) && pageSize !== undefined) {
    upsertQueryParam(queryParams, "limit", String(pageSize));
  }
  const baseHeaders: Record<string, string> =
    operation.http === "GET"
      ? {}
      : {
          "content-type": streamBody
            ? "application/octet-stream"
            : "application/json",
        };
  if (
    ["POST", "PUT", "PATCH"].includes(operation.http) &&
    operation.client.startsWith("log_analytics.") &&
    requestBody !== ""
  )
    baseHeaders.expect = "100-continue";
  for (const [name, param] of Object.entries(operation.headerParams ?? {})) {
    const value =
      param.value ?? (param.arg ? boundValue(param.arg) : undefined);
    if (value !== undefined) baseHeaders[name] = String(value);
  }
  if (
    operation.headerParams?.["opc-retry-token"] &&
    baseHeaders["opc-retry-token"] === undefined
  )
    baseHeaders["opc-retry-token"] = randomBytes(22).toString("base64url");
  const requestIdHeader =
    operation.headerParams?.["opc-request-id"] !== undefined
      ? "opc-request-id"
      : "opc-client-request-id";
  let firstUrl: URL | undefined;
  let response: Response;
  let raw: string;
  let lastRequestId: string | undefined;
  const pageItems: unknown[] = [];
  const rawPages: string[] = [];
  let nextPage: string | null = null;
  let page = queryParams.find(([k]) => k === "page")?.[1] ?? null;
  const isListResponse = Boolean(operation.responseType?.startsWith("list["));
  const paginateAll =
    allPages &&
    Boolean(operation.responseType) &&
    operation.responseType !== "stream";
  do {
    const pageQuery: [string, string][] = queryParams.map(([k, v]) => [k, v]);
    if (page !== null) upsertQueryParam(pageQuery, "page", page);
    const sent = await sendServiceRequest(io, sc, {
      method: operation.http,
      pathTemplate: operation.path,
      pathParams,
      queryParams: pageQuery,
      headers: baseHeaders,
      body: requestBody,
      requestIdHeader,
      noRetry: hasNoneRetry,
      enforceContentHeaders: operation.enforce_content_headers,
      // A download (`--file` bound to the output) streams a successful body to the file.
      rawResponse: outputBinding(command) !== undefined,
    });
    firstUrl ??= sent.url;
    response = sent.response;
    raw = sent.raw;
    lastRequestId = sent.requestId;
    nextPage = response.headers.get("opc-next-page");
    if (paginateAll && response.ok) {
      if (isListResponse) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) pageItems.push(...parsed);
          else if (
            parsed &&
            typeof parsed === "object" &&
            "items" in parsed &&
            Array.isArray(parsed.items)
          )
            pageItems.push(...parsed.items);
        } catch {
          // Keep ordinary response handling for a malformed list body.
        }
      } else {
        rawPages.push(raw);
      }
    }
    page = nextPage;
    if (!paginateAll || !response.ok) break;
  } while (page !== null);
  return {
    operation,
    responseModels: spec.models?.[operation.client.split(".")[0]!],
    url: firstUrl,
    response,
    raw,
    allPages,
    pageItems,
    ...(rawPages.length > 0 ? { rawPages } : {}),
    targetService: sc.targetService,
    ...(lastRequestId !== undefined ? { requestId: lastRequestId } : {}),
  };
}

export type SdkOperationCall = {
  operation: OperationSpec;
  posArgs: unknown[];
  kwArgs: Record<string, unknown>;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  spec: Pick<ServiceSpec, "clients" | "models">;
  index: Pick<Index, "regions">;
};

/** Bind positional + keyword arguments to an SDK method's parameter names. */
export function bindSdkArgs(
  operation: OperationSpec,
  posArgs: unknown[],
  kwArgs: Record<string, unknown>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...kwArgs };
  const positional = operation.positionalArgs ?? [];
  if (posArgs.length > positional.length)
    throw new ProgramUnsupported(`too many args for ${operation.method}`);
  for (let i = 0; i < posArgs.length; i++) {
    const name = positional[i]!;
    if (name in bound)
      throw new ProgramUnsupported(
        `${operation.method}() got multiple values for argument '${name}'`,
      );
    bound[name] = posArgs[i];
  }
  for (const [pathName, argName] of Object.entries(
    operation.pathParams ?? {},
  )) {
    const value = bound[argName];
    if (value === undefined || value === null || isBlank(value))
      throw new ProgramRaise(
        "ValueError",
        `Parameter ${pathName} cannot be None, whitespace or empty string`,
      );
  }
  return bound;
}

/** Decode an SDK operation's response body into its `.data` value. */
export function parseSdkResponseData(result: OperationResult): unknown {
  if (!result.response.ok || !result.operation.responseType) return null;
  if (
    result.operation.responseType === "stream" &&
    result.bytes !== undefined
  ) {
    const reason =
      result.response.statusText ||
      HTTP_REASON_PHRASES[result.response.status] ||
      "";
    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      result.bytes,
    );
    return new ProgramHttpResponse(
      result.response.status,
      reason,
      result.response.headers,
      result.bytes,
      text,
      result.url.toString(),
    );
  }
  if (result.raw.trim().length === 0) {
    // Python SDK deserializes an empty 200 body into an empty model instance when a model
    // responseType is declared (all attributes default to None).
    return result.responseModels &&
      result.operation.responseType in result.responseModels
      ? {}
      : null;
  }
  try {
    const parsed: unknown = JSON.parse(result.raw);
    if (typeof parsed === "string") return parsed;
    if (result.operation.responseType === "str") return result.raw;
    if (
      Array.isArray(parsed) &&
      parsed.length === 0 &&
      result.responseModels &&
      result.operation.responseType in result.responseModels
    )
      return {};
    return parsed;
  } catch {
    return result.raw;
  }
}

const COLLECTION_SEPARATORS: Record<string, string> = {
  csv: ",",
  ssv: " ",
  tsv: "\t",
  pipes: "|",
};

/**
 * Execute one direct SDK client method call (`client.<method>(*pos, **kw)`) from a
 * compiled Tier B/C program. No CLI prompts or auto-pagination run here.
 */
export async function callSdkOperation(
  io: Invocation,
  call: SdkOperationCall,
): Promise<OperationResult> {
  const { operation, posArgs, kwArgs, rootValues, settings, spec, index } =
    call;
  const sdkArgs = bindSdkArgs(operation, posArgs, kwArgs);
  let requestBody: string | Uint8Array = "";
  let streamBody = false;
  if (operation.http !== "GET" && typeof operation.body === "string") {
    const direct = sdkArgs[operation.body];
    if (direct === undefined || direct === null) {
      requestBody = "";
    } else if (direct instanceof ProgramFile) {
      streamBody = true;
      requestBody = direct.read();
    } else if (direct instanceof Uint8Array) {
      requestBody = direct;
    } else if (typeof direct === "string") {
      requestBody = direct;
    } else {
      requestBody = serializeRequestJson(direct);
    }
  }
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const sc = await createServiceClient(io, {
    client,
    values: {},
    rootValues,
    settings,
    index,
  });
  const pathParams: Record<string, string> = {};
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const fixed = operation.fixedPathParams?.[name];
    if (fixed !== undefined) {
      pathParams[name] = fixed;
      continue;
    }
    const value = sdkArgs[arg];
    if (value !== undefined && value !== null) pathParams[name] = String(value);
  }
  const queryParams: [string, string][] = [];
  for (const [name, { arg, collectionFormat }] of Object.entries(
    operation.queryParams ?? {},
  )) {
    const value = arg ? sdkArgs[arg] : undefined;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (collectionFormat === "multi") {
        for (const item of value) queryParams.push([name, String(item)]);
      } else {
        const sep = COLLECTION_SEPARATORS[collectionFormat ?? "csv"] ?? ",";
        queryParams.push([name, value.map(String).join(sep)]);
      }
    } else {
      queryParams.push([name, String(value)]);
    }
  }
  const baseHeaders: Record<string, string> =
    operation.http === "GET"
      ? {}
      : {
          "content-type": streamBody
            ? "application/octet-stream"
            : "application/json",
        };
  if (
    ["POST", "PUT", "PATCH"].includes(operation.http) &&
    operation.client.startsWith("log_analytics.") &&
    requestBody !== ""
  )
    baseHeaders.expect = "100-continue";
  for (const [name, param] of Object.entries(operation.headerParams ?? {})) {
    const value = param.value ?? (param.arg ? sdkArgs[param.arg] : undefined);
    if (value !== undefined && value !== null)
      baseHeaders[name] = String(value);
  }
  if (
    operation.headerParams?.["opc-retry-token"] &&
    baseHeaders["opc-retry-token"] === undefined &&
    rootValues.no_retry !== true
  )
    baseHeaders["opc-retry-token"] = randomBytes(22).toString("base64url");
  const requestIdHeader =
    operation.headerParams?.["opc-request-id"] !== undefined
      ? "opc-request-id"
      : "opc-client-request-id";
  const isStreamResponse = operation.responseType === "stream";
  const sent = await sendServiceRequest(io, sc, {
    method: operation.http,
    pathTemplate: operation.path,
    pathParams,
    queryParams,
    headers: baseHeaders,
    body: requestBody,
    requestIdHeader,
    enforceContentHeaders: operation.enforce_content_headers,
    ...(isStreamResponse ? { rawResponse: true } : {}),
  });
  const bytes =
    isStreamResponse && sent.response.ok
      ? new Uint8Array(await sent.response.arrayBuffer())
      : undefined;
  return {
    operation,
    responseModels: spec.models?.[operation.client.split(".")[0]!],
    url: sent.url,
    response: sent.response,
    raw: sent.raw,
    ...(bytes !== undefined ? { bytes } : {}),
    allPages: false,
    pageItems: [],
    targetService: sc.targetService,
    ...(sent.requestId !== undefined ? { requestId: sent.requestId } : {}),
  };
}

export type BaseClientApiCall = {
  operation: OperationSpec;
  resourcePath: string;
  method: string;
  pathParams?: Record<string, unknown> | null;
  queryParams?: Record<string, unknown> | [string, unknown][] | null;
  headerParams?: Record<string, unknown> | null;
  body?: unknown;
  responseType?: string | null;
  enforceContentHeaders?: boolean;
  operationName?: string | null;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  spec: Pick<ServiceSpec, "clients" | "models">;
  index: Pick<Index, "regions">;
};

/**
 * Execute `client.base_client.call_api(...)` from a compiled Tier B/C program.
 */
export async function callBaseClientApi(
  io: Invocation,
  call: BaseClientApiCall,
): Promise<OperationResult> {
  const {
    operation,
    resourcePath,
    method,
    pathParams: rawPathParams,
    queryParams: rawQueryParams,
    headerParams: rawHeaderParams,
    body,
    responseType,
    enforceContentHeaders,
    operationName,
    rootValues,
    settings,
    spec,
    index,
  } = call;
  const httpMethod = method.toUpperCase();
  let requestBody: string | Uint8Array = "";
  if (body !== undefined && body !== null) {
    if (body instanceof ProgramFile) {
      requestBody = body.read();
    } else if (body instanceof Uint8Array || typeof body === "string") {
      requestBody = body;
    } else {
      requestBody = serializeRequestJson(body);
    }
  }
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const sc = await createServiceClient(io, {
    client,
    values: {},
    rootValues,
    settings,
    index,
  });
  const pathParams: Record<string, string> = {};
  if (rawPathParams) {
    for (const [k, v] of Object.entries(rawPathParams)) {
      if (v !== undefined && v !== null) pathParams[k] = String(v);
    }
  }
  const queryParams: [string, string][] = [];
  if (Array.isArray(rawQueryParams)) {
    for (const pair of rawQueryParams) {
      if (
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair[1] !== undefined &&
        pair[1] !== null
      ) {
        queryParams.push([String(pair[0]), String(pair[1])]);
      }
    }
  } else if (rawQueryParams) {
    for (const [k, v] of Object.entries(rawQueryParams)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const elem of v) {
          if (elem !== undefined && elem !== null)
            queryParams.push([k, String(elem)]);
        }
      } else {
        queryParams.push([k, String(v)]);
      }
    }
  }
  const headers: Record<string, string> = {};
  if (rawHeaderParams) {
    for (const [k, v] of Object.entries(rawHeaderParams)) {
      if (v !== undefined && v !== null) {
        headers[k.toLowerCase()] = String(v);
      }
    }
  }
  const syntheticOp: OperationSpec = {
    ...operation,
    http: httpMethod,
    path: resourcePath,
    method: operationName ?? "call_api",
    responseType: responseType ?? undefined,
    enforce_content_headers: enforceContentHeaders ?? true,
  };
  const sent = await sendServiceRequest(io, sc, {
    method: httpMethod,
    pathTemplate: resourcePath,
    pathParams,
    queryParams,
    headers,
    body: requestBody,
    requestIdHeader: "opc-request-id",
    enforceContentHeaders: enforceContentHeaders ?? true,
  });
  return {
    operation: syntheticOp,
    responseModels: spec.models?.[operation.client.split(".")[0]!],
    url: sent.url,
    response: sent.response,
    raw: sent.raw,
    allPages: false,
    pageItems: [],
    targetService: sc.targetService,
    ...(sent.requestId !== undefined ? { requestId: sent.requestId } : {}),
  };
}

const HTTP_REASON_PHRASES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  412: "Precondition Failed",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export type RawSessionRequestCall = {
  method: string;
  url: string;
  params?: Record<string, unknown> | null;
  headers?: Record<string, string>;
  data?: unknown;
  hasJson?: boolean;
  json?: unknown;
  stream?: boolean;
  basicAuth?: [string, string] | null;
  retryMode?: "default" | "builder" | "none";
  requestId?: string | null;
  rootValues: Record<string, unknown>;
  settings: ClientSettings;
  index: Pick<Index, "regions">;
};

export type RawSessionResponse = {
  statusCode: number;
  reason: string;
  headers: Headers;
  content: Uint8Array;
  text: string;
  requestUrl: string;
  requestHeaders: Record<string, string>;
};

/**
 * Execute an HTTP request via `cli_util.build_raw_requests_session(ctx)` with OCI
 * request signing (or HTTP Basic Auth when `session.auth` is overridden).
 */
export async function callRawSessionRequest(
  io: Invocation,
  call: RawSessionRequestCall,
): Promise<RawSessionResponse> {
  const sc = await createServiceClient(io, {
    client: {},
    values: {},
    rootValues: call.rootValues,
    settings: call.settings,
    index: call.index,
  });
  const url = new URL(call.url);
  if (call.params) {
    for (const [k, v] of Object.entries(call.params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const elem of v) {
          if (elem !== undefined && elem !== null) {
            url.searchParams.append(k, String(elem));
          }
        }
      } else {
        url.searchParams.append(k, String(v));
      }
    }
  }
  const method = call.method.toUpperCase();
  const headers: Record<string, string> = {};
  const reqId = call.requestId ?? call.rootValues.request_id;
  if (typeof reqId === "string" && reqId) {
    headers["opc-request-id"] = reqId;
  }
  if (call.headers) {
    for (const [k, v] of Object.entries(call.headers)) {
      if (v !== undefined && v !== null) {
        headers[k.toLowerCase()] = String(v);
      }
    }
  }
  let body: string | Uint8Array = "";
  if (call.hasJson && call.json !== undefined && call.json !== null) {
    body = JSON.stringify(call.json);
    headers["content-type"] ??= "application/json";
  } else if (
    call.data !== undefined &&
    call.data !== null &&
    call.data !== ""
  ) {
    if (call.data instanceof ProgramFile) {
      body = call.data.read();
    } else if (
      call.data instanceof Uint8Array ||
      typeof call.data === "string"
    ) {
      body = call.data;
    } else {
      body = String(call.data);
    }
  }
  const req = {
    method,
    url: url.toString(),
    headers,
    body,
  };
  prepareContentLength(req);
  const maxAttempts =
    call.retryMode === "none" ||
    call.retryMode === "builder" ||
    call.rootValues.no_retry === true
      ? 1
      : sc.maxAttempts;
  let response: Response;
  let content = new Uint8Array(0);
  let text = "";
  for (let attempt = 1; ; attempt++) {
    delete req.headers.date;
    delete req.headers.authorization;
    if (call.basicAuth) {
      req.headers.authorization = `Basic ${Buffer.from(`${call.basicAuth[0]}:${call.basicAuth[1]}`, "utf8").toString("base64")}`;
    } else {
      if (sc.delegationToken !== undefined) {
        req.headers["opc-obo-token"] = sc.delegationToken;
      }
      signRequest(
        req,
        { keyId: sc.keyId, privateKey: sc.privateKey },
        true,
        sc.delegationToken !== undefined
          ? ["date", "(request-target)", "host", "opc-obo-token"]
          : undefined,
      );
    }
    assertLatin1Headers(io, req.headers);
    try {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        ...(req.method !== "GET" &&
        req.method !== "HEAD" &&
        req.body !== "" &&
        req.body !== undefined
          ? { body: req.body }
          : {}),
      };
      response = await fetch(req.url, {
        ...init,
        ...fetchTransportFromEnv(req.url, io.env, io.cwd),
      });
      content = new Uint8Array(await response.arrayBuffer());
      text = new TextDecoder("utf-8", { fatal: false }).decode(content);
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryableTransportError(e)) throw e;
      const delay = Math.min(
        1000 * 2 ** (attempt - 1) + Math.random() * 1000,
        30000,
      );
      await Bun.sleep(delay);
      continue;
    }
    // Python's requests.Session.request returns the Response directly for any HTTP status
    // (never raising oci.exceptions.ServiceError), so retry_strategy only retries on
    // connection/transport errors, never on 4xx/5xx HTTP responses.
    break;
  }
  const reason =
    response.statusText || HTTP_REASON_PHRASES[response.status] || "";
  return {
    statusCode: response.status,
    reason,
    headers: response.headers,
    content,
    text,
    requestUrl: req.url,
    requestHeaders: { ...req.headers },
  };
}

function timeoutSecondsFor(value: unknown): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  return undefined;
}

/**
 * Python's http.client encodes HTTP header values as latin-1 before sending; characters
 * outside 0x00..0xFF raise UnicodeEncodeError without retrying.
 */
function assertLatin1Headers(
  io: Invocation,
  headers: Record<string, string>,
): void {
  for (const value of Object.values(headers)) {
    let pos = 0;
    let start = -1;
    let firstCp = 0;
    let end = -1;
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0xff) {
        if (start === -1) {
          start = pos;
          firstCp = cp;
        }
        end = pos + 1;
      } else if (start !== -1) {
        break;
      }
      pos++;
    }
    if (start !== -1) {
      if (end === start + 1) {
        const escaped =
          firstCp < 0x10000
            ? `\\u${firstCp.toString(16).padStart(4, "0")}`
            : `\\U${firstCp.toString(16).padStart(8, "0")}`;
        io.err(
          `UnicodeEncodeError: 'latin-1' codec can't encode character '${escaped}' in position ${start}: ordinal not in range(256)\n`,
        );
      } else {
        io.err(
          `UnicodeEncodeError: 'latin-1' codec can't encode characters in position ${start}-${end - 1}: ordinal not in range(256)\n`,
        );
      }
      throw new Exit(1);
    }
  }
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

const OCI_CONFIG_ENV_VARS: Record<string, string> = {
  OCI_CLI_USER: "user",
  OCI_CLI_FINGERPRINT: "fingerprint",
  OCI_CLI_KEY_FILE: "key_file",
  OCI_CLI_KEY_CONTENT: "key_content",
  OCI_CLI_TENANCY: "tenancy",
  OCI_CLI_PASSPHRASE: "pass_phrase",
  OCI_CLI_DELEGATION_TOKEN_FILE: "delegation_token_file",
  OCI_CLI_SECURITY_TOKEN_FILE: "security_token_file",
};

/** cli_util.build_config: apply OCI_CONFIG_ENV_VARS overrides from the environment. */
export function applyConfigEnvVars(
  config: Config,
  env: Record<string, string | undefined>,
): void {
  for (const [envVar, key] of Object.entries(OCI_CONFIG_ENV_VARS)) {
    if (env[envVar] !== undefined) {
      config[key] = env[envVar] as string;
    }
  }
}

export function warnFilePermissions(io: Invocation, file: string) {
  try {
    if ((getPosixMode(resolve(io.cwd, file)) & 0o077) === 0) return;
  } catch {
    return;
  }
  io.err(
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

export async function confirmUnderWrapExceptions(
  io: Invocation,
  text: string,
  defaultValue: boolean,
  stdin: StdinReader = createStdinReader(io),
  promptSuffix = ": ",
  showDefault = true,
  toStderr = false,
): Promise<boolean> {
  const suffix = showDefault
    ? ` ${defaultValue ? "[Y/n]" : "[y/N]"}${promptSuffix}`
    : promptSuffix;
  const prompt = `${text}${suffix}`;
  const out = toStderr ? io.err : io.out;
  while (true) {
    out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err("Abort: \n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    if (normalized === "") return defaultValue;
    out("Error: invalid input\n");
  }
}

export function promptFromStdin(io: Invocation, prompt: string): string {
  io.err(`Warning: Password input may be echoed.\n${prompt}\n`);
  const line = (io.stdin ?? "").split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

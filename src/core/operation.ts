// The API operation behind a Generated command: parameter values in, the service's response
// out. Config and key loading, endpoint resolution, the request (path, query, headers, body
// bindings), signing, timeouts, retries and --all pagination all live here, in the order
// oci's generated command and the Python SDK's base client do them.
import {
  ConnectionPhaseTimeout,
  fetchWithConnectionTimeout,
} from "./connection-timeout.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
import { loadFileContents, parseJsonParameter } from "./json-input.ts";
import {
  SecurityTokenDecodeError,
  SecurityTokenKeyError,
  decodeSecurityToken,
  isSecurityTokenValid,
} from "./security-token.ts";
import { createStdinReader } from "./stdin.ts";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "./signer.ts";
import type { Index, OperationSpec, ServiceSpec } from "./spec.ts";

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
  spec: Pick<ServiceSpec, "clients">;
  index: Pick<Index, "regions">;
};

export type OperationResult = {
  operation: OperationSpec;
  /** The first page's URL (a ServiceError's request_endpoint). */
  url: URL;
  /** The last response and its body. */
  response: Response;
  raw: string;
  /** --all was given. */
  allPages: boolean;
  /** With --all on a list operation, every page's items in order. */
  pageItems: unknown[];
  /** SDK client serviceName for ServiceError.target_service. */
  targetService?: string;
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
  endpointOpt?: string;
  region?: string;
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
};

export type GeneratedCommand = Pick<
  ServiceSpec["commands"][string],
  "operation" | "otherOperations" | "params"
> & {
  bindings?: Record<string, unknown>[];
};

const COMPLEX_TYPE_CLASS =
  "oci_cli.custom_types.cli_complex_type.CliComplexType";

function replacedBodyParams(command: GeneratedCommand) {
  if (!command.params?.some((p) => p.name === "force")) return [];
  const bodyBindings = (command.bindings ?? []).filter(
    (b) => b.target === "body" && Array.isArray(b.key) && b.key.length === 1,
  );
  return command.params.filter(
    (p) =>
      (p.typeClass === COMPLEX_TYPE_CLASS || p.multiple === true) &&
      bodyBindings.some((b) => b.param === p.name),
  );
}

function hasUpdateValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "")
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
          candidate = parseJsonParameter(io, item.param, candidate);
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
): string {
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
    const value =
      typeof binding.param === "string" ? values[binding.param] : binding.value;
    if (value === undefined) continue;
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
    );
    if (direct === undefined || direct === null) return "";
    if (typeof direct === "string") {
      return loadFileContents(io, direct) ?? direct;
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
  if (isInstancePrincipal) {
    try {
      principal = await resolveInstancePrincipal({
        env: io.env,
        regions: index.regions,
        federationEndpoint: rootValues.federation_endpoint as
          string | undefined,
        authPurpose: rootValues.auth_purpose as string | undefined,
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
  const region = (rootValues.region ??
    io.env.OCI_CLI_REGION ??
    config.region ??
    principal?.region) as string | undefined;
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
    endpointOpt,
    region,
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
    signRequest(
      req,
      { keyId: sc.keyId, privateKey: sc.privateKey },
      opts.enforceContentHeaders ?? true,
    );
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
          ? await fetch(req.url, init)
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
      if (attempt >= maxAttempts) {
        if (
          e instanceof ConnectionPhaseTimeout &&
          sc.rootValues.debug !== true
        ) {
          io.err(e.report());
          throw new Exit(1);
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
  return { url, response, raw };
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
  if (operation.http === "DELETE" && values.force !== true) {
    const confirmed = await confirmUnderWrapExceptions(
      io,
      "Are you sure you want to delete this resource?",
      false,
    );
    if (!confirmed) {
      io.err("Abort: \n");
      throw new Exit(1);
    }
  } else if (values.force !== true) {
    const replaced = replacedBodyParams(command);
    if (replaced.some((p) => hasUpdateValue(values[p.name]))) {
      const names = replaced
        .map((p) => p.name.replaceAll("_", "-"))
        .join(" and ");
      const confirmed = await confirmUnderWrapExceptions(
        io,
        `WARNING: Updates to ${names} will replace any existing values. Are you sure you want to continue?`,
        false,
      );
      if (!confirmed) {
        io.err("Abort: \n");
        throw new Exit(1);
      }
    }
  }
  let requestBody = "";
  if (operation.http === "GET") {
    if (values.all_pages === true && values.limit !== undefined) {
      io.err(
        "UsageError: If you provide the --all option you cannot provide the --limit option\n",
      );
      throw new Exit(1);
    }
  } else requestBody = buildRequestBody(io, command, values, rootValues);
  const boundValue = (arg: string) =>
    boundValueFor(io, command, values, rootValues, arg);
  const client = spec.clients[operation.client] as Record<string, unknown>;
  const hasNoneRetry =
    command.bindings?.some((b) => b.transform === "NoneRetryStrategy") === true;
  const sc = await createServiceClient(io, {
    client,
    values,
    rootValues,
    settings,
    index,
    noRetry: hasNoneRetry,
  });
  const pathParams: Record<string, string> = {};
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const value = boundValue(arg);
    if (value !== undefined) pathParams[name] = String(value);
  }
  const queryParams: [string, string][] = [];
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) queryParams.push([name, String(value)]);
  }
  const allPages = values.all_pages === true;
  const limit = values.limit;
  const pageSize = values.page_size;
  if ((allPages || limit !== undefined) && pageSize !== undefined) {
    const existing = queryParams.findIndex(([k]) => k === "limit");
    if (existing >= 0) queryParams[existing] = ["limit", String(pageSize)];
    else queryParams.push(["limit", String(pageSize)]);
  }
  const baseHeaders: Record<string, string> =
    operation.http === "GET" ? {} : { "content-type": "application/json" };
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
  const pageItems: unknown[] = [];
  let nextPage: string | null = null;
  let page = queryParams.find(([k]) => k === "page")?.[1] ?? null;
  do {
    const pageQuery = queryParams.filter(([k]) => k !== "page");
    if (page !== null) pageQuery.push(["page", page]);
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
    });
    firstUrl ??= sent.url;
    response = sent.response;
    raw = sent.raw;
    nextPage = response.headers.get("opc-next-page");
    if (
      allPages &&
      response.ok &&
      operation.responseType?.startsWith("list[")
    ) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "items" in parsed &&
          Array.isArray(parsed.items)
        )
          pageItems.push(...parsed.items);
      } catch {
        // Keep ordinary response handling for a malformed list body.
      }
    }
    page = nextPage;
    if (!allPages || !operation.responseType?.startsWith("list[")) break;
  } while (page !== null);
  return {
    operation,
    url: firstUrl,
    response,
    raw,
    allPages,
    pageItems,
    targetService: sc.targetService,
  };
}

function timeoutSecondsFor(value: unknown): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  return undefined;
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
    if ((statSync(resolve(io.cwd, file)).mode & 0o077) === 0) return;
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
): Promise<boolean> {
  const stdin = createStdinReader(io);
  const suffix = defaultValue ? "[Y/n]: " : "[y/N]: ";
  const prompt = `${text} ${suffix}`;
  while (true) {
    io.out(prompt);
    const line = await stdin.readLine();
    if (line === null) {
      io.err("Abort: \n");
      throw new Exit(1);
    }
    const normalized = line.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    if (normalized === "") return defaultValue;
    io.out("Error: invalid input\n");
  }
}

export function promptFromStdin(io: Invocation, prompt: string): string {
  io.err(`Warning: Password input may be echoed.\n${prompt}\n`);
  const line = (io.stdin ?? "").split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

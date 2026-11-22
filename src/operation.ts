// The API operation behind a Generated command: parameter values in, the service's response
// out. Config and key loading, endpoint resolution, the request (path, query, headers, body
// bindings), signing, timeouts, retries and --all pagination all live here, in the order
// oci's generated command and the Python SDK's base client do them.
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
import { Exit, type Invocation } from "./io.ts";
import { loadFileContents, parseJsonParameter } from "./json-input.ts";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "./signer.ts";
import type { Index, OperationSpec, ServiceSpec } from "./spec.ts";

export type OperationCall = {
  /** A Generated command whose operation is GET, POST, PUT or PATCH. */
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
};

export type GeneratedCommand = ServiceSpec["commands"][string] & {
  bindings?: Record<string, unknown>[];
};

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
    return JSON.stringify(direct);
  }
  return Object.keys(body).length ? JSON.stringify(body) : "";
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
  if (
    configLoaded &&
    (io.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING ?? "").toLowerCase() !==
      "true"
  ) {
    warnFilePermissions(io, configPath(settings.configFile, io.env, io.cwd));
    if (config.key_file && !configOptional)
      warnFilePermissions(io, expandUser(String(config.key_file), io.env));
  }
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
  const client = spec.clients[operation.client] as Record<string, unknown>;
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
  const serviceParams: Record<string, string> = {};
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const value = boundValue(arg);
    if (value !== undefined) serviceParams[name] = String(value);
  }
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) serviceParams[name] = String(value);
  }
  const { resolved } = resolveEndpoint(client, index.regions, {
    env: io.env,
    region,
    endpoint: endpointOpt,
    regionMetadata,
    serviceParams,
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
  });
  let path = operation.path;
  for (const [name, arg] of Object.entries(operation.pathParams ?? {})) {
    const value = boundValue(arg);
    if (value !== undefined)
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(`${resolved}${path}`);
  for (const [name, { arg }] of Object.entries(operation.queryParams ?? {})) {
    const value = arg ? boundValue(arg) : undefined;
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const allPages = values.all_pages === true;
  const limit = values.limit;
  const pageSize = values.page_size;
  if ((allPages || limit !== undefined) && pageSize !== undefined)
    url.searchParams.set("limit", String(pageSize));
  const baseUrl = new URL(url);
  const headers: Record<string, string> =
    operation.http === "GET" ? {} : { "content-type": "application/json" };
  if (operation.http !== "GET" && operation.client.startsWith("log_analytics."))
    headers.expect = "100-continue";
  for (const [name, param] of Object.entries(operation.headerParams ?? {})) {
    const value =
      param.value ?? (param.arg ? boundValue(param.arg) : undefined);
    if (value !== undefined) headers[name] = String(value);
  }
  if (
    operation.headerParams?.["opc-retry-token"] &&
    headers["opc-retry-token"] === undefined
  )
    headers["opc-retry-token"] = randomBytes(22).toString("base64url");
  if (rootValues.no_retry !== true) headers["opc-client-retries"] = "true";
  if (rootValues.request_id !== undefined) {
    const requestIdHeader =
      operation.headerParams?.["opc-request-id"] !== undefined
        ? "opc-request-id"
        : "opc-client-request-id";
    headers[requestIdHeader] = String(rootValues.request_id);
  }
  let keyId: string;
  let privateKey: KeyObject;
  if (principal) {
    keyId = principal.keyId;
    privateKey = principal.privateKey;
  } else {
    keyId = `${config.tenancy}/${config.user}/${config.fingerprint}`;
    if (settings.auth === "security_token") {
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
      const token = readFileSync(resolve(io.cwd, tokenPath), "utf8");
      keyId = `ST$${token}`;
    }
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
          ? await io.promptSecret("Private key passphrase:")
          : promptFromStdin(io, "Private key passphrase:");
        privateKey = loadWithErrors(prompted);
      } else {
        throw e;
      }
    }
  }
  const req = {
    method: operation.http,
    url: url.toString(),
    headers,
    body: requestBody,
  };
  prepareContentLength(req);
  const connectionTimeout = timeoutSecondsFor(
    rootValues.connection_timeout ?? config.connection_timeout,
  );
  const readTimeout = timeoutSecondsFor(
    rootValues.read_timeout ?? config.read_timeout,
  );
  const hasNoneRetry =
    command.bindings?.some((b) => b.transform === "NoneRetryStrategy") === true;
  const maxAttempts =
    rootValues.no_retry === true || hasNoneRetry
      ? 1
      : Math.max(1, Number(rootValues.max_retries) || 8);
  let response: Response;
  let raw: string;
  const pageItems: unknown[] = [];
  let nextPage: string | null = null;
  let page = url.searchParams.get("page");
  do {
    const pageUrl = new URL(baseUrl);
    if (page !== null) pageUrl.searchParams.set("page", page);
    else pageUrl.searchParams.delete("page");
    req.url = pageUrl.toString();
    for (let attempt = 1; ; attempt++) {
      delete req.headers.date;
      delete req.headers.authorization;
      signRequest(req, { keyId, privateKey });
      const controller = new AbortController();
      const connectionTimer =
        connectionTimeout === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new DOMException("Connection timed out", "TimeoutError"),
                ),
              connectionTimeout * 1000,
            );
      const readTimer =
        readTimeout === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new DOMException("Response read timed out", "TimeoutError"),
                ),
              readTimeout * 1000,
            );
      try {
        response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body ? { body: req.body } : {}),
          ...(connectionTimer === undefined && readTimer === undefined
            ? {}
            : { signal: controller.signal }),
        });
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        raw = await response.text();
      } catch (e) {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        if (readTimer !== undefined) clearTimeout(readTimer);
        if (attempt >= maxAttempts) throw e;
        const delay = Math.min(
          1000 * 2 ** (attempt - 1) + Math.random() * 1000,
          30000,
        );
        await Bun.sleep(delay);
        continue;
      } finally {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        if (readTimer !== undefined) clearTimeout(readTimer);
      }
      if (attempt >= maxAttempts || !retryableResponse(response, raw)) break;
      const delay = Math.min(
        1000 * 2 ** (attempt - 1) + Math.random() * 1000,
        30000,
      );
      await Bun.sleep(delay);
    }
    if (rootValues.debug === true) {
      io.err(`DEBUG:oci.base_client: Request: ${req.method} ${req.url}\n`);
      io.err(`DEBUG:oci.base_client: Response status: ${response.status}\n`);
    }
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
  return { operation, url, response, raw, allPages, pageItems };
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

function warnFilePermissions(io: Invocation, file: string) {
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

function promptFromStdin(io: Invocation, prompt: string): string {
  io.err(`Warning: Password input may be echoed.\n${prompt}\n`);
  const line = (io.stdin ?? "").split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

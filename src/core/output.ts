// A Generated command's result as oci prints it: the ServiceError envelope for a failed
// call; otherwise the data/etag/opc-next-page document, filtered by --query (or an rc canned
// query) and printed as JSON (keys sorted), a table, or --raw-output text.
import { Exit, type Invocation } from "../lib/io.ts";
import { formatAsciiTable } from "../utils/asciiTable.ts";
import { inheritedDiscriminator, type Models } from "./camelize.ts";
import type { OperationResult } from "./operation.ts";
import {
  type CompiledExpression,
  JMESPathError,
  compileQuery,
  writeJmespathError,
} from "../lib/query.ts";
import type { Rc } from "./rc.ts";
import type { OperationSpec } from "./spec.ts";

export type OutputOptions = {
  /** --query: a JMESPath expression or `query://<canned query name>`. */
  query?: unknown;
  /** --output: json (default) or table. */
  output?: unknown;
  /** --raw-output. */
  rawOutput?: unknown;
  rc: Pick<Rc, "cannedQueries" | "path">;
};

export class ModelDeserializationError extends Error {
  constructor(
    readonly pythonType: string,
    message: string,
  ) {
    super(message);
  }
}

const floatFields = new WeakMap<object, Set<string>>();
const floatArrays = new WeakSet<unknown[]>();
const floatDicts = new WeakSet<object>();

export function formatPythonFloat(n: number): string {
  if (Object.is(n, -0)) return "-0.0";
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    return n.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

function formatSdkDatetime(value: string): string {
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) return value.replace(/Z$/, "+00:00");
  const [, datePart, timePart = "00:00:00", fracRaw, tzRaw] = m;
  let frac = "";
  if (fracRaw) {
    const micros = fracRaw.slice(0, 6).padEnd(6, "0");
    if (micros !== "000000") frac = `.${micros}`;
  }
  let tz = "+00:00";
  if (tzRaw && tzRaw !== "Z" && tzRaw !== "z") {
    tz = tzRaw.includes(":") ? tzRaw : `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}`;
    if (tz === "-00:00") tz = "+00:00";
  }
  return `${datePart}T${timePart}${frac}${tz}`;
}

function formatSdkDate(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1]! : value;
}

/**
 * Print the result on the invocation's sinks. A non-2xx response prints the ServiceError
 * and ends the invocation with Exit(1), as does an undefined canned query.
 */
export function printResult(
  io: Invocation,
  result: OperationResult,
  options: OutputOptions,
): void {
  const { operation, url, response, raw, targetService, requestId } = result;
  if (!response.ok) {
    io.err(
      formatServiceError(
        operation,
        url,
        response,
        raw,
        targetService,
        requestId,
      ),
    );
    throw new Exit(1);
  }
  try {
    if (result.limitedData) {
      const data = result.limitedData.value;
      renderCliData(
        io,
        operation.responseType?.startsWith("list[")
          ? renderModel(data, operation.responseType, result.responseModels)
          : data,
        response.headers,
        options,
        { hasAllPagesParam: true },
      );
      return;
    }
    renderGeneratedResponse(
      io,
      operation,
      response,
      raw,
      result.responseModels,
      result.pageItems,
      result.allPages,
      options,
      result.rawPages,
    );
  } catch (e) {
    if (e instanceof ModelDeserializationError) {
      io.err(`${e.pythonType}: ${e.message}\n`);
      throw new Exit(1);
    }
    throw e;
  }
}

/**
 * OCI Python SDK clients that do NOT enable DEFAULT_CIRCUIT_BREAKER_STRATEGY by default.
 * All other generated service clients enable it, turning transient statuses into
 * TransientServiceError instead of ServiceError.
 */
const NO_DEFAULT_CIRCUIT_BREAKER_SERVICES = new Set(["compute", "stream"]);

function isTransientServiceError(
  status: number,
  code: unknown,
  targetService?: string,
): boolean {
  if (
    targetService !== undefined &&
    NO_DEFAULT_CIRCUIT_BREAKER_SERVICES.has(targetService)
  ) {
    return false;
  }
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  return (
    status === 409 && (code === "IncorrectState" || code === "LockConflict")
  );
}

/** Match `oci.util.camel_to_snake` for extra fields on a ServiceError JSON body. */
function camelToSnake(name: string): string {
  return name
    .replace(/(.)([A-Z][a-z]+)/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function formatServiceError(
  operation: Pick<OperationSpec, "http" | "method">,
  url: URL | string,
  response: Response,
  raw: string,
  targetService?: string,
  requestId?: string,
): string {
  let deserialized: unknown = raw;
  let parsedJson = false;
  try {
    deserialized = JSON.parse(raw);
    parsedJson = true;
  } catch {
    // Non-JSON error bodies stay as the raw string (BaseClient.deserialize_response_data).
  }
  let code: unknown = null;
  let rawMessage: unknown;
  let extraDetails: Record<string, unknown> | undefined;
  if (parsedJson && isPlainObject(deserialized)) {
    if ("code" in deserialized) code = deserialized.code;
    if ("message" in deserialized) rawMessage = deserialized.message;
    extraDetails = deserialized;
  } else {
    rawMessage = deserialized;
  }
  let message: string;
  if (rawMessage === undefined || rawMessage === null) {
    message = `The service returned error code ${response.status}`;
  } else {
    const msgStr =
      typeof rawMessage === "string"
        ? rawMessage
        : formatPythonRepr(rawMessage);
    message = msgStr || `The service returned error code ${response.status}`;
  }
  const rawUrl = typeof url === "string" ? url : url.toString();
  const queryIndex = rawUrl.indexOf("?");
  const endpointUrl = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const timestamp = new Date().toISOString().replace(/Z$/, "000+00:00");
  const serviceError: Record<string, unknown> = {
    code,
    message,
    ...(targetService !== undefined ? { target_service: targetService } : {}),
    client_version: "Oracle-PythonSDK/2.192.0, Oracle-PythonCLI/3.96.3",
    logging_tips:
      "Please run the OCI CLI command using --debug flag to find more debug information.",
    "opc-request-id": response.headers.get("opc-request-id") || requestId || "",
    operation_name: operation.method,
    request_endpoint: `${operation.http} ${endpointUrl}`,
    status: response.status,
    timestamp,
    troubleshooting_tips:
      "See [https://docs.oracle.com/iaas/Content/API/References/apierrors.htm] for more information about resolving this error. If you are unable to resolve this issue, run this CLI command with --debug option and contact Oracle support and provide them the full error message.",
  };
  if (extraDetails) {
    for (const [k, v] of Object.entries(extraDetails)) {
      const snake = camelToSnake(k);
      if (!(snake in serviceError)) {
        serviceError[snake] = v;
      }
    }
  }
  const excName = isTransientServiceError(response.status, code, targetService)
    ? "TransientServiceError"
    : "ServiceError";
  return `${excName}:\n${JSON.stringify(sortJson(serviceError), null, 4)}\n`;
}

function renderGeneratedResponse(
  io: Invocation,
  operation: OperationSpec,
  response: Response,
  raw: string,
  models: Models[string] | undefined,
  pageItems: unknown[],
  allPages: boolean,
  options: OutputOptions,
  rawPages?: string[],
): void {
  const isWrappedCollectionAll =
    allPages &&
    Boolean(operation.responseType) &&
    !operation.responseType!.startsWith("list[") &&
    Boolean(rawPages?.length);
  const hasBody =
    isWrappedCollectionAll ||
    (Boolean(operation.responseType) && raw.trim().length > 0);
  let value: unknown;
  if (isWrappedCollectionAll && rawPages) {
    const aggregated: Record<string, unknown[]> = {};
    for (const pageRaw of rawPages) {
      const trimmed = pageRaw.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(pageRaw);
      } catch {
        continue;
      }
      const rendered = renderModel(parsed, operation.responseType!, models);
      if (isPlainObject(rendered)) {
        for (const [k, v] of Object.entries(rendered)) {
          if (Array.isArray(v)) {
            if (!aggregated[k]) {
              aggregated[k] = [];
              if (floatArrays.has(v)) floatArrays.add(aggregated[k]!);
            }
            aggregated[k]!.push(...v);
          }
        }
      }
    }
    value = aggregated;
  } else if (hasBody) {
    let parsed: unknown;
    let parsedOk = false;
    try {
      parsed = JSON.parse(raw);
      parsedOk = true;
    } catch {
      value = raw;
    }
    if (parsedOk) {
      value =
        typeof parsed === "string"
          ? parsed
          : operation.responseType === "str"
            ? raw
            : renderModel(
                allPages && operation.responseType?.startsWith("list[")
                  ? pageItems
                  : operation.responseType?.startsWith("list[") &&
                      parsed &&
                      typeof parsed === "object" &&
                      "items" in parsed &&
                      Array.isArray(parsed.items)
                    ? parsed.items
                    : parsed,
                operation.responseType!,
                models,
              );
    }
  }
  const output: Record<string, unknown> = {};
  const isEmptyDict =
    isPlainObject(value) &&
    Object.keys(value).length === 0 &&
    (isWrappedCollectionAll || !models?.[operation.responseType ?? ""]);
  if (
    hasBody &&
    value !== null &&
    value !== undefined &&
    value !== "" &&
    !(Array.isArray(value) && value.length === 0) &&
    !isEmptyDict
  )
    output.data = value;
  for (const [rawKey, headerVal] of response.headers) {
    const key = rawKey.toLowerCase();
    if (!DISPLAY_HEADERS.has(key)) continue;
    if (key === "opc-next-page" && allPages) continue;
    output[key] = headerVal;
  }
  const printed = renderDocument(io, output, options);
  if (printed && response.headers.get("opc-next-page") !== null && !allPages) {
    io.err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
}

export const DISPLAY_HEADERS = new Set([
  "etag",
  "opc-next-cursor",
  "opc-next-page",
  "opc-total-items",
  "opc-work-request-id",
]);

export type RenderCliDataOptions = {
  displayAllHeaders?: boolean;
  nestDataInDataAttribute?: boolean;
  hasAllPagesParam?: boolean;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isDisplayTruthy = (v: unknown): boolean => {
  if (v === null || v === undefined || v === false || v === 0 || v === "")
    return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
};

function resolveAndCompileQuery(
  io: Invocation,
  options: OutputOptions,
): CompiledExpression | null {
  let query = options.query;
  if (typeof query !== "string" || query.length === 0) return null;
  if (query.startsWith("query://")) {
    const queryName = query.slice("query://".length);
    query = options.rc.cannedQueries[queryName];
    if (query === undefined) {
      io.err(
        `UsageError: Query ${queryName} is not defined in your OCI CLI configuration file: ${options.rc.path}\n`,
      );
      throw new Exit(1);
    }
  }
  try {
    return compileQuery(query as string);
  } catch (err) {
    if (err instanceof JMESPathError) writeJmespathError(io, err);
    throw err;
  }
}

function searchQuery(
  io: Invocation,
  expression: CompiledExpression,
  value: unknown,
): unknown {
  try {
    return expression.search(value);
  } catch (err) {
    if (err instanceof JMESPathError) writeJmespathError(io, err);
    throw err;
  }
}

class TableRenderError extends Error {
  constructor(
    readonly pythonType: string,
    message: string,
  ) {
    super(message);
  }
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function renderDisplayValue(
  io: Invocation,
  displayDict: unknown,
  expression: CompiledExpression | null,
  options: OutputOptions,
): boolean {
  const hasQuery = expression !== null;
  const displayData = hasQuery
    ? searchQuery(io, expression, displayDict)
    : displayDict;
  if (displayData === null || displayData === undefined) {
    io.err("Query returned empty result, no output to show.\n");
    return false;
  }
  const format = options.output ?? "json";
  if (format === "table") {
    // oci_cli.cli_util.render evaluates `if 'data' in display_data and not expression:`
    // which raises TypeError when display_data is non-iterable (int, float, bool).
    if (typeof displayData === "number" || typeof displayData === "boolean") {
      io.err(
        `TypeError: argument of type '${pyTypeName(displayData)}' is not iterable\n`,
      );
      throw new Exit(1);
    }
    let tableData: unknown = displayData;
    if (!hasQuery) {
      if (isPlainObject(displayData) && "data" in displayData) {
        tableData = displayData.data;
      } else if (
        typeof displayData === "string" &&
        displayData.includes("data")
      ) {
        io.err("TypeError: string indices must be integers, not 'str'\n");
        throw new Exit(1);
      } else if (Array.isArray(displayData) && displayData.includes("data")) {
        io.err("TypeError: list indices must be integers or slices, not str\n");
        throw new Exit(1);
      }
    }
    try {
      io.out(renderTable(tableData));
    } catch (err) {
      if (err instanceof TableRenderError) {
        io.err(`${err.pythonType}: ${err.message}\n`);
        throw new Exit(1);
      }
      throw err;
    }
    if (isPlainObject(displayDict) && "data" in displayDict) {
      for (const [key, value] of Object.entries(displayDict)) {
        if (key !== "data") io.err(`${key}: ${String(value)}\n`);
      }
    }
  } else if (options.rawOutput && typeof displayData === "string") {
    io.out(`${displayData}\n`);
  } else {
    io.out(`${JSON.stringify(sortJson(displayData), null, 2)}\n`);
  }
  return true;
}

/**
 * Matches `oci_cli.cli_util.render(data, headers, ctx, display_all_headers=False,
 * nest_data_in_data_attribute=True)`.
 */
export function renderCliData(
  io: Invocation,
  data: unknown,
  headers: Iterable<[string, unknown]> | null,
  options: OutputOptions,
  renderOpts: RenderCliDataOptions = {},
): void {
  const displayAllHeaders = renderOpts.displayAllHeaders ?? false;
  const nestData = renderOpts.nestDataInDataAttribute ?? true;
  let displayDict: unknown = {};
  if (isDisplayTruthy(data)) {
    if (nestData) {
      (displayDict as Record<string, unknown>).data = data;
    } else {
      displayDict = isPlainObject(data) ? { ...data } : data;
    }
  }
  const expression = resolveAndCompileQuery(io, options);
  let opcNextPage: unknown = undefined;
  if (headers) {
    for (const [rawKey, value] of headers) {
      const key = rawKey.toLowerCase();
      if (key === "opc-next-page") opcNextPage = value;
      if (
        (DISPLAY_HEADERS.has(key) || displayAllHeaders) &&
        isPlainObject(displayDict)
      ) {
        displayDict[key] = value ?? null;
      }
    }
  }
  if (isDisplayTruthy(displayDict)) {
    const printed = renderDisplayValue(io, displayDict, expression, options);
    if (!printed) return;
  }
  if (isDisplayTruthy(opcNextPage) && renderOpts.hasAllPagesParam) {
    io.err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
}

/** Render an already-shaped response document (data and/or headers) with --query/--output/--raw-output.
 * Returns false if `--query` returned an empty result and returned early (skipping pagination notices). */
export function renderDocument(
  io: Invocation,
  output: unknown,
  options: OutputOptions,
): boolean {
  const expression = resolveAndCompileQuery(io, options);
  if (
    output === null ||
    output === undefined ||
    (Array.isArray(output) && output.length === 0) ||
    (typeof output === "object" &&
      !Array.isArray(output) &&
      Object.keys(output).length === 0)
  )
    return true;
  return renderDisplayValue(io, output, expression, options);
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const jsonRaw = (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON;

function sortJson(value: unknown, asFloat = false): unknown {
  if (asFloat && typeof value === "number" && Number.isFinite(value)) {
    return jsonRaw(formatPythonFloat(value));
  }
  if (Array.isArray(value)) {
    const isFloatArr = floatArrays.has(value);
    return value.map((item) => sortJson(item, isFloatArr));
  }
  if (value && typeof value === "object") {
    const isFloatDict = floatDicts.has(value);
    const floats = floatFields.get(value);
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodepoints(a, b))
        .map(([k, v]) => [
          k,
          sortJson(v, isFloatDict || Boolean(floats?.has(k))),
        ]),
    );
  }
  return value;
}

function applyEnum(
  name: string,
  fieldType: string,
  value: unknown,
  allowed: string[],
  strict: boolean,
): unknown {
  const formatAllowed = () => `[${allowed.map((v) => `'${v}'`).join(", ")}]`;
  if (fieldType === "list[str]" && Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || item === undefined) return item;
      const str = String(item);
      if (allowed.includes(str)) return item;
      if (strict) {
        throw new ModelDeserializationError(
          "ValueError",
          `Invalid value for \`${name}\`, must be None or one of ${formatAllowed()}`,
        );
      }
      return "UNKNOWN_ENUM_VALUE";
    });
  }
  if (value === null || value === undefined) return value;
  const str = String(value);
  if (allowed.includes(str)) return value;
  if (strict) {
    throw new ModelDeserializationError(
      "ValueError",
      `Invalid value for \`${name}\`, must be None or one of ${formatAllowed()}`,
    );
  }
  return "UNKNOWN_ENUM_VALUE";
}

export function renderModel(
  value: unknown,
  type: string,
  models?: Models[string],
  snakeCase = false,
): unknown {
  if (value === null || value === undefined) return value;
  if (type === "datetime" && typeof value === "string")
    return formatSdkDatetime(value);
  if (type === "date" && typeof value === "string") return formatSdkDate(value);
  if (type === "int") {
    if (typeof value === "number") return Math.trunc(value);
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim()))
      return Number.parseInt(value, 10);
    return value;
  }
  if (type === "float") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    return value;
  }
  if (type === "bool") {
    return typeof value === "boolean" ? value : Boolean(value);
  }
  if (type === "str") {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "number") return String(value);
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const element = /^list\[(.*)\]$/.exec(type)?.[1];
    const mapped = element
      ? value.map((item) => renderModel(item, element, models, snakeCase))
      : value;
    if (element === "float") floatArrays.add(mapped);
    return mapped;
  }
  const data = value as Record<string, unknown>;
  const dictValue = /^dict\([^,]+, (.*)\)$/.exec(type)?.[1];
  if (dictValue) {
    const mapped = Object.fromEntries(
      Object.entries(data).map(([key, item]) => [
        key,
        renderModel(item, dictValue, models, snakeCase),
      ]),
    );
    if (dictValue === "float") floatDicts.add(mapped);
    return mapped;
  }
  let model = models?.[type];
  if (!model) return data;
  const disc = inheritedDiscriminator(models?.[type] ? models : {}, model);
  if (disc && typeof disc !== "string") {
    if (!Object.hasOwn(data, disc.field)) {
      throw new ModelDeserializationError("KeyError", `'${disc.field}'`);
    }
    const key = data[disc.field];
    const subtype =
      typeof key === "string" && Object.hasOwn(disc.values, key)
        ? disc.values[key]
        : disc.fallback;
    model = models?.[subtype!] ?? model;
  }
  const out: Record<string, unknown> = {};
  let floats: Set<string> | undefined;
  for (const [name, fieldType, wire] of model.attributes) {
    const outKey = snakeCase ? name : name.replaceAll("_", "-");
    const rawVal = Object.hasOwn(data, wire)
      ? data[wire]
      : Object.hasOwn(data, name)
        ? data[name]
        : null;
    let fieldVal = renderModel(rawVal, fieldType, models, snakeCase);
    const allowed = model.enums?.[name];
    const strictAllowed = model.strictEnums?.[name];
    if (allowed) {
      fieldVal = applyEnum(name, fieldType, fieldVal, allowed, false);
    } else if (strictAllowed) {
      fieldVal = applyEnum(name, fieldType, fieldVal, strictAllowed, true);
    }
    if (fieldType === "float" && typeof fieldVal === "number") {
      (floats ??= new Set()).add(outKey);
    }
    out[outKey] = fieldVal;
  }
  if (floats) floatFields.set(out, floats);
  return out;
}

function formatPythonStringRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + quote;
}

function formatPythonRepr(value: unknown, asFloat = false): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return asFloat ? formatPythonFloat(value) : String(value);
  if (typeof value === "string") return formatPythonStringRepr(value);
  if (Array.isArray(value)) {
    const isFloatArr = floatArrays.has(value);
    return `[${value.map((item) => formatPythonRepr(item, isFloatArr)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const isFloatDict = floatDicts.has(value);
    const floats = floatFields.get(value);
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) =>
        `${formatPythonStringRepr(k)}: ${formatPythonRepr(v, isFloatDict || Boolean(floats?.has(k)))}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

function formatTableCell(value: unknown, asFloat = false): string {
  if (value === undefined) return "";
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return asFloat ? formatPythonFloat(value) : String(value);
  if (typeof value === "string") return value;
  return formatPythonRepr(value, asFloat);
}

/** Matches `oci_cli.cli_util.print_table(data)`. */
function renderTable(value: unknown): string {
  const tableData: string[][] = [];

  if (typeof value === "string") {
    tableData.push(["Column1"]);
    tableData.push([value]);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      return "Command returned empty list, no table to display.\n";
    }
    const isFloatArr = floatArrays.has(value);
    const first = value[0];
    if (typeof first === "string") {
      tableData.push(["Column1"]);
      for (const row of value) {
        tableData.push([formatTableCell(row, isFloatArr)]);
      }
    } else if (isPlainObject(first)) {
      const cols = new Set<string>();
      for (const entry of value) {
        if (!isPlainObject(entry)) {
          throw new TableRenderError(
            "AttributeError",
            `'${pyTypeName(entry)}' object has no attribute 'keys'`,
          );
        }
        for (const key of Object.keys(entry)) cols.add(key);
      }
      const headers = [...cols].sort(compareCodepoints);
      tableData.push(headers);
      for (const entry of value) {
        const rec = entry as Record<string, unknown>;
        const isFloatDict = floatDicts.has(rec);
        const floats = floatFields.get(rec);
        tableData.push(
          headers.map((key) =>
            Object.hasOwn(rec, key)
              ? formatTableCell(
                  rec[key],
                  isFloatDict || Boolean(floats?.has(key)),
                )
              : "",
          ),
        );
      }
    } else if (Array.isArray(first)) {
      const headers = Array.from(
        { length: first.length },
        (_, i) => `Column${i + 1}`,
      );
      tableData.push(headers);
      for (const row of value) {
        if (Array.isArray(row)) {
          const rowIsFloat = floatArrays.has(row);
          tableData.push(row.map((cell) => formatTableCell(cell, rowIsFloat)));
        } else if (typeof row === "string") {
          tableData.push([...row]);
        } else if (isPlainObject(row)) {
          tableData.push(Object.keys(row));
        } else {
          throw new TableRenderError(
            "TypeError",
            `object of type '${pyTypeName(row)}' has no len()`,
          );
        }
      }
    } else {
      tableData.push(["Column1"]);
      for (const row of value) {
        tableData.push([formatTableCell(row, isFloatArr)]);
      }
    }
  } else if (isPlainObject(value)) {
    const isFloatDict = floatDicts.has(value);
    const floats = floatFields.get(value);
    const headers = Object.keys(value).sort(compareCodepoints);
    tableData.push(headers);
    tableData.push(
      headers.map((key) =>
        formatTableCell(value[key], isFloatDict || Boolean(floats?.has(key))),
      ),
    );
  } else {
    return `Table format not supported for operation return type: ${formatTableCell(value)}\n`;
  }

  return formatAsciiTable(tableData);
}

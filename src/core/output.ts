// A Generated command's result as oci prints it: the ServiceError envelope for a failed
// call; otherwise the data/etag/opc-next-page document, filtered by --query (or an rc canned
// query) and printed as JSON (keys sorted), a table, or --raw-output text.
import { Exit, type Invocation } from "../lib/io.ts";
import { inheritedDiscriminator, type Models } from "./camelize.ts";
import type { OperationResult } from "./operation.ts";
import { applyQuery } from "../lib/query.ts";
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
  if (response.headers.get("opc-next-page") !== null && !allPages) {
    io.err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
  renderDocument(io, output, options);
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
  let query = options.query;
  if (typeof query === "string" && query.startsWith("query://")) {
    const queryName = query.slice("query://".length);
    query = options.rc.cannedQueries[queryName];
    if (query === undefined) {
      io.err(
        `UsageError: Query ${queryName} is not defined in your OCI CLI configuration file: ${options.rc.path}\n`,
      );
      throw new Exit(1);
    }
  }
  if (isDisplayTruthy(displayDict)) {
    const hasQuery = typeof query === "string";
    const displayData = hasQuery
      ? applyQuery(displayDict, query as string)
      : displayDict;
    if (displayData === null) {
      io.err("Query returned empty result, no output to show.\n");
      return;
    }
    const format = options.output ?? "json";
    if (format === "table") {
      const tableData =
        !hasQuery && isPlainObject(displayData) && "data" in displayData
          ? displayData.data
          : displayData;
      io.out(renderTable(tableData));
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
  }
  if (isDisplayTruthy(opcNextPage) && renderOpts.hasAllPagesParam) {
    io.err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
}

/** Render an already-shaped response document (data and/or headers) with --query/--output/--raw-output. */
export function renderDocument(
  io: Invocation,
  output: unknown,
  options: OutputOptions,
): void {
  const { rc } = options;
  let query = options.query;
  if (typeof query === "string" && query.startsWith("query://")) {
    const queryName = query.slice("query://".length);
    query = rc.cannedQueries[queryName];
    if (query === undefined) {
      io.err(
        `UsageError: Query ${queryName} is not defined in your OCI CLI configuration file: ${rc.path}\n`,
      );
      throw new Exit(1);
    }
  }
  if (
    output === null ||
    output === undefined ||
    (Array.isArray(output) && output.length === 0) ||
    (typeof output === "object" &&
      !Array.isArray(output) &&
      Object.keys(output).length === 0)
  )
    return;
  const hasQuery = typeof query === "string";
  const rendered = hasQuery ? applyQuery(output, query as string) : output;
  if (rendered === null || (Array.isArray(rendered) && rendered.length === 0)) {
    io.err("Query returned empty result, no output to show.\n");
  } else {
    const format = options.output ?? "json";
    const tableValue =
      !hasQuery && isPlainObject(rendered) && "data" in rendered
        ? rendered.data
        : rendered;
    if (format === "table") {
      io.out(renderTable(tableValue));
      if (isPlainObject(output) && "data" in output) {
        for (const [key, value] of Object.entries(output)) {
          if (key !== "data") io.err(`${key}: ${String(value)}\n`);
        }
      }
    } else if (options.rawOutput && typeof rendered === "string")
      io.out(`${rendered}\n`);
    else io.out(`${JSON.stringify(sortJson(rendered), null, 2)}\n`);
  }
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

function renderTable(value: unknown): string {
  type Cell = { value: unknown; asFloat: boolean };
  const rows: Cell[][] = [];
  let headers: string[];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value[0] &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0])
  ) {
    const cols = new Set<string>();
    for (const entry of value) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        for (const key of Object.keys(entry as Record<string, unknown>))
          cols.add(key);
      }
    }
    headers = [...cols].sort(compareCodepoints);
    for (const entry of value) {
      const rec =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const isFloatDict = floatDicts.has(rec);
      const floats = floatFields.get(rec);
      rows.push(
        headers.map((key) => ({
          value: Object.hasOwn(rec, key) ? rec[key] : undefined,
          asFloat: isFloatDict || Boolean(floats?.has(key)),
        })),
      );
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const isFloatDict = floatDicts.has(rec);
    const floats = floatFields.get(rec);
    headers = Object.keys(rec).sort(compareCodepoints);
    rows.push(
      headers.map((key) => ({
        value: rec[key],
        asFloat: isFloatDict || Boolean(floats?.has(key)),
      })),
    );
  } else {
    const rawRows: unknown[][] = Array.isArray(value)
      ? value.map((item) => (Array.isArray(item) ? item : [item]))
      : [Array.isArray(value) ? value : [value]];
    const isFloatArr = Array.isArray(value) && floatArrays.has(value);
    const width = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
    headers = Array.from({ length: width }, (_, i) => `Column${i + 1}`);
    for (const row of rawRows) {
      rows.push(row.map((cell) => ({ value: cell, asFloat: isFloatArr })));
    }
  }
  const formatted = rows.map((row) =>
    headers.map((_, i) => {
      const cell = row[i];
      return cell ? formatTableCell(cell.value, cell.asFloat) : "";
    }),
  );
  const widths = headers.map((header, i) =>
    Math.max(
      [...header].length,
      ...formatted.map((row) => [...(row[i] ?? "")].length),
    ),
  );
  const border = `+${widths.map((w) => `-${"-".repeat(w)}-`).join("+")}+`;
  const line = (values: string[]) =>
    `| ${values.map((v, i) => v + " ".repeat(Math.max(0, (widths[i] ?? 0) - [...v].length))).join(" | ")} |`;
  return `${border}\n${line(headers)}\n${border}\n${formatted.map((row) => line(row)).join("\n")}${formatted.length ? "\n" : ""}${border}\n`;
}

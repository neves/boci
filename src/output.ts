// A Generated command's result as oci prints it: the ServiceError envelope for a failed
// call; otherwise the data/etag/opc-next-page document, filtered by --query (or an rc canned
// query) and printed as JSON (keys sorted), a table, or --raw-output text.
import { Exit, type Invocation } from "./io.ts";
import type { OperationResult } from "./operation.ts";
import { applyQuery } from "./query.ts";
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

/**
 * Print the result on the invocation's sinks. A non-2xx response prints the ServiceError
 * and ends the invocation with Exit(1), as does an undefined canned query.
 */
export function printResult(
  io: Invocation,
  result: OperationResult,
  options: OutputOptions,
): void {
  const { operation, url, response, raw, targetService } = result;
  if (!response.ok) {
    io.err(formatServiceError(operation, url, response, raw, targetService));
    throw new Exit(1);
  }
  renderGeneratedResponse(
    io,
    operation,
    response,
    raw,
    result.pageItems,
    result.allPages,
    options,
  );
}

export function formatServiceError(
  operation: Pick<OperationSpec, "http" | "method">,
  url: URL | string,
  response: Response,
  raw: string,
  targetService?: string,
): string {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      details = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies still produce the standard ServiceError envelope.
  }
  const timestamp = new Date().toISOString().replace(/Z$/, "000+00:00");
  const serviceError: Record<string, unknown> = {
    code: null,
    message: `The service returned error code ${response.status}`,
    ...(targetService !== undefined ? { target_service: targetService } : {}),
    ...details,
    client_version: "Oracle-PythonSDK/2.192.0, Oracle-PythonCLI/3.96.3",
    logging_tips:
      "Please run the OCI CLI command using --debug flag to find more debug information.",
    "opc-request-id": response.headers.get("opc-request-id") ?? "",
    operation_name: operation.method,
    request_endpoint: `${operation.http} ${url.toString()}`,
    status: response.status,
    timestamp,
    troubleshooting_tips:
      "See [https://docs.oracle.com/iaas/Content/API/References/apierrors.htm] for more information about resolving this error. If you are unable to resolve this issue, run this CLI command with --debug option and contact Oracle support and provide them the full error message.",
  };
  return `ServiceError:\n${JSON.stringify(sortJson(serviceError), null, 4)}\n`;
}

function renderGeneratedResponse(
  io: Invocation,
  operation: OperationSpec,
  response: Response,
  raw: string,
  pageItems: unknown[],
  allPages: boolean,
  options: OutputOptions,
): void {
  const { rc } = options;
  const hasBody = raw.trim().length > 0;
  let value: unknown;
  if (hasBody) {
    try {
      const parsed: unknown = JSON.parse(raw);
      value =
        typeof parsed === "string"
          ? parsed
          : operation.method === "get_namespace"
            ? raw
            : mapResponseKeys(
                allPages && operation.responseType?.startsWith("list[")
                  ? pageItems
                  : operation.responseType?.startsWith("list[") &&
                      parsed &&
                      typeof parsed === "object" &&
                      "items" in parsed &&
                      Array.isArray(parsed.items)
                    ? parsed.items
                    : parsed,
              );
    } catch {
      value = raw;
    }
  }
  const output: Record<string, unknown> = {};
  if (hasBody) output.data = value;
  const etag = response.headers.get("etag");
  const hasNextPage = response.headers.get("opc-next-page");
  if (etag !== null) output.etag = etag;
  if (hasNextPage !== null && !allPages) {
    output["opc-next-page"] = hasNextPage;
    io.err(
      "WARNING: This operation supports pagination and not all resources were returned.  Re-run using the --all option to auto paginate and list all resources.\n",
    );
  }
  renderDocument(io, output, options);
}

/** Render an already-shaped response document (data and/or headers) with --query/--output/--raw-output. */
export function renderDocument(
  io: Invocation,
  output: unknown,
  options: OutputOptions,
): void {
  const { rc } = options;
  if (
    output === null ||
    output === undefined ||
    (Array.isArray(output) && output.length === 0) ||
    (typeof output === "object" &&
      !Array.isArray(output) &&
      Object.keys(output).length === 0)
  )
    return;
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
  const rendered =
    typeof query === "string" ? applyQuery(output, query) : output;
  if (rendered === null || (Array.isArray(rendered) && rendered.length === 0)) {
    io.err("Query returned empty result, no output to show.\n");
  } else {
    const format = options.output ?? "json";
    const tableValue =
      rendered &&
      typeof rendered === "object" &&
      !Array.isArray(rendered) &&
      "data" in rendered
        ? (rendered as Record<string, unknown>).data
        : rendered;
    if (format === "table") io.out(renderTable(tableValue));
    else if (options.rawOutput && typeof rendered === "string")
      io.out(`${rendered}\n`);
    else io.out(`${JSON.stringify(sortJson(rendered), null, 2)}\n`);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortJson(v)]),
    );
  return value;
}

function mapResponseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapResponseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        mapResponseKeys(item),
      ]),
    );
  return value;
}

function renderTable(value: unknown): string {
  const rows: unknown[][] = Array.isArray(value)
    ? value.map((item) => (Array.isArray(item) ? item : [item]))
    : [Array.isArray(value) ? value : [value]];
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
    headers = [...cols].sort();
    for (let i = 0; i < rows.length; i++)
      rows[i] = headers.map(
        (key) => (value[i] as Record<string, unknown>)[key],
      );
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    headers = Object.keys(value as Record<string, unknown>).sort();
    rows[0] = headers.map((key) => (value as Record<string, unknown>)[key]);
  } else {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    headers = Array.from({ length: width }, (_, i) => `Column${i + 1}`);
  }
  const cell = (v: unknown) =>
    v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cell(row[i]).length)),
  );
  const border = `+${widths.map((w) => `-${"-".repeat(w)}-`).join("+")}+`;
  const line = (values: string[]) =>
    `| ${values.map((v, i) => v.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return `${border}\n${line(headers)}\n${border}\n${rows.map((row) => line(headers.map((_, i) => cell(row[i])))).join("\n")}${rows.length ? "\n" : ""}${border}\n`;
}

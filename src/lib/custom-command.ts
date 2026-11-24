// Building blocks for Custom (Tier C) commands: what the Reference CLI's hand-written
// wrappers do with `cli_util.build_client` + `client.<method>(...)` + `render_response`.
// `bun run scaffold <key>` generates commands on top of these.
import {
  callOperation,
  type GeneratedCommand,
  type OperationResult,
} from "../core/operation.ts";
import {
  printResult,
  renderModel,
  type OutputOptions,
} from "../core/output.ts";
import type { CustomCommandContext } from "../core/registry.ts";
import { loadService, type OperationSpec } from "../core/spec.ts";
import { waitForState } from "../core/waiter.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";
import { Exit } from "./io.ts";

/** The root --query/--output/--raw-output options `cli_util.render_response` honors. */
export function outputOptions(ctx: CustomCommandContext): OutputOptions {
  return {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  };
}

/** Extract list items from either a bare JSON array or `{ items: [...] }`. */
export function extractListItems(raw: string): unknown[] {
  const value = parseJsonBody(raw);
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && "items" in value) {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

/**
 * The Custom command `name` (path within ctx.spec's service, e.g. "volume-attachment list")
 * sending `operation`: its own params convert the values, the SDK operation sends them.
 * `client.<method>(...)` in a wrapper is `sdkCommand(ctx, name, <method>Operation)`.
 */
export function sdkCommand(
  ctx: CustomCommandContext,
  name: string,
  operation: OperationSpec,
  bindings: Record<string, unknown>[] = [],
): GeneratedCommand {
  const wrapper = ctx.spec.commands[name];
  if (!wrapper) throw new Error(`Missing ${ctx.spec.service} ${name} spec`);
  return {
    params: wrapper.params,
    complexTypes: wrapper.complexTypes,
    operation,
    bindings,
  };
}

/**
 * Send one request: either a Leaf command by name from `service`'s spec (a generated
 * command, whose operation and bindings are reused), or an explicit `command`.
 */
export async function callCommand(
  ctx: CustomCommandContext,
  service: string,
  name: string,
  values: Record<string, unknown>,
  command?: GeneratedCommand,
): Promise<OperationResult> {
  const spec =
    service === ctx.spec.service ? ctx.spec : await loadService(service);
  const operationCommand = command ?? (spec.commands[name] as GeneratedCommand);
  return callOperation(ctx.io, {
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    spec,
    index: ctx.index,
    command: operationCommand,
    values,
  });
}

/** How the wrapper pages: cli_util's `list_call_get_*` or their `_multiple_keys` variants. */
export type ListOptions = { multipleKeys?: boolean };

class PythonTypeError extends Error {}

type Attribute = { snake: string; key: string; wire: string; type?: string };

/**
 * A collection model's attributes as Python iterates them: sorted snake_case names,
 * aggregated under dashed keys. Without the model in the spec, the response's own keys.
 */
function collectionAttributes(
  result: OperationResult,
  data: Record<string, unknown>,
): Attribute[] {
  const model = result.responseModels?.[result.operation.responseType ?? ""];
  const attributes = model
    ? model.attributes.map(([snake, type, wire]) => ({ snake, wire, type }))
    : Object.keys(data).map((wire) => ({
        snake: wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        wire,
        type: undefined,
      }));
  return attributes
    .map((a) => ({ ...a, key: a.snake.replaceAll("_", "-") }))
    .sort((a, b) => (a.snake < b.snake ? -1 : a.snake > b.snake ? 1 : 0));
}

/** Python's len() of a deserialized attribute value. */
function pyLen(value: unknown, type?: string): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string" && type !== "datetime" && type !== "date")
    return [...value].length;
  if (
    typeof value === "object" &&
    value !== null &&
    (type === undefined || type.startsWith("dict("))
  )
    return Object.keys(value).length;
  const name =
    value === null || value === undefined
      ? "NoneType"
      : typeof value === "boolean"
        ? "bool"
        : typeof value === "number"
          ? type === "float" || (type !== "int" && !Number.isInteger(value))
            ? "float"
            : "int"
          : type === "datetime" || type === "date"
            ? `datetime.${type}`
            : (type ?? "object");
  throw new PythonTypeError(`object of type '${name}' has no len()`);
}

/** itertools.chain.from_iterable over the values one attribute had on each page. */
function pyChain(values: unknown[]): unknown[] {
  return values.flatMap((v) =>
    Array.isArray(v)
      ? v
      : typeof v === "string"
        ? [...v]
        : typeof v === "object" && v !== null
          ? Object.keys(v)
          : [],
  );
}

/**
 * A paginated list call honoring --all, --limit and --page-size the way
 * cli_util.list_call_get_all_results / list_call_get_up_to_limit (or, with
 * `multipleKeys`, their _multiple_keys variants) do. A failed page is rendered (and
 * exits) like render_response would.
 */
export async function listPages(
  ctx: CustomCommandContext,
  name: string,
  args: Record<string, unknown>,
  command?: GeneratedCommand,
  { multipleKeys = false }: ListOptions = {},
): Promise<{ items: unknown[]; lastResult: OperationResult }> {
  const options = outputOptions(ctx);
  const call = (values: Record<string, unknown>) =>
    callCommand(ctx, ctx.spec.service, name, values, command);
  const responseType = (command ?? ctx.spec.commands[name])?.operation
    ?.responseType;
  const collection = responseType && !responseType.startsWith("list[");
  const all = args.all_pages === true;
  const limited = typeof args.limit === "number";
  if ((!all && !limited) || (all && (!collection || limited))) {
    const result = await call(args);
    if (!result.response.ok) printResult(ctx.io, result, options);
    return {
      items: all ? result.pageItems : extractListItems(result.raw),
      lastResult: result,
    };
  }

  const limit = typeof args.limit === "number" ? args.limit : Infinity;
  const size =
    typeof args.page_size === "number" && args.page_size > 0
      ? args.page_size
      : Infinity;
  let remaining = limit;
  let page = args.page;
  // Python's aggregated_results_dict: per dashed key, the value of each page (a list
  // of them until chained), or the last scalar (_multiple_keys).
  const fields = new Map<string, { attribute: Attribute; value: unknown }>();
  const aggregated: unknown[] = [];
  let result: OperationResult;
  try {
    do {
      const count = Math.min(size, remaining);
      result = await call({
        ...args,
        page,
        all_pages: false,
        page_size: undefined,
        limit: Number.isFinite(count) ? count : undefined,
      });
      if (!result.response.ok) printResult(ctx.io, result, options);
      if (collection) {
        const data = (parseJsonBody(result.raw) ?? {}) as Record<
          string,
          unknown
        >;
        for (const attribute of collectionAttributes(result, data)) {
          const value = Object.hasOwn(data, attribute.wire)
            ? data[attribute.wire]
            : null;
          const pages = fields.get(attribute.key)?.value;
          if (Array.isArray(value) || (!multipleKeys && limited)) {
            fields.set(attribute.key, {
              attribute,
              value: [...(Array.isArray(pages) ? pages : []), value],
            });
            if (limited) remaining -= pyLen(value, attribute.type);
          } else if (multipleKeys)
            fields.set(attribute.key, { attribute, value });
        }
      } else {
        const items = extractListItems(result.raw);
        aggregated.push(...items);
        remaining -= items.length;
      }
      page = result.response.headers.get("opc-next-page");
    } while (page !== null && remaining > 0);
  } catch (e) {
    if (!(e instanceof PythonTypeError)) throw e;
    ctx.io.err(`TypeError: ${e.message}\n`);
    throw new Exit(1);
  }
  if (!collection) {
    const items = aggregated.slice(0, limit);
    return {
      items,
      lastResult: { ...result, allPages: all, raw: JSON.stringify(items) },
    };
  }
  // Chain each list attribute's pages; under --limit, cut them to the limit in key order.
  const data: Record<string, unknown> = Object.create(null);
  let keep = limit;
  for (const key of [...fields.keys()].sort()) {
    const { attribute, value } = fields.get(key)!;
    const isList = !multipleKeys || Array.isArray(value);
    if (!isList)
      data[key] = renderModel(
        value,
        attribute.type ?? "",
        result.responseModels,
      );
    else if (keep > 0) {
      const chained = pyChain(value as unknown[]);
      const kept = Number.isFinite(keep) ? chained.slice(0, keep) : chained;
      keep -= kept.length;
      data[key] = renderModel(
        kept,
        attribute.type ?? "",
        result.responseModels,
      );
    }
  }
  return {
    items: Array.isArray(data.items) ? data.items : [],
    // Already rendered: printResult must not render it as the collection model again.
    lastResult: {
      ...result,
      allPages: all,
      raw: JSON.stringify(data),
      responseModels: undefined,
    },
  };
}

/** listPages, rendered the way the wrapper's render_response would. */
export async function renderListPages(
  ctx: CustomCommandContext,
  name: string,
  args: Record<string, unknown>,
  command?: GeneratedCommand,
  list?: ListOptions,
): Promise<void> {
  const { lastResult } = await listPages(ctx, name, args, command, list);
  printResult(ctx.io, lastResult, outputOptions(ctx));
}

/**
 * The whole wrapper as one request with ctx.values, then the generated waiter block
 * (--wait-for-state / work requests) when the command has one.
 */
export async function runOperation(
  ctx: CustomCommandContext,
  name: string,
  operation: OperationSpec,
  bindings: Record<string, unknown>[] = [],
) {
  const call = {
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    spec: ctx.spec,
    index: ctx.index,
    command: sdkCommand(ctx, name, operation, bindings),
    values: ctx.values,
  };
  const result = await callOperation(ctx.io, call);
  return waitForState(ctx.io, call, result, outputOptions(ctx));
}

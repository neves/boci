// Building blocks for Custom (Tier C) commands: what the Reference CLI's hand-written
// wrappers do with `cli_util.build_client` + `client.<method>(...)` + `render_response`.
// `bun run scaffold <key>` generates commands on top of these.
import {
  callOperation,
  type GeneratedCommand,
  type OperationResult,
} from "../core/operation.ts";
import { printResult, type OutputOptions } from "../core/output.ts";
import type { CustomCommandContext } from "../core/registry.ts";
import { loadService, type OperationSpec } from "../core/spec.ts";
import { waitForState } from "../core/waiter.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";

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

/**
 * A paginated list call honoring --all, --limit and --page-size the way
 * cli_util.list_call_get_all_results / list_call_get_up_to_limit do. A failed page is
 * rendered (and exits) like render_response would.
 */
export async function listPages(
  ctx: CustomCommandContext,
  name: string,
  args: Record<string, unknown>,
  command?: GeneratedCommand,
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
  const fields: Record<string, unknown> = Object.create(null);
  const aggregated: unknown[] = [];
  let result: OperationResult;
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
      for (const [key, value] of Object.entries(JSON.parse(result.raw))) {
        if (Array.isArray(value)) {
          const previous = fields[key];
          fields[key] = Array.isArray(previous)
            ? previous.concat(value)
            : value;
          remaining -= value.length;
        } else fields[key] = value;
      }
    } else {
      const items = extractListItems(result.raw);
      aggregated.push(...items);
      remaining -= items.length;
    }
    page = result.response.headers.get("opc-next-page");
  } while (page !== null && remaining > 0);
  let keep = limit;
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (!Array.isArray(value)) continue;
    if (keep <= 0) delete fields[key];
    else {
      fields[key] = value.slice(0, keep);
      keep -= value.length;
    }
  }
  const items = collection
    ? Array.isArray(fields.items)
      ? fields.items
      : []
    : aggregated.slice(0, limit);
  return {
    items,
    lastResult: {
      ...result,
      allPages: all,
      raw: JSON.stringify(collection ? fields : items),
    },
  };
}

/** listPages, rendered the way the wrapper's render_response would. */
export async function renderListPages(
  ctx: CustomCommandContext,
  name: string,
  args: Record<string, unknown>,
  command?: GeneratedCommand,
): Promise<void> {
  const { lastResult } = await listPages(ctx, name, args, command);
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

import {
  callOperation,
  type GeneratedCommand,
  type OperationResult,
} from "../../core/operation.ts";
import { printResult, type OutputOptions } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { loadService, type OperationSpec } from "../../core/spec.ts";
import { waitForState } from "../../core/waiter.ts";

/** Build standard OutputOptions from a custom command context. */
export function computeOutputOptions(ctx: CustomCommandContext): OutputOptions {
  return {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  };
}

/** Parse a JSON response body, returning undefined on invalid JSON. */
export function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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

/** Call an Engine operation from a custom Compute wrapper. */
export async function callComputeOperation(
  ctx: CustomCommandContext,
  service: string,
  name: string,
  values: Record<string, unknown>,
  command?: GeneratedCommand,
): Promise<OperationResult> {
  const spec =
    service === ctx.spec.service ? ctx.spec : await loadService(service);
  const operationCommand = command ?? (spec.commands[name] as GeneratedCommand);
  const call = {
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    spec,
    index: ctx.index,
    command: operationCommand,
    values,
  };
  return callOperation(ctx.io, call);
}

/** Resolve an instance's compartmentId via `compute instance get`. */
export async function resolveInstanceCompartmentId(
  ctx: CustomCommandContext,
  instanceId: unknown,
): Promise<string | undefined> {
  const instance = await callComputeOperation(
    ctx,
    ctx.spec.service,
    "instance get",
    { instance_id: instanceId },
  );
  if (!instance.response.ok)
    printResult(ctx.io, instance, computeOutputOptions(ctx));
  const body = parseJsonBody(instance.raw);
  if (
    typeof body === "object" &&
    body !== null &&
    "compartmentId" in body &&
    typeof (body as { compartmentId?: unknown }).compartmentId === "string"
  ) {
    return (body as { compartmentId: string }).compartmentId;
  }
  return undefined;
}

/** Execute a paginated Compute list call supporting --all, --limit, and --page-size. */
export async function listComputePages(
  ctx: CustomCommandContext,
  name: string,
  args: Record<string, unknown>,
  command?: GeneratedCommand,
): Promise<{ items: unknown[]; lastResult: OperationResult }> {
  const outputOptions = computeOutputOptions(ctx);
  if (args.all_pages === true) {
    const result = await callComputeOperation(
      ctx,
      ctx.spec.service,
      name,
      args,
      command,
    );
    if (!result.response.ok) printResult(ctx.io, result, outputOptions);
    return { items: result.pageItems, lastResult: result };
  }

  if (typeof args.limit === "number") {
    const recordLimit = args.limit;
    const pageSize =
      typeof args.page_size === "number" && args.page_size > 0
        ? args.page_size
        : undefined;
    let remaining = recordLimit;
    let page = args.page;
    let fetchedAtLeastOnce = false;
    let keepPaginating = true;
    const aggregated: unknown[] = [];
    let lastResult: OperationResult | undefined;

    while (keepPaginating && (remaining > 0 || !fetchedAtLeastOnce)) {
      fetchedAtLeastOnce = true;
      const requestedLimit =
        pageSize !== undefined ? Math.min(pageSize, remaining) : remaining;
      const result = await callComputeOperation(
        ctx,
        ctx.spec.service,
        name,
        {
          ...args,
          limit: requestedLimit,
          page,
          page_size: undefined,
          all_pages: false,
        },
        command,
      );
      lastResult = result;
      if (!result.response.ok) printResult(ctx.io, result, outputOptions);
      const items = extractListItems(result.raw);
      aggregated.push(...items);
      remaining -= items.length;
      const nextPage = result.response.headers.get("opc-next-page");
      if (nextPage !== null) {
        page = nextPage;
        keepPaginating = true;
      } else {
        keepPaginating = false;
      }
    }

    return {
      items: aggregated.slice(0, recordLimit),
      lastResult: lastResult!,
    };
  }

  const result = await callComputeOperation(
    ctx,
    ctx.spec.service,
    name,
    args,
    command,
  );
  if (!result.response.ok) printResult(ctx.io, result, outputOptions);
  return { items: extractListItems(result.raw), lastResult: result };
}

/** Build and call a custom Compute wrapper backed by an Engine operation. */
export async function runComputeOperation(
  ctx: CustomCommandContext,
  name: string,
  operation: OperationSpec,
  bindings: Record<string, unknown>[] = [],
) {
  const wrapper = ctx.spec.commands[name];
  if (!wrapper) throw new Error(`Missing compute ${name} spec`);
  const command: GeneratedCommand = {
    params: wrapper.params,
    complexTypes: wrapper.complexTypes,
    operation,
    bindings,
  };
  const call = {
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    spec: ctx.spec,
    index: ctx.index,
    command,
    values: ctx.values,
  };
  const result = await callOperation(ctx.io, call);
  return waitForState(ctx.io, call, result, computeOutputOptions(ctx));
}

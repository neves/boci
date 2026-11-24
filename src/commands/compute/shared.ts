import { callOperation, type GeneratedCommand } from "../../core/operation.ts";
import { loadService } from "../../core/spec.ts";
import type { OperationSpec } from "../../core/spec.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { waitForState } from "../../core/waiter.ts";

/** Call an Engine operation from a custom Compute wrapper. */
export async function callComputeOperation(
  ctx: CustomCommandContext,
  service: string,
  name: string,
  values: Record<string, unknown>,
  command?: GeneratedCommand,
) {
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
  const result = await callOperation(ctx.io, call);
  return result;
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
  return waitForState(ctx.io, call, result, {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  });
}

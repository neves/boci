import {
  callOperation,
  type GeneratedCommand,
  type OperationCall,
} from "../../core/operation.ts";
import { loadService } from "../../core/spec.ts";
import type { CustomCommandContext } from "../../core/registry.ts";

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
  const call: OperationCall = {
    rootValues: ctx.rootValues,
    settings: ctx.settings,
    spec,
    index: ctx.index,
    command: operationCommand,
    values,
  };
  return callOperation(ctx.io, call);
}

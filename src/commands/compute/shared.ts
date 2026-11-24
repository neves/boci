import { parseJsonBody } from "../../utils/parseJsonBody.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { callCommand, outputOptions } from "../../lib/custom-command.ts";

/** Resolve an instance's compartmentId via `compute instance get`. */
export async function resolveInstanceCompartmentId(
  ctx: CustomCommandContext,
  instanceId: unknown,
): Promise<string | undefined> {
  const instance = await callCommand(ctx, ctx.spec.service, "instance get", {
    instance_id: instanceId,
  });
  if (!instance.response.ok) printResult(ctx.io, instance, outputOptions(ctx));
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

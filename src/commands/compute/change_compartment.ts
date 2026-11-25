import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { printResult } from "../../core/output.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";

const changeCompartmentOperation: OperationSpec = {
  client: "core.compute",
  method: "change_instance_compartment",
  http: "POST",
  path: "/instances/{instanceId}/actions/changeCompartment",
  pathParams: { instanceId: "instance_id" },
  queryParams: {},
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
    "if-match": { arg: "if_match" },
  },
  body: "change_instance_compartment_details",
};

export async function runComputeInstanceChangeCompartment(
  ctx: CustomCommandContext,
): Promise<void> {
  const name = "instance change-compartment";
  const command = sdkCommand(ctx, name, changeCompartmentOperation, [
    {
      target: "body",
      param: "compartment_id",
      key: ["compartmentId"],
    },
  ]);
  const result = await callCommand(
    ctx,
    ctx.spec.service,
    name,
    ctx.values,
    command,
  );
  if (!result.response.ok) printResult(ctx.io, result, outputOptions(ctx));

  // The wrapper looks up the missing core work_request client after the POST.
  ctx.io.err("KeyError: 'work_request'\n");
  throw new Exit(1);
}

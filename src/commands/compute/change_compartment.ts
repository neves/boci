import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { printResult } from "../../core/output.ts";
import { runComputeOperation } from "./shared.ts";

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
  workRequestClient: "work_requests.work_request",
};

export async function runComputeInstanceChangeCompartment(
  ctx: CustomCommandContext,
): Promise<void> {
  const result = await runComputeOperation(
    ctx,
    "instance change-compartment",
    changeCompartmentOperation,
    [
      {
        target: "body",
        param: "compartment_id",
        key: ["compartmentId"],
      },
    ],
  );
  printResult(ctx.io, result, {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  });
}

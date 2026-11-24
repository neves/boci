import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { printResult } from "../../core/output.ts";
import { runComputeOperation } from "./shared.ts";

const instanceActionOperation: OperationSpec = {
  client: "core.compute",
  method: "instance_action",
  http: "POST",
  path: "/instances/{instanceId}",
  pathParams: { instanceId: "instance_id" },
  queryParams: {
    action: { arg: "action" },
    allowDenseRebootMigration: { arg: "allow_dense_reboot_migration" },
    deleteLocalStorage: { arg: "delete_local_storage" },
    timeScheduled: { arg: "time_scheduled" },
  },
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
    "if-match": { arg: "if_match" },
  },
  lifecycleGetter: "get_instance",
  responseType: "Instance",
};

export async function runComputeInstanceAction(
  ctx: CustomCommandContext,
): Promise<void> {
  const result = await runComputeOperation(
    ctx,
    "instance action",
    instanceActionOperation,
  );
  printResult(ctx.io, result, {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  });
}

import { Exit } from "../../lib/io.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { printResult } from "../../core/output.ts";
import {
  callCommand,
  outputOptions,
  extractListItems,
  runOperation,
} from "../../lib/custom-command.ts";

const detachOperation: OperationSpec = {
  client: "core.compute",
  method: "delete_vnic_attachment",
  http: "DELETE",
  path: "/vnicAttachments/{vnicAttachmentId}",
  pathParams: { vnicAttachmentId: "vnic_attachment_id" },
  queryParams: {},
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
  },
};

export async function runComputeInstanceDetachVnic(
  ctx: CustomCommandContext,
): Promise<void> {
  if (ctx.values.force !== true) {
    ctx.io.out("Are you sure you want to delete this resource? [y/N]: ");
    const answer = await ctx.io.readLine?.();
    if (
      answer?.trim().toLowerCase() !== "y" &&
      answer?.trim().toLowerCase() !== "yes"
    ) {
      ctx.io.err("Abort: \n");
      throw new Exit(1);
    }
  }
  const options = outputOptions(ctx);
  const listed = await callCommand(
    ctx,
    ctx.spec.service,
    "vnic-attachment list",
    {
      compartment_id: ctx.values.compartment_id,
      vnic_id: ctx.values.vnic_id,
    },
  );
  if (!listed.response.ok) printResult(ctx.io, listed, options);
  const items = extractListItems(listed.raw);
  const attachment = items[0] as { id?: unknown } | undefined;
  if (typeof attachment?.id !== "string" || attachment.id === "") {
    ctx.io.err("A VNIC attachment could not be found for the given VNIC ID.\n");
    throw new Exit(1);
  }
  const deleteCtx = {
    ...ctx,
    values: {
      ...ctx.values,
      vnic_attachment_id: attachment.id,
    },
  };
  const result = await runOperation(
    deleteCtx,
    "instance detach-vnic",
    detachOperation,
  );
  printResult(ctx.io, result, options);
}

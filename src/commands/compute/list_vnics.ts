import { Exit } from "../../lib/io.ts";
import { printResult, renderDocument, renderModel } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  callComputeOperation,
  computeOutputOptions,
  listComputePages,
  parseJsonBody,
  resolveInstanceCompartmentId,
} from "./shared.ts";

const ATTACHMENTS = "vnic-attachment list";
const VNIC_GET = "vnic get";

function usageError(ctx: CustomCommandContext, message: string): never {
  ctx.io.err(`UsageError: ${message}\n`);
  throw new Exit(1);
}

export async function runComputeInstanceListVnics(
  ctx: CustomCommandContext,
): Promise<void> {
  const { values } = ctx;
  const instanceId = values.instance_id;
  const hasInstanceId = typeof instanceId === "string" && instanceId !== "";
  let compartmentId = values.compartment_id;

  if (values.all_pages === true && values.limit !== undefined)
    usageError(
      ctx,
      "If you provide the --all option you cannot provide the --limit option",
    );
  if (!compartmentId && !hasInstanceId)
    usageError(ctx, "--compartment-id or --instance-id must be provided");

  const outputOptions = computeOutputOptions(ctx);
  if (!compartmentId)
    compartmentId = await resolveInstanceCompartmentId(ctx, instanceId);

  const { items: attachments } = await listComputePages(ctx, ATTACHMENTS, {
    compartment_id: compartmentId,
    availability_domain: values.availability_domain,
    instance_id: instanceId,
    limit: values.limit,
    page: values.page,
    page_size: values.page_size,
    all_pages: values.all_pages,
  });

  const result: unknown[] = [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) continue;
    const attachment = item as { lifecycleState?: unknown; vnicId?: unknown };
    if (
      attachment.lifecycleState !== "ATTACHED" ||
      typeof attachment.vnicId !== "string"
    )
      continue;
    const vnic = await callComputeOperation(ctx, "network", VNIC_GET, {
      vnic_id: attachment.vnicId,
    });
    if (vnic.response.status === 404) {
      ctx.io.err(
        `Either VNIC with ID ${attachment.vnicId} does not exist or you are not authorized to access it.\n`,
      );
      continue;
    }
    if (!vnic.response.ok) printResult(ctx.io, vnic, outputOptions);
    result.push(
      renderModel(parseJsonBody(vnic.raw), "Vnic", vnic.responseModels),
    );
  }

  if (result.length === 0) {
    if (hasInstanceId)
      ctx.io.err(
        "No VNICs found for this instance. Please check that the instance is in RUNNING state.\n",
      );
    else
      ctx.io.err(
        "No VNICs found under this compartment. Please check that the compartment has instances in RUNNING state.\n",
      );
  }
  renderDocument(ctx.io, result.length ? { data: result } : [], outputOptions);
}

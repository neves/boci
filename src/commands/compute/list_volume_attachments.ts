import { Exit } from "../../lib/io.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { sdkCommand, renderListPages } from "../../lib/custom-command.ts";
import { resolveInstanceCompartmentId } from "./shared.ts";

const LIST_COMMAND = "volume-attachment list";

const listVolumeAttachmentsOperation: OperationSpec = {
  client: "core.compute",
  method: "list_volume_attachments",
  http: "GET",
  path: "/volumeAttachments",
  pathParams: {},
  queryParams: {
    availabilityDomain: { arg: "availability_domain" },
    compartmentId: { arg: "compartment_id" },
    limit: { arg: "limit" },
    page: { arg: "page" },
    instanceId: { arg: "instance_id" },
    volumeId: { arg: "volume_id" },
  },
  headerParams: {
    accept: { value: "application/json, application/x-json-stream" },
    "content-type": { value: "application/json" },
  },
  responseType: "list[VolumeAttachment]",
};

export async function runComputeVolumeAttachmentList(
  ctx: CustomCommandContext,
): Promise<void> {
  const { values } = ctx;
  const instanceId = values.instance_id;
  const hasInstanceId = typeof instanceId === "string" && instanceId !== "";
  let compartmentId =
    typeof values.compartment_id === "string" && values.compartment_id !== ""
      ? values.compartment_id
      : undefined;

  if (!compartmentId && !hasInstanceId) {
    ctx.io.err(
      "UsageError: Either --compartment-id or --instance-id has to be provided\n",
    );
    throw new Exit(1);
  }

  if (!compartmentId)
    compartmentId = await resolveInstanceCompartmentId(ctx, instanceId);

  await renderListPages(
    ctx,
    LIST_COMMAND,
    {
      availability_domain: values.availability_domain,
      compartment_id: compartmentId,
      instance_id: instanceId,
      volume_id: values.volume_id,
      limit: values.limit,
      page: values.page,
      page_size: values.page_size,
      all_pages: values.all_pages,
    },
    sdkCommand(ctx, LIST_COMMAND, listVolumeAttachmentsOperation),
  );
}

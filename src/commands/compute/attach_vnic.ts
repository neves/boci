import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { runComputeOperation } from "./shared.ts";

const attachmentOperation: OperationSpec = {
  client: "core.compute",
  method: "create_vnic_attachment",
  http: "POST",
  path: "/vnicAttachments",
  queryParams: {},
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
  },
  responseType: "VnicAttachment",
};

const bodyBindings = [
  ["display_name", ["createVnicDetails", "displayName"]],
  ["assign_public_ip", ["createVnicDetails", "assignPublicIp"]],
  ["private_ip", ["createVnicDetails", "privateIp"]],
  ["hostname_label", ["createVnicDetails", "hostnameLabel"]],
  ["subnet_id", ["createVnicDetails", "subnetId"]],
  ["instance_id", ["instanceId"]],
  ["nic_index", ["nicIndex"]],
] as const;

export async function runComputeInstanceAttachVnic(
  ctx: CustomCommandContext,
): Promise<void> {
  await runComputeOperation(
    ctx,
    "instance attach-vnic",
    attachmentOperation,
    bodyBindings.map(([param, key]) => ({
      target: "body",
      param,
      key,
    })),
  );
}

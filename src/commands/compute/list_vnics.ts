import { Exit } from "../../lib/io.ts";
import { printResult, renderDocument, renderModel } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { callComputeOperation } from "./shared.ts";

const ATTACHMENTS = "vnic-attachment list";
const INSTANCE_GET = "instance get";
const VNIC_GET = "vnic get";

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function listItems(raw: string): unknown[] {
  const value = parseBody(raw);
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && "items" in value) {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

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

  const outputOptions = {
    query: ctx.rootValues.query,
    output: ctx.rootValues.output,
    rawOutput: ctx.rootValues.raw_output,
    rc: ctx.rc,
  };
  const run = async (
    name: string,
    args: Record<string, unknown>,
    service?: string,
  ) => {
    return callComputeOperation(ctx, service ?? ctx.spec.service, name, args);
  };

  if (!compartmentId) {
    const instance = await run(INSTANCE_GET, { instance_id: instanceId });
    if (!instance.response.ok) printResult(ctx.io, instance, outputOptions);
    const body = parseBody(instance.raw);
    if (typeof body === "object" && body !== null && "compartmentId" in body)
      compartmentId = (body as { compartmentId?: unknown }).compartmentId;
  }

  const listArgs: Record<string, unknown> = {
    compartment_id: compartmentId,
    availability_domain: values.availability_domain,
    instance_id: instanceId,
    limit: values.limit,
    page: values.page,
    page_size: values.page_size,
    all_pages: values.all_pages,
  };
  let attachments: unknown[] = [];
  let lastList: Awaited<ReturnType<typeof run>> | undefined;
  if (values.all_pages === true) {
    lastList = await run(ATTACHMENTS, listArgs);
    if (!lastList.response.ok) printResult(ctx.io, lastList, outputOptions);
    attachments = lastList.pageItems;
  } else if (typeof values.limit === "number") {
    const recordLimit = values.limit;
    const pageSize =
      typeof values.page_size === "number" && values.page_size > 0
        ? values.page_size
        : undefined;
    let remaining = recordLimit;
    let page = values.page;
    let fetchedOnce = false;
    do {
      fetchedOnce = true;
      const requestedLimit =
        pageSize === undefined ? remaining : Math.min(pageSize, remaining);
      const result = await run(ATTACHMENTS, {
        ...listArgs,
        limit: requestedLimit,
        page,
        page_size: undefined,
      });
      lastList = result;
      if (!result.response.ok) printResult(ctx.io, result, outputOptions);
      const items = listItems(result.raw);
      attachments.push(...items);
      remaining -= items.length;
      page = result.response.headers.get("opc-next-page") ?? undefined;
      if (recordLimit === 0) break;
    } while (remaining > 0 && page !== undefined);
    attachments = attachments.slice(0, recordLimit);
    if (!fetchedOnce) throw new Exit(0);
  } else {
    lastList = await run(ATTACHMENTS, listArgs);
    if (!lastList.response.ok) printResult(ctx.io, lastList, outputOptions);
    attachments = listItems(lastList.raw);
  }

  const result: unknown[] = [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) continue;
    const attachment = item as { lifecycleState?: unknown; vnicId?: unknown };
    if (
      attachment.lifecycleState !== "ATTACHED" ||
      typeof attachment.vnicId !== "string"
    )
      continue;
    const vnic = await run(VNIC_GET, { vnic_id: attachment.vnicId }, "network");
    if (vnic.response.status === 404) {
      ctx.io.err(
        `Either VNIC with ID ${attachment.vnicId} does not exist or you are not authorized to access it.\n`,
      );
      continue;
    }
    if (!vnic.response.ok) printResult(ctx.io, vnic, outputOptions);
    result.push(renderModel(parseBody(vnic.raw), "Vnic", vnic.responseModels));
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

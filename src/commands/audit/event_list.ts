// Reference: services/audit/src/oci_cli_audit/audit_cli_extended.py:42 (61 lines)
import type { Models } from "../../core/camelize.ts";
import { printResult, renderModel } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  extractListItems,
  listPages,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";

const AUDIT_EVENT_MODELS: Models[string] = {
  AuditEvent: {
    attributes: [
      ["cloud_events_version", "str", "cloudEventsVersion"],
      ["content_type", "str", "contentType"],
      ["data", "Data", "data"],
      ["event_id", "str", "eventId"],
      ["event_time", "datetime", "eventTime"],
      ["event_type", "str", "eventType"],
      ["event_type_version", "str", "eventTypeVersion"],
      ["source", "str", "source"],
    ],
  },
};

const listEventsOperation: OperationSpec = {
  client: "audit.audit",
  method: "list_events",
  http: "GET",
  path: "/auditEvents",
  pathParams: {},
  queryParams: {
    compartmentId: {
      arg: "compartment_id",
    },
    startTime: {
      arg: "start_time",
    },
    endTime: {
      arg: "end_time",
    },
    page: {
      arg: "page",
    },
  },
  headerParams: {
    accept: {
      value: "application/json",
    },
    "content-type": {
      value: "application/json",
    },
    "opc-request-id": {
      arg: "opc_request_id",
    },
  },
  responseType: "list[AuditEvent]",
};

export async function runAuditEventList(
  ctx: CustomCommandContext,
): Promise<void> {
  const allPages = ctx.values.all_pages === true;
  const streamOutput = ctx.values.stream_output === true;

  if (!allPages && streamOutput) {
    ctx.io.err("--stream-output requires --all.\n");
    return;
  }

  const command = sdkCommand(ctx, "event list", listEventsOperation);

  if (allPages && streamOutput) {
    let page = ctx.values.page as string | undefined;
    let first = true;
    ctx.io.out('{ "data": \n[ ');
    while (true) {
      const result = await callCommand(
        ctx,
        "audit",
        "event list",
        {
          ...ctx.values,
          all_pages: false,
          ...(page !== undefined ? { page } : {}),
        },
        command,
      );
      if (!result.response.ok) {
        printResult(ctx.io, result, outputOptions(ctx));
        return;
      }
      const models = result.responseModels?.AuditEvent
        ? result.responseModels
        : AUDIT_EVENT_MODELS;
      const items = extractListItems(result.raw);
      const rendered = renderModel(
        items,
        "list[AuditEvent]",
        models,
      ) as unknown[];
      for (const item of rendered) {
        if (!first) ctx.io.out(",");
        const json = JSON.stringify(item, null, 2);
        const lines = json.split("\n");
        const indented = lines
          .map((line, i) =>
            i === 0
              ? `  ${line}`
              : i === lines.length - 1
                ? `  \n${line}`
                : `  ${line}`,
          )
          .join("\n");
        ctx.io.out(`\n${indented}`);
        first = false;
      }
      const nextPage = result.response.headers.get("opc-next-page");
      if (!nextPage) break;
      page = nextPage;
    }
    ctx.io.out("]\n}\n");
    return;
  }

  const { lastResult } = await listPages(
    ctx,
    "event list",
    ctx.values,
    command,
  );
  const models = lastResult.responseModels?.AuditEvent
    ? lastResult.responseModels
    : AUDIT_EVENT_MODELS;
  printResult(
    ctx.io,
    { ...lastResult, responseModels: models },
    outputOptions(ctx),
  );
}

// Reference: services/generative_ai_sandbox/src/oci_cli_generative_ai_sandbox/generative_ai_sandbox_cli_extended.py:43 (40 lines)
import { writeDownload } from "../../core/download.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import { outputOptions, runOperation } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";

const streamSandboxCommandEventsOperation: OperationSpec = {
  client: "generative_ai_sandbox.generative_ai_sandbox",
  method: "stream_sandbox_command_events",
  http: "GET",
  path: "/sandboxes/{sandboxId}/commands/{commandId}/events",
  pathParams: {
    sandboxId: "sandbox_id",
    commandId: "command_id",
  },
  queryParams: {
    fromSeq: {
      arg: "from_seq",
    },
    untilSeq: {
      arg: "until_seq",
    },
  },
  headerParams: {
    accept: {
      value: "text/event-stream",
    },
    "content-type": {
      value: "application/json",
    },
    "opc-request-id": {
      arg: "opc_request_id",
    },
  },
  responseType: "stream",
};

export async function runGenerativeAiSandboxCommandStream(
  ctx: CustomCommandContext,
  commandName: string,
): Promise<void> {
  const sandboxId = ctx.values.sandbox_id;
  if (typeof sandboxId === "string" && sandboxId.trim().length === 0) {
    ctx.io.err(
      "UsageError: Parameter --sandbox-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }
  const commandId = ctx.values.command_id;
  if (typeof commandId === "string" && commandId.trim().length === 0) {
    ctx.io.err(
      "UsageError: Parameter --command-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }

  const file = ctx.values.file as string | undefined;
  const result = await runOperation(
    ctx,
    commandName,
    streamSandboxCommandEventsOperation,
    file === undefined ? [] : [{ target: "output", param: "file" }],
  );
  if (!result.response.ok) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  if (file === undefined) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  await writeDownload(ctx.io, result.response, file, {
    createEmpty: true,
    showProgress: false,
  });
}

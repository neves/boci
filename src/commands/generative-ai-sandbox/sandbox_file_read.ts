// Reference: services/generative_ai_sandbox/src/oci_cli_generative_ai_sandbox/generative_ai_sandbox_cli_extended.py:123 (20 lines)
import { writeDownload } from "../../core/download.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";

const readSandboxFileOperation: OperationSpec = {
  client: "generative_ai_sandbox.generative_ai_sandbox",
  method: "read_sandbox_file",
  http: "GET",
  path: "/sandboxes/{sandboxId}/files/read",
  pathParams: {
    sandboxId: "sandbox_id",
  },
  queryParams: {
    filePath: {
      arg: "sandbox_file_path",
    },
  },
  headerParams: {
    accept: {
      value: "application/octet-stream",
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

function wrappedUsageError(ctx: CustomCommandContext, message: string): never {
  ctx.io.err(`UsageError: ${message}\n`);
  throw new Exit(1);
}

export async function runGenerativeAiSandboxSandboxFileRead(
  ctx: CustomCommandContext,
): Promise<void> {
  const file = ctx.values.file as string | undefined;
  const localFile = ctx.values.local_file as string | undefined;
  if ((file === undefined) === (localFile === undefined)) {
    wrappedUsageError(ctx, "Specify exactly one of --file or --local-file");
  }
  const target = (localFile ?? file) as string;

  const sandboxId = ctx.values.sandbox_id;
  if (typeof sandboxId === "string" && sandboxId.trim().length === 0) {
    wrappedUsageError(
      ctx,
      "Parameter --sandbox-id cannot be whitespace or empty string",
    );
  }
  const sandboxFilePath = ctx.values.sandbox_file_path;
  if (
    typeof sandboxFilePath === "string" &&
    sandboxFilePath.trim().length === 0
  ) {
    wrappedUsageError(
      ctx,
      "Parameter --sandbox-file-path cannot be whitespace or empty string",
    );
  }

  const result = await callCommand(
    ctx,
    "generative-ai-sandbox",
    "sandbox-file read",
    {
      ...ctx.values,
      file: target,
    },
    sdkCommand(ctx, "sandbox-file read", readSandboxFileOperation, [
      { target: "output", param: "file" },
    ]),
  );
  if (!result.response.ok) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  await writeDownload(ctx.io, result.response, target, { createEmpty: true });
}

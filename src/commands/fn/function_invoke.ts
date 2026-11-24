import { resolve } from "node:path";
import {
  createServiceClient,
  sendServiceRequest,
} from "../../core/operation.ts";
import { formatServiceError, printResult } from "../../core/output.ts";
import type { ProgramFile } from "../../core/program.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { functionEndpointCache } from "../../lib/function-endpoint-cache.ts";
import { Exit } from "../../lib/io.ts";

const getFunctionOperation: OperationSpec = {
  client: "functions.functions_management",
  method: "get_function",
  http: "GET",
  path: "/functions/{functionId}",
  pathParams: { functionId: "function_id" },
  queryParams: {},
  headerParams: {
    accept: { value: "application/json" },
    "content-type": { value: "application/json" },
    "opc-request-id": { arg: "opc_request_id" },
  },
  responseType: "Function",
};

export async function runFnFunctionInvoke(
  ctx: CustomCommandContext,
): Promise<void> {
  const { io, rootValues, settings, values } = ctx;
  const functionId = String(values.function_id);
  const ttl =
    values.no_endpoint_cache === true
      ? 0
      : Number(values.endpoint_cache_ttl ?? 900);
  let cache: ReturnType<typeof functionEndpointCache> | undefined;
  if (ttl > 0) {
    // The wrapper snapshots the Click context before building its management client.
    cache = functionEndpointCache(
      io,
      {
        config_file: settings.configFile,
        auth: settings.auth ?? "api_key",
        profile: settings.profile,
        endpoint: rootValues.endpoint,
        region: rootValues.region ?? io.env.OCI_CLI_REGION,
        enable_dual_stack: rootValues.enable_dual_stack || undefined,
      },
      functionId,
    );
  }

  let endpoint = cache?.get(ttl);
  if (!endpoint) {
    const result = await callCommand(
      ctx,
      "fn",
      "function invoke",
      {
        ...values,
        opc_request_id:
          rootValues.request_id ||
          crypto.randomUUID().replaceAll("-", "").toUpperCase(),
      },
      sdkCommand(ctx, "function invoke", getFunctionOperation),
    );
    if (!result.response.ok) printResult(io, result, outputOptions(ctx));
    const body = JSON.parse(result.raw) as { invokeEndpoint?: string };
    endpoint = body.invokeEndpoint;
    if (endpoint) cache?.put(endpoint);
  }

  const { request_id: _requestId, ...invokeRootValues } = rootValues;
  const client = await createServiceClient(io, {
    ...ctx,
    rootValues: { ...invokeRootValues, endpoint },
    client: {
      ...(ctx.spec.clients["functions.functions_management"] as Record<
        string,
        unknown
      >),
      serviceName: "functions_invoke",
    },
  });
  const headers: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
  };
  if (typeof values.fn_intent === "string")
    headers["fn-intent"] = values.fn_intent;
  if (typeof values.fn_invoke_type === "string")
    headers["fn-invoke-type"] = values.fn_invoke_type;
  if (typeof values.is_dry_run === "boolean")
    headers["is-dry-run"] = values.is_dry_run ? "True" : "False";

  const operation = { http: "POST", method: "invoke_function" };
  const result = await sendServiceRequest(io, client, {
    method: operation.http,
    pathTemplate: "/functions/{functionId}/actions/invoke",
    pathParams: { functionId },
    headers,
    body: String(values.body),
    rawResponse: true,
    decompress: true,
  });
  if (!result.response.ok) {
    io.err(
      formatServiceError(
        operation,
        result.url,
        result.response,
        result.raw,
        "functions_invoke",
      ),
    );
    throw new Exit(1);
  }

  const filename =
    typeof values.file === "string"
      ? values.file
      : (values.file as ProgramFile).name!;
  if (filename === "-") {
    if (io.outBytes) {
      for await (const chunk of result.response.body ?? [])
        await io.outBytes(chunk);
    } else io.out(await result.response.text());
    return;
  }

  if (Number(result.response.headers.get("content-length")) > 0)
    io.out("Downloading file\n");
  const writer = Bun.file(resolve(io.cwd, filename)).writer();
  try {
    for await (const chunk of result.response.body ?? []) {
      writer.write(chunk);
      await writer.flush();
    }
  } finally {
    await writer.end();
  }
}

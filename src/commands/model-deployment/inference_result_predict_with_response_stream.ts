// Reference: services/model_deployment/src/oci_cli_model_deployment/modeldeployment_cli_extended.py:41 (49 lines)
import { writeDownload } from "../../core/download.ts";
import { parseJsonParameter } from "../../core/json-input.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";

const predictWithResponseStreamOperation: OperationSpec = {
  client: "model_deployment.model_deployment",
  method: "predict_with_response_stream",
  http: "POST",
  path: "/{modelDeploymentId}/predictWithResponseStream",
  pathParams: {
    modelDeploymentId: "model_deployment_id",
  },
  queryParams: {},
  headerParams: {
    accept: {
      value: "application/json, text/event-stream",
    },
    "content-type": {
      value: "application/json",
    },
    "opc-request-id": {
      arg: "opc_request_id",
    },
  },
  body: "request_body",
  responseType: "stream",
};

export async function runModelDeploymentInferenceResultPredictWithResponseStream(
  ctx: CustomCommandContext,
): Promise<void> {
  const modelDeploymentId = ctx.values.model_deployment_id;
  if (
    typeof modelDeploymentId === "string" &&
    modelDeploymentId.trim().length === 0
  ) {
    ctx.io.err(
      "UsageError: Parameter --model-deployment-id cannot be whitespace or empty string\n",
    );
    throw new Exit(1);
  }

  let parsedRequestBody: unknown = "";
  const requestBody = ctx.values.request_body;
  if (typeof requestBody === "string" && requestBody.trim() !== "") {
    parsedRequestBody = parseJsonParameter(ctx.io, "request_body", requestBody);
  }

  const result = await callCommand(
    ctx,
    "model-deployment",
    "inference-result predict-with-response-stream",
    {
      ...ctx.values,
      request_body: parsedRequestBody,
    },
    sdkCommand(
      ctx,
      "inference-result predict-with-response-stream",
      predictWithResponseStreamOperation,
      [{ target: "output", param: "file" }],
    ),
  );
  if (!result.response.ok) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  const file = ctx.values.file as string;
  await writeDownload(ctx.io, result.response, file);
}

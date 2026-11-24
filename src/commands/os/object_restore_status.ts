// Reference: services/object_storage/src/oci_cli_object_storage/objectstorage_cli_extended.py:2470 (45 lines)
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import type { OperationSpec } from "../../core/spec.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";

const headObjectOperation: OperationSpec = {
  client: "object_storage.object_storage",
  method: "head_object",
  http: "HEAD",
  path: "/n/{namespaceName}/b/{bucketName}/o/{objectName}",
  pathParams: {
    namespaceName: "namespace_name",
    bucketName: "bucket_name",
    objectName: "object_name",
  },
  queryParams: {
    versionId: {
      arg: "version_id",
    },
  },
  headerParams: {
    accept: {
      value: "application/json",
    },
    "content-type": {
      value: "application/json",
    },
    "if-match": {
      arg: "if_match",
    },
    "if-none-match": {
      arg: "if_none_match",
    },
    "opc-client-request-id": {
      arg: "opc_client_request_id",
    },
    "opc-sse-customer-algorithm": {
      arg: "opc_sse_customer_algorithm",
    },
    "opc-sse-customer-key": {
      arg: "opc_sse_customer_key",
    },
    "opc-sse-customer-key-sha256": {
      arg: "opc_sse_customer_key_sha256",
    },
  },
};

const ARCHIVAL_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

function timeDelta(days: number, remainingSecsInDay: number): string {
  const hours = Math.floor(remainingSecsInDay / 3600);
  const remAfterHours = remainingSecsInDay % 3600;
  const minutes = Math.floor(remAfterHours / 60);

  if (days === 0 && hours === 0 && minutes === 0) {
    return "less than 1 minute";
  }

  const daysStr = days === 1 ? "1 day" : `${days} days`;
  const hoursStr = hours === 1 ? "1 hour" : `${hours} hours`;
  const minutesStr = minutes === 1 ? "1 min" : `${minutes} mins`;

  return `${daysStr} ${hoursStr} ${minutesStr}`;
}

export async function runOsObjectRestoreStatus(
  ctx: CustomCommandContext,
): Promise<void> {
  const namespace = ctx.values.namespace as string;
  const bucketName = ctx.values.bucket_name as string;
  const name = ctx.values.name as string;

  const result = await callCommand(
    ctx,
    "os",
    "object restore-status",
    {
      ...ctx.values,
      namespace_name: namespace,
      object_name: name,
    },
    sdkCommand(ctx, "object restore-status", headObjectOperation),
  );
  if (!result.response.ok) {
    printResult(ctx.io, result, outputOptions(ctx));
    return;
  }

  const archivalState = result.response.headers.get("archival-state");
  let msg: string;
  if (archivalState === null) {
    msg = "Available, this object is available for download.";
  } else if (archivalState.toLowerCase() === "archived") {
    msg = `Archived, this object is not available for download. Use 'oci os object restore -ns ${namespace} -bn ${bucketName} --name ${name}' command to start restoring the object.`;
  } else if (archivalState.toLowerCase() === "restoring") {
    msg =
      "Restoring, this object is being restored and will be available for download in about 1 hour from the time you issued the restore command.";
  } else if (archivalState.toLowerCase() === "restored") {
    const timeOfArchival =
      result.response.headers.get("time-of-archival") ?? "";
    const match = ARCHIVAL_TIME_RE.exec(timeOfArchival);
    if (match) {
      const targetMs = Date.parse(timeOfArchival);
      const diffSecs = Math.floor((targetMs - Date.now()) / 1000);
      const days = Math.floor(diffSecs / 86400);
      const remSecs = diffSecs - days * 86400;
      const timeLeft = timeDelta(days, remSecs);
      msg = `Restored. You have ${timeLeft} to download the restored object before it is once again archived.`;
    } else {
      msg = `Restored. The object will be re-archived at ${timeOfArchival}.`;
    }
  } else {
    msg = "Unknown";
  }

  ctx.io.err(`${msg}\n`);
}

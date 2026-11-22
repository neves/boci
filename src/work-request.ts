import { Exit, type Invocation } from "./io.ts";
import {
  callOperation,
  type OperationCall,
  type OperationResult,
} from "./operation.ts";
import { printResult, type OutputOptions } from "./output.ts";
import type { ServiceSpec } from "./spec.ts";

const waitError =
  "Encountered error while waiting for work request to enter the specified state. Outputting last known resource state\n";

export async function waitForWorkRequest(
  io: Invocation,
  call: OperationCall & { spec: ServiceSpec },
  initial: OperationResult,
  output: OutputOptions,
): Promise<OperationResult> {
  const states = call.values.wait_for_state;
  if (
    !initial.response.ok ||
    !Array.isArray(states) ||
    !states.length ||
    initial.operation.workRequestClient ||
    !call.command.otherOperations?.includes("get_work_request")
  )
    return initial;
  const getter = Object.values(call.spec.commands).find(
    ({ operation }) =>
      operation?.client === initial.operation.client &&
      operation.method === "get_work_request",
  );
  if (!getter) {
    io.err(
      "Unable to wait for the work request to enter the specified state\n",
    );
    return initial;
  }
  const id = initial.response.headers.get("opc-work-request-id");
  if (id === null) {
    io.out(waitError);
    return initial;
  }
  const tuple =
    states.map((state) => `'${state}'`).join(", ") +
    (states.length === 1 ? "," : "");
  io.err(
    `Action completed. Waiting until the work request has entered state: (${tuple})\n`,
  );
  const poll = () =>
    callOperation(io, {
      ...call,
      command: getter,
      values: { work_request_id: id },
    });
  const maxWait = Number(call.values.max_wait_seconds ?? 1200);
  const maxInterval = Number(call.values.wait_interval_seconds ?? 30);
  let interval = 1;
  let started: number | undefined;
  for (;;) {
    let current;
    try {
      current = await poll();
      if (current.response.ok) {
        const resource = JSON.parse(current.raw);
        if (states.includes(resource.status ?? resource.lifecycleState))
          return current;
      }
    } catch (error) {
      io.err(waitError);
      printResult(io, initial, output);
      throw error;
    }
    if (!current.response.ok) {
      io.err(waitError);
      printResult(io, initial, output);
      return current;
    }
    started ??= performance.now();
    if (performance.now() - started >= maxWait * 1000) {
      io.err(
        "Failed to wait until the work request entered the specified state. Outputting last known resource state\n",
      );
      printResult(io, initial, output);
      throw new Exit(2);
    }
    await Bun.sleep(interval * 1000);
    interval = Math.min(interval * 2, maxInterval);
  }
}

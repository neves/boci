import { Exit, type Invocation } from "./io.ts";
import {
  callOperation,
  type OperationCall,
  type OperationResult,
} from "./operation.ts";
import { printResult, type OutputOptions } from "./output.ts";
import type { ServiceSpec } from "./spec.ts";

export async function waitForState(
  io: Invocation,
  call: OperationCall & { spec: ServiceSpec },
  initial: OperationResult,
  output: OutputOptions,
): Promise<OperationResult> {
  const states = call.values.wait_for_state;
  if (!initial.response.ok || !Array.isArray(states) || !states.length)
    return initial;
  const { lifecycleGetter, workRequestClient, client } = initial.operation;
  if (
    !lifecycleGetter &&
    !workRequestClient &&
    !call.command.otherOperations?.includes("get_work_request")
  )
    return initial;

  const target = lifecycleGetter ? "resource" : "work request";
  const waitError = `Encountered error while waiting for ${target} to enter the specified state. Outputting last known resource state\n`;
  const method = lifecycleGetter ?? "get_work_request";
  const getter = workRequestClient
    ? call.spec.clients[workRequestClient]?.workRequestGetter
    : (call.spec.clients[client]?.lifecycleGetters?.[method] ??
      Object.values(call.spec.commands).find(
        ({ operation }) =>
          operation?.client === client && operation.method === method,
      )?.operation);
  if (!getter) {
    io.err(`Unable to wait for the ${target} to enter the specified state\n`);
    return initial;
  }
  const id = lifecycleGetter
    ? JSON.parse(initial.raw || "null")?.id
    : initial.response.headers.get("opc-work-request-id");
  if (!lifecycleGetter && id === null) {
    io.out(waitError);
    return initial;
  }
  const tuple =
    states.map((state) => `'${state}'`).join(", ") +
    (states.length === 1 ? "," : "");
  io.err(
    `Action completed. Waiting until the ${target} has entered state: (${tuple})\n`,
  );
  // Generated lifecycle waiters pass result.data.id as the getter's sole positional argument.
  const [pathName, argument] = Object.entries(getter.pathParams ?? {})[0] ?? [];
  if (!pathName || !argument)
    throw new Error(`No path parameter for ${getter.method}`);
  const getterError =
    initial.operation.lifecycleGetterError ??
    (lifecycleGetter && (id == null || String(id).trim() === "")
      ? `ValueError: Parameter ${pathName} cannot be None, whitespace or empty string`
      : undefined);
  if (getterError) {
    io.err(waitError);
    printResult(io, initial.raw ? initial : { ...initial, raw: "{}" }, output);
    io.err(`${getterError}\n`);
    throw new Exit(1);
  }
  const poll = () =>
    callOperation(io, {
      ...call,
      command: { operation: getter },
      values: { [argument]: id },
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
        const resource = JSON.parse(current.raw || "{}") ?? {};
        if (
          states.includes(
            lifecycleGetter
              ? resource.lifecycleState
              : (resource.status ?? resource.lifecycleState),
          )
        )
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
        `Failed to wait until the ${target} entered the specified state. Outputting last known resource state\n`,
      );
      printResult(io, initial, output);
      throw new Exit(2);
    }
    if (interval < 0) {
      io.err(waitError);
      printResult(io, initial, output);
      io.err("ValueError: sleep length must be non-negative\n");
      throw new Exit(1);
    }
    await Bun.sleep(interval * 1000);
    interval = Math.min(interval * 2, maxInterval);
  }
}

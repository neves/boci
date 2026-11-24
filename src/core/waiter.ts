import { Exit, type Invocation } from "../lib/io.ts";
import {
  callOperation,
  type OperationCall,
  type OperationResult,
} from "./operation.ts";
import { printResult, type OutputOptions } from "./output.ts";
import type { ServiceSpec } from "./spec.ts";

export type WaitUntilOutcome =
  | { kind: "response"; result: OperationResult }
  | { kind: "timeout" }
  | { kind: "negative-interval" }
  | { kind: "error"; result: OperationResult };

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function responsePropertyValue(
  result: OperationResult,
  property: string,
): unknown {
  let resource: Record<string, unknown>;
  try {
    resource = (JSON.parse(result.raw || "{}") ?? {}) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const camel = snakeToCamel(property);
  if (camel in resource) return resource[camel];
  if (property in resource) return resource[property];
  if (property === "status" && "lifecycleState" in resource)
    return resource.lifecycleState;
  return undefined;
}

/**
 * Shared implementation of `oci.wait_until(client, response, property, states, ...)`.
 * Checks `initial` first, then polls with `poll()` using exponential backoff (1, 2, 4, ...
 * capped at `maxIntervalSeconds`) until the property enters `states` or `maxWaitSeconds`
 * elapses.
 */
export async function waitUntilResponse(opts: {
  initial: OperationResult;
  property: string;
  states: string[];
  maxWaitSeconds?: number;
  maxIntervalSeconds?: number;
  succeedOnNotFound?: boolean;
  poll: () => Promise<OperationResult>;
  sleep?: (seconds: number) => Promise<void>;
}): Promise<WaitUntilOutcome> {
  const {
    initial,
    property,
    states,
    maxWaitSeconds = 1200,
    maxIntervalSeconds = 30,
    succeedOnNotFound = false,
    poll,
    sleep = (s) => Bun.sleep(s * 1000),
  } = opts;
  let current = initial;
  let interval = 1;
  let started: number | undefined;
  for (;;) {
    if (!current.response.ok) {
      if (succeedOnNotFound && current.response.status === 404)
        return { kind: "response", result: current };
      return { kind: "error", result: current };
    }
    const value = responsePropertyValue(current, property);
    if (typeof value === "string" && states.includes(value))
      return { kind: "response", result: current };
    started ??= performance.now();
    if (performance.now() - started >= maxWaitSeconds * 1000)
      return { kind: "timeout" };
    if (interval < 0) return { kind: "negative-interval" };
    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalSeconds);
    current = await poll();
  }
}

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

// Differential fuzzing: random but spec-valid invocations of one Leaf command, plus random
// replies for the fake endpoint built from the response model. `bun run fuzz` runs each
// invocation through both the Reference CLI and boci and compares everything observable.
// Everything here is pure and seeded, so a (seed, key, iteration) triple always rebuilds
// the same Parity case.
import type { Reply } from "../test/harness/fake-endpoint.ts";
import type { ParityCase } from "../test/harness/cases.ts";

export type Rng = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

/** mulberry32: tiny, fast, and good enough to pick test inputs. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    chance: (p) => next() < p,
  };
}

/** The seed of one invocation, derived from the run seed, the command and the iteration. */
export const invocationSeed = (seed: number, key: string, i: number) =>
  Number(BigInt(Bun.hash(`${seed}:${key}:${i}`)) & 0xffffffffn);

export type SpecParam = {
  kind?: string;
  name: string;
  opts?: string[];
  type?: string;
  typeClass?: string;
  required?: boolean;
  multiple?: boolean;
  isFlag?: boolean;
  hidden?: boolean;
  choices?: string[];
  fileMode?: string;
};

export type SpecOperation = {
  http?: string;
  path?: string;
  pathParams?: Record<string, string>;
  responseType?: string;
  paginated?: boolean;
};

export type SpecCommand = {
  kind: string;
  tier?: string;
  operation?: SpecOperation;
  sdkOperations?: SpecOperation[];
  params?: SpecParam[];
  jsonExamples?: { params?: Record<string, string> };
};

export type SpecModel = {
  attributes: [string, string, string][];
  discriminator?: string;
};

export type ServiceSpec = {
  commands: Record<string, SpecCommand>;
  jsonExamplePool?: Record<string, unknown>;
  models?: Record<string, Record<string, SpecModel>>;
};

export const operationOf = (c: SpecCommand) =>
  c.operation ?? c.sdkOperations?.[0];

/** Commands the fuzzer can drive: anything that sends one modelled request. */
export const fuzzable = (c: SpecCommand) => Boolean(operationOf(c)?.http);

/** Options never picked at random: they poll, read their own input, or print templates. */
const SKIPPED = new Set([
  "help",
  "from_json",
  "wait_for_state",
  "max_wait_seconds",
  "wait_interval_seconds",
  "generate_full_command_json_input",
  "generate_param_json_input",
  "all_pages",
  "page_size",
  "force",
  "opc_retry_token",
]);

export const FUZZ_FILE = "fuzz-file.txt";
const FUZZ_FILE_CONTENT = "boci fuzz file\r\nline 2 ✓\n";

const TEXT = [
  "fuzz-value",
  "ocid1.test.oc1..aaaaaaaafuzz",
  "with space",
  "ünïcödé ✓",
  "a,b",
  "slash/and?query=1&x",
  "-leading-dash",
  "",
];
const INTEGERS = ["0", "1", "7", "100", "-1"];
const FLOATS = ["0", "1.5", "-2.25", "1e3"];
const DATETIMES = [
  "2024-01-02T03:04:05.000Z",
  "2024-01-02T03:04:05Z",
  "2024-01-02",
  "2024-01-02 03:04:05",
  "2024-01-02T03:04:05.123456+05:30",
  "1704164645",
];
const QUERIES = [
  "data",
  "data[0]",
  "length(data)",
  "data.id",
  "keys(data)",
  "data[*].id",
  "data[?id != null] | [0]",
  "[data]",
  "data || `null`",
  'data."lifecycle-state"',
  "not a [ query",
];
const ERRORS: [number, string][] = [
  [400, "InvalidParameter"],
  [401, "NotAuthenticated"],
  [404, "NotAuthorizedOrNotFound"],
  [409, "Conflict"],
  [412, "PreconditionFailed"],
  [429, "TooManyRequests"],
  [500, "InternalServerError"],
  [503, "ServiceUnavailable"],
];

const longOption = (p: SpecParam) =>
  p.opts?.find((o) => o.startsWith("--")) ?? p.opts?.[0];

/** Models by name; `polymorphic` marks the bases other models name as their discriminator. */
type Models = Map<string, SpecModel & { polymorphic?: boolean }>;

const modelCache = new WeakMap<ServiceSpec, Models>();
function flatModels(spec: ServiceSpec): Models {
  const cached = modelCache.get(spec);
  if (cached) return cached;
  const out: Models = new Map();
  for (const group of Object.values(spec.models ?? {}))
    for (const [name, model] of Object.entries(group))
      if (!out.has(name)) out.set(name, { ...model });
  for (const model of out.values()) {
    const base = model.discriminator && out.get(model.discriminator);
    if (base) base.polymorphic = true;
  }
  modelCache.set(spec, out);
  return out;
}

/** A JSON value shaped like the SDK type `type` (`str`, `list[X]`, `dict(str, X)`, a model…). */
export function randomValue(
  type: string,
  models: Models,
  r: Rng,
  depth = 0,
): unknown {
  const list = /^list\[(.*)\]$/.exec(type);
  if (list)
    return Array.from({ length: depth > 2 ? 0 : r.int(0, 2) }, () =>
      randomValue(list[1] ?? "str", models, r, depth + 1),
    );
  const dict = /^dict\(str, (.*)\)$/.exec(type);
  if (dict) {
    const out: Record<string, unknown> = {};
    for (let i = depth > 2 ? 0 : r.int(0, 2); i > 0; i--)
      out[r.pick(["key1", "Key-2", "k ✓"])] = randomValue(
        dict[1] ?? "str",
        models,
        r,
        depth + 1,
      );
    return out;
  }
  switch (type) {
    case "str":
      return r.pick(TEXT);
    case "bool":
      return r.chance(0.5);
    case "int":
      return r.pick([0, 1, 42, -1, 2147483648]);
    case "float":
      return r.pick([0, 1.5, -2.25, 0.1, 1e21]);
    case "datetime":
      return r.pick([
        "2024-01-02T03:04:05.123Z",
        "2024-01-02T03:04:05Z",
        "2024-01-02T03:04:05.123456+00:00",
      ]);
    case "date":
      return "2024-01-02";
    case "object":
      return r.pick([null, 1, "x", { nested: [1, "two"] }, []]);
  }
  const model = models.get(type);
  if (!model) return r.pick(TEXT);
  if (depth > 3) return {};
  const out: Record<string, unknown> = {};
  for (const [, attrType, jsonName] of model.attributes) {
    // The SDK picks a polymorphic model's subtype from a discriminator field (KeyError when
    // it's missing; services always send it). The spec doesn't say which `str` field that
    // is, so a polymorphic model gets all of them.
    const always = model.polymorphic && attrType === "str";
    if (!always && !r.chance(0.6)) continue;
    if (always) {
      out[jsonName] = r.pick(TEXT);
      continue;
    }
    out[jsonName] = r.chance(0.05)
      ? null
      : randomValue(attrType, models, r, depth + 1);
  }
  // Fields the SDK doesn't know: it drops them, so boci must too.
  if (r.chance(0.1)) out.fuzzUnknownField = "x";
  return out;
}

function successReplies(
  op: SpecOperation,
  spec: ServiceSpec,
  r: Rng,
  pages: number,
): Reply[] {
  const headers: Record<string, string> = {
    "opc-request-id": "fuzz-opc-request-id",
  };
  if (r.chance(0.3)) headers.etag = "fuzz-etag";
  if (r.chance(0.2)) headers["opc-work-request-id"] = "fuzz-work-request";
  const type = op.responseType;
  const body =
    type === undefined ? "" : (randomValue(type, flatModels(spec), r) ?? "");
  const status = type === undefined ? r.pick([200, 204]) : 200;
  const replies: Reply[] = [];
  for (let page = 1; page <= pages; page++)
    replies.push({
      status,
      headers:
        page < pages
          ? { ...headers, "opc-next-page": `page${page + 1}` }
          : headers,
      body: page === 1 ? body : randomValue(type ?? "str", flatModels(spec), r),
    });
  return replies;
}

function errorReply(r: Rng): Reply {
  const [status, code] = r.pick(ERRORS);
  return {
    status,
    headers: { "opc-request-id": "fuzz-opc-request-id" },
    body: r.chance(0.85)
      ? { code, message: `fuzz ${code} message` }
      : "<html>not json</html>",
  };
}

function optionValue(
  p: SpecParam,
  command: SpecCommand,
  spec: ServiceSpec,
  r: Rng,
): string {
  if (p.choices?.length) return r.pick(p.choices);
  switch (p.type) {
    case "integer":
    case "integer range":
      return r.pick(INTEGERS);
    case "float":
      return r.pick(FLOATS);
    case "boolean":
      return r.pick(["true", "false"]);
    case "datetime":
      return r.pick(DATETIMES);
    case "filename":
    case "path":
      return FUZZ_FILE;
    case "complex type": {
      const option = longOption(p)?.replace(/^--/, "") ?? "";
      const ref = command.jsonExamples?.params?.[option];
      const example = ref ? spec.jsonExamplePool?.[ref] : undefined;
      if (example !== undefined && r.chance(0.8))
        return JSON.stringify(example);
      return r.pick(["{}", "[]", '{"key":"value"}']);
    }
  }
  return r.pick(TEXT.filter(Boolean));
}

/** A deliberately wrong value, to compare usage errors. */
function invalidValue(p: SpecParam, r: Rng): string | undefined {
  if (p.choices?.length) return "NOT_A_CHOICE";
  switch (p.type) {
    case "integer":
      return r.pick(["notanint", "1.5"]);
    case "float":
      return "notafloat";
    case "boolean":
      return "maybe";
    case "datetime":
      return "not-a-date";
    case "complex type":
      return r.pick(["{not json", "file:///nonexistent/fuzz.json"]);
  }
  return undefined;
}

export type Invocation = ParityCase & {
  /** Paths (relative to the sandbox HOME) to compare after the run. */
  captureFiles?: string[];
};

/** One random invocation of `service path`, ready for runCli / runInProcess. */
export function buildInvocation(
  service: string,
  path: string,
  spec: ServiceSpec,
  seed: number,
): Invocation | undefined {
  const command = spec.commands[path];
  const op = command && operationOf(command);
  if (!command || !op?.http) return undefined;
  const r = rng(seed);
  const params = (command.params ?? []).filter(
    (p) => p.kind !== "argument" && !p.hidden && longOption(p),
  );
  const pathArgs = new Set(Object.values(op.pathParams ?? {}));
  const has = (name: string) => params.some((p) => p.name === name);
  const argv = [service, ...path.split(" ")];
  let usesFile = false;

  const chosen = params.filter(
    (p) =>
      !SKIPPED.has(p.name) &&
      (p.required || pathArgs.has(p.name) || r.chance(0.3)),
  );
  // Sometimes leave out one required option or give one option a wrong value.
  const broken = r.chance(0.08) ? r.pick(chosen) : undefined;
  const brokenMode = broken
    ? broken.required && r.chance(0.3)
      ? "omit"
      : "invalid"
    : undefined;
  for (const p of chosen) {
    const option = longOption(p)!;
    if (p === broken && brokenMode === "omit") continue;
    const repeat = p.multiple && r.chance(0.3) ? 2 : 1;
    for (let i = 0; i < repeat; i++) {
      argv.push(option);
      if (p.isFlag) break;
      const bad = p === broken ? invalidValue(p, r) : undefined;
      const value = bad ?? optionValue(p, command, spec, r);
      if (value === FUZZ_FILE) usesFile = true;
      argv.push(value);
    }
  }

  const paginated = Boolean(op.paginated) && has("all_pages");
  const allPages = paginated && r.chance(0.4);
  if (allPages) {
    argv.push("--all");
    if (has("page_size") && r.chance(0.5)) argv.push("--page-size", "1");
  }
  const error = r.chance(0.2);
  let stdin: string | undefined;
  if (has("force") && r.chance(0.8)) argv.push("--force");
  else if (op.http === "DELETE") stdin = r.pick(["y\n", "n\n"]);
  if (has("opc_retry_token"))
    argv.push("--opc-retry-token", "fuzz-retry-token");

  if (r.chance(0.2)) argv.push("--output", "table");
  if (r.chance(0.3)) {
    argv.push("--query", r.pick(QUERIES));
    if (r.chance(0.3)) argv.push("--raw-output");
  }
  // Retries back off for seconds; the default strategy is covered by hand-written cases.
  if (error) argv.push("--no-retry");
  argv.push("--endpoint", "{endpoint}");

  const replies = error
    ? errorReply(r)
    : successReplies(op, spec, r, allPages ? r.int(1, 3) : 1);
  const key = `${service} ${path}`;
  return {
    id: `fuzz-${service}-${path.replaceAll(" ", "-")}-${seed.toString(16).padStart(8, "0")}`,
    key,
    argv,
    replies,
    ...(stdin === undefined ? {} : { stdin }),
    ...(usesFile
      ? {
          sandbox: { files: { [FUZZ_FILE]: FUZZ_FILE_CONTENT } },
          captureFiles: [FUZZ_FILE],
        }
      : {}),
  };
}

/** The parts of two observations that differ, each with its first differing line. */
export function describeDiff(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): Record<string, { oci: string; boci: string }> {
  const out: Record<string, { oci: string; boci: string }> = {};
  for (const field of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    const a = expected[field];
    const b = actual[field];
    if (Bun.deepEquals(a, b)) continue;
    const sa = typeof a === "string" ? a : (JSON.stringify(a, null, 1) ?? "");
    const sb = typeof b === "string" ? b : (JSON.stringify(b, null, 1) ?? "");
    const la = sa.split("\n");
    const lb = sb.split("\n");
    let i = 0;
    while (i < la.length && la[i] === lb[i]) i++;
    out[field] = {
      oci: `line ${i + 1}: ${la[i] ?? "<end>"}`,
      boci: `line ${i + 1}: ${lb[i] ?? "<end>"}`,
    };
  }
  return out;
}

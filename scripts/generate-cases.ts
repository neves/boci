// Generate request-only parity cases for Generated commands: GETs into
// test/parity/cases/generated-get-<service>.json, POST/PUT/PATCH into generated-request-<service>.json.
// `bun run parity:cases --service <name>[,<name>…] | --all [--method GET,POST,PUT,PATCH]`
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    service: { type: "string" },
    all: { type: "boolean", default: false },
    method: { type: "string", default: "GET,POST,PUT,PATCH" },
  },
});

const root = `${import.meta.dir}/..`;
const casesDir = `${root}/test/parity/cases`;
const services = values.all
  ? Object.keys(
      (
        (await Bun.file(`${root}/spec/index.json`).json()) as {
          services: Record<string, unknown>;
        }
      ).services,
    )
  : (values.service?.split(",").filter(Boolean) ?? []);
if (!services.length)
  throw new Error(
    "usage: bun run parity:cases --service <name>[,<name>…] | --all [--method GET,POST,PUT,PATCH]",
  );

type Param = Record<string, unknown>;
type Binding = Record<string, unknown>;
type Operation = {
  http?: string;
  responseType?: string;
  pathParams?: Record<string, string>;
  headerParams?: Record<string, unknown>;
  body?: string;
};
type Command = {
  kind: string;
  operation?: Operation;
  params?: Param[];
  bindings?: Binding[];
};
type Kind = {
  file: string;
  methods: string[];
  build: (argv: string[], command: Command, operation: Operation) => boolean;
  replies: (operation: Operation) => unknown;
};

const methods = new Set(values.method.toUpperCase().split(","));
const kinds = (
  [
    {
      file: "generated-get",
      methods: ["GET"],
      build: getArgv,
      replies: (operation) => ({
        body: operation.responseType?.startsWith("list[") ? [] : {},
      }),
    },
    {
      file: "generated-request",
      methods: ["POST", "PUT", "PATCH"],
      build: writeArgv,
      replies: () => ({ body: {} }),
    },
  ] satisfies Kind[]
).filter((kind) => kind.methods.some((m) => methods.has(m)));

const regenerated = new Set(
  kinds.flatMap((kind) => services.map((s) => `${kind.file}-${s}.json`)),
);
const existingKeys = new Set<string>();
for await (const file of new Bun.Glob("**/*.json").scan(casesDir)) {
  if (regenerated.has(file)) continue;
  const cases = (await Bun.file(`${casesDir}/${file}`).json()) as {
    key: string;
  }[];
  for (const c of cases) existingKeys.add(c.key);
}

const optionOf = (param: Param) => {
  const options = param.opts as string[] | undefined;
  return options?.find((o) => o.startsWith("--")) ?? options?.[0];
};
const hasRetryToken = (params: Param[]) =>
  params.some((p) =>
    (p.opts as string[] | undefined)?.includes("--opc-retry-token"),
  );
const isComplex = (param: Param) =>
  ["complex", "json", "complex type"].includes(String(param.type)) ||
  String(param.typeClass).includes("Complex");

function sample(param: Param): string {
  if (param.name === "shape_availabilities") return '{"shapes":[]}';
  const choices = param.choices;
  if (Array.isArray(choices) && choices.length) return String(choices[0]);
  switch (param.type) {
    case "integer":
      return "1";
    case "float":
      return "1.5";
    case "boolean":
      return "true";
    case "complex":
    case "json":
      return "{}";
    default:
      return "test-value";
  }
}

function pushParam(argv: string[], param: Param) {
  const option = optionOf(param);
  if (!option) return;
  argv.push(option);
  if (param.isFlag !== true) argv.push(sample(param));
}

// Required and path options, then the endpoint.
function getArgv(argv: string[], command: Command, operation: Operation) {
  const params = command.params ?? [];
  const pathArgs = new Set(Object.values(operation.pathParams ?? {}));
  for (const param of params)
    if (param.required === true || pathArgs.has(String(param.name)))
      pushParam(argv, param);
  argv.push("--endpoint", "{endpoint}");
  if (hasRetryToken(params))
    argv.push("--opc-retry-token", "{opc-retry-token}");
  return true;
}

// Simple body options, then the path/query/header options the request needs. Writes
// without a simple body option aren't generated.
function writeArgv(argv: string[], command: Command, operation: Operation) {
  const params = command.params ?? [];
  const pathArgs = new Set(Object.values(operation.pathParams ?? {}));
  const bindings = command.bindings ?? [];
  const bodyBindings = bindings.filter((b) => b.target === "body");
  const simpleBindings = bodyBindings.filter((b) => {
    const param = params.find((p) => p.name === b.param);
    return (
      typeof b.value === "string" ||
      typeof b.value === "boolean" ||
      (param !== undefined && !isComplex(param))
    );
  });
  if (simpleBindings.length === 0) return false;
  for (const param of params) {
    const name = String(param.name);
    const binding = bodyBindings.find((b) => b.param === name);
    if (!binding || !simpleBindings.includes(binding)) continue;
    if (
      typeof binding.value === "string" ||
      typeof binding.value === "boolean"
    ) {
      const option = (param.opts as string[] | undefined)?.find((o) =>
        o.startsWith("--"),
      );
      if (option) argv.push(option, String(binding.value));
      continue;
    }
    if (param.required !== true && !pathArgs.has(name) && !binding.when)
      continue;
    pushParam(argv, param);
  }
  for (const param of params) {
    if (bodyBindings.some((b) => b.param === param.name)) continue;
    const hasRequestBinding = bindings.some(
      (b) =>
        b.param === param.name &&
        ["query", "path", "header"].includes(String(b.target)),
    );
    if (
      param.required === true ||
      pathArgs.has(String(param.name)) ||
      hasRequestBinding
    )
      pushParam(argv, param);
  }
  if (operation.headerParams?.["opc-retry-token"] && !hasRetryToken(params))
    argv.push("--opc-retry-token", "{opc-retry-token}");
  argv.push("--endpoint", "{endpoint}");
  if (hasRetryToken(params))
    argv.push("--opc-retry-token", "{opc-retry-token}");
  return true;
}

let total = 0;
const written: string[] = [];
for (const service of services) {
  const specFile = Bun.file(`${root}/spec/${service}.json`);
  if (!(await specFile.exists())) continue;
  const spec = (await specFile.json()) as { commands: Record<string, Command> };
  for (const kind of kinds) {
    const casePath = `${casesDir}/${kind.file}-${service}.json`;
    const generated: Record<string, unknown>[] = [];
    for (const [command, node] of Object.entries(spec.commands)) {
      const key = `${service} ${command}`;
      const operation = node.operation;
      if (
        node.kind !== "generated" ||
        !operation ||
        !kind.methods.includes(operation.http ?? "") ||
        !methods.has(operation.http ?? "") ||
        existingKeys.has(key)
      )
        continue;
      const argv = [service, ...command.split(" ")];
      if (!kind.build(argv, node, operation)) continue;
      generated.push({
        id: `${kind.file}-${service}-${command.replaceAll(" ", "-")}`,
        key,
        argv,
        requestOnly: true,
        replies: kind.replies(operation),
      });
    }
    // Don't litter cases/ with empty files for services without such commands.
    if (!generated.length && !(await Bun.file(casePath).exists())) continue;
    await Bun.write(casePath, `${JSON.stringify(generated, null, 2)}\n`);
    written.push(casePath);
    total += generated.length;
  }
}

// Keep `bun fmt --check` green without a separate step.
Bun.spawnSync(["bun", "fmt", ...written], { stdout: "ignore" });
console.log(
  `${total} generated cases in ${written.length} file(s) → test/parity/cases/generated-{get,request}-*.json`,
);

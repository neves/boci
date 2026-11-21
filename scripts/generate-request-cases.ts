// Generate request-only parity cases for generated POST/PUT/PATCH commands.
// `bun run parity:request-cases --service <name>[,<name>…]` or `--all`.
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    service: { type: "string" },
    all: { type: "boolean", default: false },
  },
});
const root = `${import.meta.dir}/..`;
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
    "usage: bun run parity:request-cases --service <name>[,<name>…] | --all",
  );

const caseFile = (service: string) => `generated-request-${service}.json`;
const regenerated = new Set(services.map(caseFile));
const existingKeys = new Set<string>();
for await (const file of new Bun.Glob("**/*.json").scan(
  `${root}/test/parity/cases`,
)) {
  if (regenerated.has(file)) continue;
  const cases = (await Bun.file(
    `${root}/test/parity/cases/${file}`,
  ).json()) as {
    key: string;
  }[];
  for (const c of cases) existingKeys.add(c.key);
}

function sample(param: Record<string, unknown>): string {
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
    default:
      return "test-value";
  }
}

let total = 0;
const written: string[] = [];
for (const service of services) {
  const specFile = Bun.file(`${root}/spec/${service}.json`);
  if (!(await specFile.exists())) continue;
  const spec = await specFile.json();
  const casePath = `${root}/test/parity/cases/${caseFile(service)}`;
  const generated: Record<string, unknown>[] = [];
  for (const [command, node] of Object.entries(spec.commands) as [
    string,
    Record<string, unknown>,
  ][]) {
    const operation = node.operation as
      | {
          http?: string;
          responseType?: string;
          pathParams?: Record<string, string>;
          headerParams?: Record<string, unknown>;
          body?: string;
        }
      | undefined;
    const key = `${service} ${command}`;
    if (
      node.kind !== "generated" ||
      !["POST", "PUT", "PATCH"].includes(operation?.http ?? "") ||
      existingKeys.has(key)
    )
      continue;
    const argv = [service, ...command.split(" ")];
    const commandParams = (node.params ?? []) as Record<string, unknown>[];
    const params = commandParams;
    const pathArgs = new Set(Object.values(operation?.pathParams ?? {}));
    const bindings = (node.bindings ?? []) as Record<string, unknown>[];
    const bodyBindings = bindings.filter((b) => b.target === "body");
    if (bodyBindings.length === 0 && operation?.body) continue;
    const simpleBindings = bodyBindings.filter((b) => {
      const param = params.find((p) => p.name === b.param);
      return (
        typeof b.value === "string" ||
        typeof b.value === "boolean" ||
        (param !== undefined &&
          !["complex", "json", "complex type"].includes(String(param.type)) &&
          !String(param.typeClass).includes("Complex"))
      );
    });
    if (simpleBindings.length === 0) continue;
    for (const param of params) {
      const name = String(param.name);
      const binding = bindings.find(
        (entry) => entry.target === "body" && entry.param === name,
      );
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
      const complex =
        ["complex", "json", "complex type"].includes(String(param.type)) ||
        String(param.typeClass).includes("Complex");
      if (complex) {
        if (param.required === true) {
          const option = (param.opts as string[] | undefined)?.find((o) =>
            o.startsWith("--"),
          );
          if (option) argv.push(option, "{}");
        }
        continue;
      }
      if (param.required !== true && !pathArgs.has(name) && !binding.when)
        continue;
      const cliParam = params.find((p) => p.name === name) ?? param;
      const options = cliParam.opts as string[];
      const option = options?.find((o) => o.startsWith("--")) ?? options?.[0];
      if (!option) continue;
      argv.push(option);
      if (cliParam.isFlag !== true) argv.push(sample(cliParam));
    }
    // Path and query/header parameters needed by the generated callback.
    for (const param of params) {
      if (bindings.some((b) => b.target === "body" && b.param === param.name))
        continue;
      const hasRequestBinding = bindings.some(
        (binding) =>
          binding.param === param.name &&
          ["query", "path", "header"].includes(String(binding.target)),
      );
      if (
        param.required !== true &&
        !pathArgs.has(String(param.name)) &&
        !hasRequestBinding
      )
        continue;
      const options = param.opts as string[];
      const option = options?.find((o) => o.startsWith("--")) ?? options?.[0];
      if (!option) continue;
      argv.push(option);
      if (param.isFlag !== true) argv.push(sample(param));
    }
    if (
      operation?.headerParams?.["opc-retry-token"] &&
      !params.some((p) =>
        (p.opts as string[] | undefined)?.includes("--opc-retry-token"),
      )
    )
      argv.push("--opc-retry-token", "{opc-retry-token}");
    argv.push("--endpoint", "{endpoint}");
    if (
      params.some((p) =>
        (p.opts as string[] | undefined)?.includes("--opc-retry-token"),
      )
    )
      argv.push("--opc-retry-token", "{opc-retry-token}");
    generated.push({
      id: `generated-request-${service}-${command.replaceAll(" ", "-")}`,
      key,
      argv,
      requestOnly: true,
      replies: { body: {} },
    });
  }
  if (!generated.length && !(await Bun.file(casePath).exists())) continue;
  await Bun.write(casePath, `${JSON.stringify(generated, null, 2)}\n`);
  written.push(casePath);
  total += generated.length;
}
const coverage = new Set<string>();
for await (const file of new Bun.Glob("**/*.json").scan(
  `${root}/test/parity/cases`,
)) {
  const cases = (await Bun.file(
    `${root}/test/parity/cases/${file}`,
  ).json()) as {
    key: string;
    requestOnly?: boolean;
  }[];
  for (const c of cases) if (c.requestOnly) coverage.add(c.key);
}
await Bun.write(
  `${root}/src/generated-request-coverage.ts`,
  `// Generated by scripts/generate-request-cases.ts.\nexport const GENERATED_REQUEST_COVERAGE = new Set<string>([\n${[
    ...coverage,
  ]
    .sort()
    .map((key) => `  ${JSON.stringify(key)},`)
    .join("\n")}\n]);\n`,
);
Bun.spawnSync(["bun", "fmt", ...written], { stdout: "ignore" });
console.log(
  `${total} generated POST/PUT/PATCH cases in ${written.length} file(s) → test/parity/cases/generated-request-*.json`,
);

// Pure code-template and codemod helpers for `bun run scaffold` (unit-tested).
import { sample } from "./sample-param.ts";
import { operationConst, scaffoldNames, type Triage } from "./triage-lib.ts";

export type SpecParam = {
  name: string;
  opts?: string[];
  required?: boolean;
  isFlag?: boolean;
  kind?: string;
  nargs?: number;
  typeClass?: string;
  type?: string;
  choices?: string[];
};

/**
 * Render a starter Custom command file from its Reference CLI triage metadata.
 * Pre-fills every extracted SDK OperationSpec so the author only writes the wrapper logic.
 */
export function renderCommandFile(t: Triage, params?: SpecParam[]): string {
  const { path, fn } = scaffoldNames(t.key);
  const ops = (t.sdkCalls ?? []).filter((c) => c.operation);
  const firstOp = ops[0];
  const isList = firstOp?.method.startsWith("list_") ?? false;

  const lines: string[] = [];
  if (t.source) {
    lines.push(
      `// Reference: ${t.source.file}:${t.source.line} (${t.source.lines} lines)`,
    );
  }
  lines.push(
    `import { printResult } from "../../core/output.ts";`,
    `import type { CustomCommandContext } from "../../core/registry.ts";`,
    `import type { OperationSpec } from "../../core/spec.ts";`,
  );
  if (isList) {
    lines.push(
      `import { renderListPages, sdkCommand } from "../../lib/custom-command.ts";`,
    );
  } else {
    lines.push(
      `import { outputOptions, runOperation } from "../../lib/custom-command.ts";`,
    );
  }
  lines.push("");

  for (const call of ops) {
    const constName = operationConst(call.method);
    const { positionalArgs: _args, ...operation } = call.operation!;
    lines.push(
      `const ${constName}: OperationSpec = ${JSON.stringify(operation, null, 2)};`,
      "",
    );
  }

  lines.push(`export async function ${fn}(`);
  lines.push(`  ctx: CustomCommandContext,`);
  lines.push(`): Promise<void> {`);

  if (
    t.helpers?.includes("oci.wait_until") ||
    t.sourceText?.includes("oci.wait_until(")
  ) {
    lines.push(
      "  // TODO: port the reference waiter, including its getter and region selection.",
      '  if (Array.isArray(ctx.values.wait_for_state) && ctx.values.wait_for_state.length) throw new Error("Waiter not implemented");',
    );
  }
  if (firstOp) {
    const constName = operationConst(firstOp.method);
    const unbound = params ? unboundArgs(firstOp.operation!, params) : [];
    if (unbound.length)
      lines.push(
        `  // TODO: the wrapper builds ${unbound.join(", ")} itself; these aren't options of the command.`,
      );
    if (ops.length > 1)
      lines.push(
        `  // TODO: port the remaining calls: ${ops
          .slice(1)
          .map((c) => operationConst(c.method))
          .join(", ")}.`,
      );
    if (isList) {
      lines.push(
        `  const command = sdkCommand(ctx, ${JSON.stringify(path)}, ${constName});`,
        `  await renderListPages(ctx, ${JSON.stringify(path)}, ctx.values, command${
          (t.helpers ?? []).some((h) => h.endsWith("_multiple_keys"))
            ? ", { multipleKeys: true }"
            : ""
        });`,
      );
    } else {
      lines.push(
        `  const result = await runOperation(ctx, ${JSON.stringify(path)}, ${constName});`,
        `  printResult(ctx.io, result, outputOptions(ctx));`,
      );
    }
  } else {
    lines.push(
      `  // TODO: implement ${t.key}`,
      `  void ctx;`,
      `  throw new Error("Not implemented: ${t.key}");`,
    );
  }
  lines.push(`}`, "");
  return lines.join("\n");
}

/** The body and path arguments an operation reads that the command has no option for. */
function unboundArgs(
  operation: Record<string, unknown>,
  params: SpecParam[],
): string[] {
  const names = new Set(params.map((p) => p.name));
  const args = [
    operation.body,
    ...Object.values((operation.pathParams ?? {}) as Record<string, unknown>),
  ];
  return [
    ...new Set(
      args.filter((a): a is string => typeof a === "string" && !names.has(a)),
    ),
  ];
}

/**
 * Codemod `src/core/registry.ts` to add a lazy entry to `CUSTOM_HANDLERS`.
 * Idempotent: returns `registrySource` unchanged if `key` is already present.
 */
export function registerCustomHandler(
  registrySource: string,
  key: string,
): { source: string; changed: boolean } {
  const { file, fn } = scaffoldNames(key);
  const header =
    /export\s+const\s+CUSTOM_HANDLERS\s*=\s*new Map[^;]*?\(\s*\[/.exec(
      registrySource,
    );
  if (!header)
    throw new Error("Could not find CUSTOM_HANDLERS in src/core/registry.ts");
  const insertAt = header.index + header[0].length;
  const entries = registrySource.slice(insertAt).split(/\]\s*\)\s*;/, 1)[0]!;
  if (
    Array.from(
      entries.matchAll(/\[\s*["']([^"']+)["']\s*,/g),
      (m) => m[1],
    ).includes(key)
  )
    return { source: registrySource, changed: false };
  const relImport = file.replace(/^src\//, "../");
  const entry = [
    `  [`,
    `    ${JSON.stringify(key)},`,
    `    async (ctx) => {`,
    `      const { ${fn} } = await import(${JSON.stringify(relImport)});`,
    `      await ${fn}(ctx);`,
    `    },`,
    `  ],`,
  ].join("\n");

  return {
    source: `${registrySource.slice(0, insertAt)}\n${entry}${registrySource.slice(insertAt)}`,
    changed: true,
  };
}

/** Build a starter requestOnly Parity case from the command's required spec params. */
export function renderParityCase(
  key: string,
  params: SpecParam[],
  sendsRequest = true,
): string {
  const { caseId } = scaffoldNames(key);
  const argv = key.split(" ");
  for (const p of params) {
    if (!p.required) continue;
    const opt =
      p.opts?.find((o) => o.startsWith("--")) ??
      p.opts?.[0] ??
      `--${p.name.replaceAll("_", "-")}`;
    if (p.kind !== "argument") argv.push(opt);
    if (!p.isFlag) {
      const value =
        p.type === "datetime"
          ? p.name === "end_time"
            ? "2024-01-02T04:04:05.000Z"
            : "2024-01-02T03:04:05.000Z"
          : sample(p, placeholderFor(p.name));
      for (let i = 0; i < Math.max(1, p.nargs ?? 1); i++) argv.push(value);
    }
  }
  if (params.some((p) => p.opts?.includes("--force") && !p.required))
    argv.push("--force");
  argv.push("--endpoint", "{endpoint}");
  const data = [
    {
      id: caseId,
      key,
      requestOnly: sendsRequest,
      expect: sendsRequest ? { requests: 1 } : { exitCode: 0 },
      argv,
      replies: [{ body: {} }],
    },
  ];
  return `${JSON.stringify(data, null, 2)}\n`;
}

function placeholderFor(name: string): string {
  if (name.endsWith("_id") || name === "id") {
    const kind = name.replace(/_id$/, "").replaceAll("_", "") || "resource";
    return `ocid1.${kind}.oc1..test`;
  }
  return `test-${name.replaceAll("_", "-")}`;
}

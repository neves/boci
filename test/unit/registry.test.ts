import { expect, test } from "bun:test";
import {
  CUSTOM_HANDLERS,
  engineSupports,
  isImplemented,
} from "../../src/core/registry.ts";
import { loadIndex, loadService } from "../../src/core/spec.ts";

test("every key in CUSTOM_HANDLERS is a real custom Leaf command in the spec", async () => {
  expect(CUSTOM_HANDLERS.size).toBeGreaterThan(0);
  const index = await loadIndex();

  for (const key of CUSTOM_HANDLERS.keys()) {
    const [service = "", ...rest] = key.split(" ");
    expect(
      index.services[service] ?? index.nonServiceCommands.includes(service),
    ).toBeTruthy();
    const spec = await loadService(service);
    const cmd = spec.commands[rest.join(" ")];
    expect(cmd).toBeDefined();
    expect(cmd?.kind).toBe("custom");
    expect(isImplemented(key, cmd)).toBe(true);
  }
});

test("engine supports generated actions without request bodies", async () => {
  const { commands } = await loadService("data-safe");
  const stop = commands["audit-trail stop"];
  expect(stop?.operation?.http).toBe("POST");
  expect(stop?.operation?.body).toBeUndefined();
  expect(engineSupports(stop!)).toBe(true);
});

test("engine supports generated commands with a direct body parameter", async () => {
  const { commands } = await loadService("data-science");
  const upload = commands["model update-model-custom-metadatum-artifact"];
  expect(upload?.operation?.body).toBe("model_custom_metadatum_artifact");
  expect(engineSupports(upload!)).toBe(true);
});

test("engine supports bodyless actions with an unexposed SDK body argument", async () => {
  const { commands } = await loadService("batch");
  const start = commands["batch-context start"];
  expect(start?.operation?.body).toBeDefined();
  expect(
    start?.params?.some((param) => param.name === start.operation?.body),
  ).toBe(false);
  expect(engineSupports(start!)).toBe(true);
});

test("engine supports Tier A reads, bodyless deletes and writes", async () => {
  const apm = await loadService("apm-traces");
  const span = apm.commands["trace span get"];
  expect(span?.tier).toBe("A");
  expect(engineSupports(span!)).toBe(true);
  expect(isImplemented("apm-traces trace span get", span)).toBe(true);

  const safe = await loadService("data-safe");
  const get = safe.commands["private-endpoint get"];
  const remove = safe.commands["private-endpoint delete"];
  expect(get?.tier).toBe("A");
  expect(remove?.tier).toBe("A");
  expect(isImplemented("data-safe private-endpoint get", get)).toBe(true);
  expect(isImplemented("data-safe private-endpoint delete", remove)).toBe(true);
  expect(
    isImplemented("data-safe private-endpoint delete", {
      ...remove!,
      operation: { ...remove!.operation!, body: "requestBody" },
    }),
  ).toBe(false);
  const update = safe.commands["private-endpoint update"];
  expect(update?.tier).toBe("A");
  expect(update?.operation?.http).toBe("PUT");
  expect(isImplemented("data-safe private-endpoint update", update)).toBe(true);
});

test("loading cli and registry does not eagerly load command modules", () => {
  const res = Bun.spawnSync(
    [
      "bun",
      "-e",
      [
        'import { run } from "./src/core/cli.ts";',
        'import "./src/core/registry.ts";',
        'import { Exit } from "./src/lib/io.ts";',
        'const code = await run({ argv: ["--version"], env: {}, cwd: process.cwd(), out: () => {}, err: () => {}, isTTY: () => false });',
        'const loaded = Object.keys(require.cache).filter((k) => k.includes("/src/commands/"));',
        "console.log(JSON.stringify({ code, loaded }));",
      ].join("\n"),
    ],
    {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(res.exitCode).toBe(0);
  const parsed = JSON.parse(new TextDecoder().decode(res.stdout)) as {
    code: number;
    loaded: string[];
  };
  expect(parsed.code).toBe(0);
  expect(parsed.loaded).toEqual([]);
});

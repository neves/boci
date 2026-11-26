import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { run } from "../../src/core/cli.ts";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";
import { createSandbox } from "../harness/sandbox.ts";

test("function invoke reuses its cached endpoint and bypasses it when disabled or expired", async () => {
  await using sandbox = await createSandbox();
  using endpoint = startFakeEndpoint([
    { body: { invokeEndpoint: "{endpoint}/cached" } },
    { body: "first" },
    { body: "second" },
    { body: { invokeEndpoint: "{endpoint}/uncached" } },
    { body: "third" },
    { body: "fourth" },
    { body: { invokeEndpoint: "{endpoint}/refreshed" } },
    { body: "fifth" },
  ]);

  async function invoke(flags: string[] = []) {
    let stdout = "";
    let stderr = "";
    const exitCode = await run({
      argv: [
        "--endpoint",
        endpoint.url,
        "--config-file",
        sandbox.configFile,
        "--no-retry",
        "fn",
        "function",
        "invoke",
        "--function-id",
        "function-id",
        "--body",
        "test",
        "--file",
        "-",
        ...flags,
      ],
      env: sandbox.env,
      cwd: sandbox.home,
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      isTTY: () => false,
      columns: () => undefined,
    });
    expect(exitCode, stderr).toBe(0);
    return stdout;
  }

  expect(await invoke()).toBe("first");
  expect(await invoke()).toBe("second");
  expect(await invoke(["--no-endpoint-cache"])).toBe("third");
  expect(await invoke()).toBe("fourth");
  const file = Bun.file(
    `${sandbox.home}/.oci/functions-invoke-endpoint-cache.json`,
  );
  const cache = await file.json();
  const [entry] = Object.values<{ cached_at: string; key: unknown }>(
    cache.entries,
  );
  expect(entry?.key).toEqual({
    auth: "api_key",
    config_file: resolve(sandbox.configFile),
    enable_dual_stack: "",
    endpoint: endpoint.url,
    function_id: "function-id",
    profile: "DEFAULT",
    region: "",
  });
  entry!.cached_at = "2000-01-01T00:00:00.000000Z";
  await Bun.write(file, JSON.stringify(cache));
  expect(await invoke(["--endpoint-cache-ttl", "1"])).toBe("fifth");
  expect(
    endpoint.requests.map(({ method, path }) => [method, path.split("/")[1]]),
  ).toEqual([
    ["GET", "20260325"],
    ["POST", "cached"],
    ["POST", "cached"],
    ["GET", "20260325"],
    ["POST", "uncached"],
    ["POST", "cached"],
    ["GET", "20260325"],
    ["POST", "refreshed"],
  ]);
});

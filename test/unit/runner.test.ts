import { expect, test } from "bun:test";
import { CLIS, runCli } from "../harness/runner.ts";

const echo = ["bun", `${import.meta.dir}/../fixtures/clis/echo-cli.ts`];

test("runs a CLI in a sandbox against the fake endpoint and captures everything", async () => {
  const run = await runCli(echo, ["{endpoint}", "os", "ns", "get"], {
    replies: { body: '"fake-ns"' },
  });
  expect(run.exitCode).toBe(3);
  expect(run.stdout).toBe('"fake-ns"');
  expect(run.stderr).toBe("home={home}\n"); // sandbox path normalised
  expect(run.requests).toHaveLength(1);
  expect(run.requests[0]?.query).toEqual([["args", "os ns get"]]);
});

test("passes stdin through", async () => {
  const run = await runCli(echo, ["{endpoint}"], { stdin: "piped" });
  expect(run.stdout).toContain("stdin=piped");
});

test("boci is runnable through the runner", async () => {
  const run = await runCli(CLIS.boci, ["--version"]);
  expect(typeof run.exitCode).toBe("number");
});

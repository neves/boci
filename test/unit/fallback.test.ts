import { expect, test } from "bun:test";
import { notImplemented } from "../../src/core/fallback.ts";
import { Exit } from "../../src/lib/io.ts";
import { CLIS, runCli } from "../harness/runner.ts";
import { createSandbox } from "../harness/sandbox.ts";

const fakeOci = `${import.meta.dir}/../fixtures/clis/fake-oci.ts`;
const fallbackCli = ["bun", `${import.meta.dir}/../fixtures/clis/fallback.ts`];
const argv = ["example", "future-command"];

test("an unimplemented command fails with a clear message and exit code 3", async () => {
  const run = await runCli(fallbackCli, argv);
  expect(run.exitCode).toBe(3);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("oci example future-command");
  expect(run.stderr).toContain("not implemented");
  expect(run.stderr).toContain("BOCI_FALLBACK=oci");
  expect(run.requests).toEqual([]);
});

test("BOCI_FALLBACK hands the original argv and stdin to the Reference CLI and returns its exit code", async () => {
  const run = await runCli(fallbackCli, argv, {
    env: { BOCI_FALLBACK: fakeOci },
    stdin: "piped",
  });
  expect(run.exitCode).toBe(7);
  expect(JSON.parse(run.stdout)).toEqual({ argv, stdin: "piped", depth: "1" });
});

test("fallback refuses to recurse (e.g. when oci is a symlink to boci)", async () => {
  const run = await runCli(fallbackCli, argv, {
    env: { BOCI_FALLBACK: fakeOci, BOCI_FALLBACK_DEPTH: "1" },
  });
  expect(run.exitCode).toBe(3);
  expect(run.stderr).toContain("not implemented");
});

test("validation still happens before falling back", async () => {
  const run = await runCli(CLIS.boci, ["compute", "instance", "list"], {
    env: { BOCI_FALLBACK: fakeOci },
  });
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("Missing option(s) --compartment-id.");
});

test("in-process, the fallback's stdio is captured into the invocation's sinks", async () => {
  await using sandbox = await createSandbox();
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  try {
    await notImplemented(
      {
        argv,
        cwd: sandbox.home,
        env: { ...sandbox.env, BOCI_FALLBACK: fakeOci },
        stdin: "piped",
        isTTY: () => false,
        columns: () => 80,
        out: (text) => {
          stdout += text;
        },
        err: (text) => {
          stderr += text;
        },
      },
      argv,
      `oci ${argv.join(" ")}`,
    );
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    exitCode = error.code;
  }
  expect(exitCode).toBe(7);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ argv, stdin: "piped", depth: "1" });
});

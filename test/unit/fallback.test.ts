import { expect, test } from "bun:test";
import { CLIS, runCli, runInProcess } from "../harness/runner.ts";

const fakeOci = `${import.meta.dir}/../fixtures/clis/fake-oci.ts`;
// A Leaf command that passes validation but isn't implemented yet.
const argv = ["compute", "instance", "terminate", "--instance-id", "x"];

test("an unimplemented command fails with a clear message and exit code 3", async () => {
  const run = await runCli(CLIS.boci, argv);
  expect(run.exitCode).toBe(3);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("oci compute instance terminate");
  expect(run.stderr).toContain("not implemented");
  expect(run.stderr).toContain("BOCI_FALLBACK=oci");
  expect(run.requests).toEqual([]);
});

test("BOCI_FALLBACK hands the original argv and stdin to the Reference CLI and returns its exit code", async () => {
  const run = await runCli(CLIS.boci, argv, {
    env: { BOCI_FALLBACK: fakeOci },
    stdin: "piped",
  });
  expect(run.exitCode).toBe(7);
  expect(JSON.parse(run.stdout)).toEqual({ argv, stdin: "piped", depth: "1" });
});

test("fallback refuses to recurse (e.g. when oci is a symlink to boci)", async () => {
  const run = await runCli(CLIS.boci, argv, {
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
  const run = await runInProcess(argv, {
    env: { BOCI_FALLBACK: fakeOci },
    stdin: "piped",
  });
  expect(run.exitCode).toBe(7);
  expect(JSON.parse(run.stdout)).toEqual({ argv, stdin: "piped", depth: "1" });
});

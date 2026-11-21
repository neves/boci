import { describe, expect, test } from "bun:test";

describe("request case generator", () => {
  test("generates simple body flags and request-only coverage for write operations", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-request-cases.ts", "--service", "compute"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-compute.json`,
    ).json()) as { key: string; argv: string[]; requestOnly: boolean }[];
    const cluster = cases.find(
      (c) => c.key === "compute compute-cluster create",
    );
    expect(cluster).toBeDefined();
    expect(cluster?.requestOnly).toBe(true);
    expect(cluster?.argv).toContain("--display-name");
    expect(cluster?.argv).toContain("test-value");
  });
});

import { describe, expect, test } from "bun:test";

describe("parity case generator", () => {
  test("generates the Tier A tracer bullet request case with renamed options", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "apm-traces"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-get-apm-traces.json`,
    ).json()) as { key: string; argv: string[]; requestOnly: boolean }[];
    const span = cases.find((c) => c.key === "apm-traces trace span get");
    expect(span?.requestOnly).toBe(true);
    expect(span?.argv).toContain("--time-span-started-gte");
  });

  test("generates cases for Tier A reads and deletes across services", async () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/generate-cases.ts",
        "--service",
        "data-safe",
        "--method",
        "GET,HEAD,DELETE",
      ],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const gets = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-get-data-safe.json`,
    ).json()) as { key: string; requestOnly?: boolean }[];
    const deletes = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-bodyless-data-safe.json`,
    ).json()) as { key: string; requestOnly?: boolean; stdin?: string }[];
    expect(
      gets.find((c) => c.key === "data-safe private-endpoint get")?.requestOnly,
    ).toBe(true);
    expect(
      deletes.find((c) => c.key === "data-safe private-endpoint delete")?.stdin,
    ).toBe("y\n");
  });

  test("does not generate Tier A write cases before write support", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "data-safe"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-data-safe.json`,
    ).json()) as { key: string }[];
    expect(
      cases.some((c) => c.key === "data-safe registration-policy create"),
    ).toBe(false);
  });

  test("generates request cases for bodyless POST actions", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "data-safe"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-data-safe.json`,
    ).json()) as { key: string; argv: string[]; requestOnly: boolean }[];
    const stop = cases.find((c) => c.key === "data-safe audit-trail stop");
    expect(stop).toBeDefined();
    expect(stop?.requestOnly).toBe(true);
    expect(stop?.argv).toContain("--audit-trail-id");
  });

  test("generates file input for direct body parameters", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "data-science"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-data-science.json`,
    ).json()) as { key: string; argv: string[] }[];
    const upload = cases.find(
      (c) =>
        c.key === "data-science model update-model-custom-metadatum-artifact",
    );
    expect(upload?.argv).toContain("--model-custom-metadatum-artifact");
    expect(upload?.argv).toContain("file://test/fixtures/generated-body.txt");
  });

  test("generates bodyless requests when an SDK body argument has no CLI option", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "batch"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-batch.json`,
    ).json()) as { key: string; argv: string[] }[];
    const start = cases.find((c) => c.key === "batch batch-context start");
    expect(start).toBeDefined();
    expect(start?.argv).toContain("--batch-context-id");
    expect(start?.argv).not.toContain(
      "file://test/fixtures/generated-body.txt",
    );
  });

  test("generates bodyless HEAD and DELETE cases, including force bypasses", async () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/generate-cases.ts",
        "--service",
        "compute",
        "--method",
        "HEAD,DELETE",
      ],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-bodyless-compute.json`,
    ).json()) as {
      id: string;
      key: string;
      argv: string[];
      stdin?: string;
      requestOnly: boolean;
    }[];
    const deletion = cases.find(
      (c) =>
        c.key === "compute compute-cluster delete" && !c.id.endsWith("-force"),
    );
    const forced = cases.find(
      (c) =>
        c.key === "compute compute-cluster delete" && c.id.endsWith("-force"),
    );
    expect(deletion?.stdin).toBe("y\n");
    expect(deletion?.requestOnly).toBe(true);
    expect(forced?.argv).toContain("--force");
    expect(forced?.stdin).toBeUndefined();
  });

  test("generates simple body flags for write operations", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "compute"],
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

  test("generates complex-only body flags for write operations", async () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/generate-cases.ts", "--service", "compute"],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const cases = (await Bun.file(
      `${import.meta.dir}/../parity/cases/generated-request-compute.json`,
    ).json()) as { key: string; argv: string[]; requestOnly: boolean }[];
    const iccUpdate = cases.find(
      (c) => c.key === "compute instance-console-connection update",
    );
    expect(iccUpdate).toBeDefined();
    expect(iccUpdate?.requestOnly).toBe(true);
    expect(iccUpdate?.argv).toContain("--freeform-tags");
    expect(iccUpdate?.argv).toContain("{}");
    expect(iccUpdate?.argv).toContain("--force");
  });
});

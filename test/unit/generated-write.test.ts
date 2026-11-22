import { describe, expect, test } from "bun:test";
import { CLIS, runCli } from "../harness/runner.ts";

const WRITE_ARGV = [
  "compute",
  "compute-cluster",
  "create",
  "--availability-domain",
  "Uocm:PHX-AD-1",
  "--compartment-id",
  "ocid1.compartment.oc1..fake",
  "--display-name",
  "cluster-1",
  "--endpoint",
  "{endpoint}",
];

describe("generated write pipeline", () => {
  test("formats POST response with data wrapper, hyphenated keys, and etag", async () => {
    const run = await runCli(CLIS.boci, WRITE_ARGV, {
      replies: {
        headers: { etag: "write-etag" },
        body: {
          id: "ocid1.computecluster.oc1..fake",
          compartmentId: "ocid1.compartment.oc1..fake",
          displayName: "cluster-1",
          lifecycleState: "ACTIVE",
        },
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      data: {
        "compartment-id": "ocid1.compartment.oc1..fake",
        "display-name": "cluster-1",
        id: "ocid1.computecluster.oc1..fake",
        "lifecycle-state": "ACTIVE",
      },
      etag: "write-etag",
    });
  });

  test("applies --query, --raw-output, and --output table on write responses", async () => {
    const rawRun = await runCli(
      CLIS.boci,
      [...WRITE_ARGV, "--query", 'data."display-name"', "--raw-output"],
      {
        replies: {
          body: {
            id: "ocid1.computecluster.oc1..fake",
            displayName: "cluster-1",
          },
        },
      },
    );
    expect(rawRun.exitCode).toBe(0);
    expect(rawRun.stdout).toBe("cluster-1\n");

    const tableRun = await runCli(
      CLIS.boci,
      [...WRITE_ARGV, "--output", "table"],
      {
        replies: {
          body: {
            displayName: "cluster-1",
            lifecycleState: "ACTIVE",
          },
        },
      },
    );
    expect(tableRun.exitCode).toBe(0);
    expect(tableRun.stdout).toContain("cluster-1");
    expect(tableRun.stdout).toContain("ACTIVE");
  });

  test("handles empty response body without printing empty data object", async () => {
    const run = await runCli(CLIS.boci, WRITE_ARGV, {
      replies: { status: 204, body: "" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("formats non-2xx write response as structured ServiceError JSON", async () => {
    const run = await runCli(CLIS.boci, ["--no-retry", ...WRITE_ARGV], {
      replies: {
        status: 400,
        headers: { "opc-request-id": "write-err-req-id" },
        body: {
          code: "InvalidParameter",
          message: "Invalid compartmentId",
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith("ServiceError:\n{");
    const jsonText = run.stderr.slice("ServiceError:\n".length);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      code: "InvalidParameter",
      message: "Invalid compartmentId",
      "opc-request-id": "write-err-req-id",
      operation_name: "create_compute_cluster",
      status: 400,
    });
  });

  test("honors --request-id, --debug, and retries on write operations", async () => {
    const run = await runCli(
      CLIS.boci,
      [
        "--request-id",
        "custom-write-req-123",
        "--debug",
        "--max-retries",
        "2",
        ...WRITE_ARGV,
      ],
      {
        replies: [
          {
            status: 429,
            body: { code: "TooManyRequests", message: "retry" },
          },
          {
            body: { id: "cluster-1" },
          },
        ],
      },
    );
    expect(run.exitCode).toBe(0);
    expect(run.requests).toHaveLength(2);
    expect(run.requests[0]?.headers["opc-request-id"]).toBe(
      "custom-write-req-123",
    );
    expect(run.stderr).toMatch(/DEBUG:.*Request: POST .*\/computeClusters/);
    expect(run.stderr).toMatch(/DEBUG:.*Response status: 200/);
  });

  test("formats ConfigError, InvalidPrivateKey, and permission warnings on write operations", async () => {
    const missingProfile = await runCli(CLIS.boci, [
      ...WRITE_ARGV,
      "--profile",
      "no-such-profile",
    ]);
    expect(missingProfile.exitCode).toBe(1);
    expect(missingProfile.stderr).toContain(
      "ERROR: Profile 'no-such-profile' not found in config file",
    );

    const invalidKey = await runCli(
      CLIS.boci,
      [...WRITE_ARGV, "--profile", "bad-key"],
      {
        config: "[bad-key]\nkey_file = ~/.oci/bad.pem\n",
        sandbox: {
          files: { ".oci/bad.pem": "not a private key\n" },
        },
      },
    );
    expect(invalidKey.exitCode).toBe(1);
    expect(invalidKey.stderr).toContain(
      "The provided key is not a private key, or the provided passphrase is incorrect.",
    );

    const openConfig = await runCli(CLIS.boci, WRITE_ARGV, {
      sandbox: { configMode: 0o644 },
      replies: { body: { id: "cluster-1" } },
    });
    expect(openConfig.exitCode).toBe(0);
    expect(openConfig.stderr).toContain("WARNING: Permissions on");
  });

  test("evaluates binding.when conditions before adding optional body fields", async () => {
    const withoutDisplayName = await runCli(
      CLIS.boci,
      [
        "compute",
        "compute-cluster",
        "create",
        "--availability-domain",
        "Uocm:PHX-AD-1",
        "--compartment-id",
        "ocid1.compartment.oc1..fake",
        "--endpoint",
        "{endpoint}",
      ],
      { replies: { body: { id: "cluster-1" } } },
    );
    expect(withoutDisplayName.exitCode).toBe(0);
    expect(JSON.parse(withoutDisplayName.requests[0]?.body ?? "{}")).toEqual({
      availabilityDomain: "Uocm:PHX-AD-1",
      compartmentId: "ocid1.compartment.oc1..fake",
    });
  });
});

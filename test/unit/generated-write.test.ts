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
        "availability-domain": null,
        "defined-tags": null,
        "freeform-tags": null,
        "placement-constraint-details": null,
        "time-created": null,
        "time-updated": null,
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

  test("handles empty 204 response body by rendering null-initialized model fields like oci", async () => {
    const run = await runCli(CLIS.boci, WRITE_ARGV, {
      replies: { status: 204, body: "" },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      data: {
        "availability-domain": null,
        "compartment-id": null,
        "defined-tags": null,
        "display-name": null,
        "freeform-tags": null,
        id: null,
        "lifecycle-state": null,
        "placement-constraint-details": null,
        "time-created": null,
        "time-updated": null,
      },
    });
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

  test("loads file:// (including file://~) on body params, complex JSON params, and --from-json", async () => {
    const bodyFileRun = await runCli(
      CLIS.boci,
      [
        "compute",
        "compute-cluster",
        "create",
        "--availability-domain",
        "Uocm:PHX-AD-1",
        "--compartment-id",
        "ocid1.compartment.oc1..fake",
        "--display-name",
        "file://~/display-name.txt",
        "--freeform-tags",
        "file://~/tags.json",
        "--endpoint",
        "{endpoint}",
      ],
      {
        sandbox: {
          files: {
            "display-name.txt": "cluster-from-file",
            "tags.json": '{"boci-parity":"true"}',
          },
        },
        replies: { body: { id: "cluster-1" } },
      },
    );
    expect(bodyFileRun.exitCode).toBe(0);
    expect(JSON.parse(bodyFileRun.requests[0]?.body ?? "{}")).toEqual({
      availabilityDomain: "Uocm:PHX-AD-1",
      compartmentId: "ocid1.compartment.oc1..fake",
      displayName: "cluster-from-file",
      freeformTags: { "boci-parity": "true" },
    });

    const directBodyFileRun = await runCli(
      CLIS.boci,
      [
        "email-data-plane",
        "email-raw-submitted-response",
        "submit-raw-email",
        "--content-type",
        "message/rfc822",
        "--compartment-id",
        "ocid1.compartment.oc1..fake",
        "--sender",
        "sender@example.com",
        "--recipients",
        "to@example.com",
        "--raw-message",
        "file://~/raw.eml",
        "--endpoint",
        "{endpoint}",
      ],
      {
        sandbox: {
          files: {
            "raw.eml": "Subject: Test\r\n\r\nHello",
          },
        },
        replies: { body: {} },
      },
    );
    expect(directBodyFileRun.exitCode).toBe(0);
    expect(directBodyFileRun.requests[0]?.body).toBe(
      "Subject: Test\r\n\r\nHello",
    );
  });

  test("formats Reference CLI errors for invalid JSON and missing file:// paths", async () => {
    const badFromJson = await runCli(CLIS.boci, [
      "os",
      "bucket",
      "create",
      "--from-json",
      "{invalid",
    ]);
    expect(badFromJson.exitCode).toBe(1);
    expect(badFromJson.stdout).toBe("");
    expect(badFromJson.stderr).toBe(
      "Parameter 'from-json' must be in JSON format.\nFor help with formatting JSON input see our documentation here: https://docs.cloud.oracle.com/iaas/Content/API/SDKDocs/cliusing.htm#ManagingCLIInputandOutput\n",
    );

    const nonObjectFromJson = await runCli(CLIS.boci, [
      "os",
      "bucket",
      "create",
      "--from-json",
      "[1, 2]",
    ]);
    expect(nonObjectFromJson.exitCode).toBe(1);
    expect(nonObjectFromJson.stdout).toBe("");
    expect(nonObjectFromJson.stderr).toBe(
      "We expect a JSON object to be provided to --from-json\n",
    );

    const missingFromJsonFile = await runCli(CLIS.boci, [
      "os",
      "bucket",
      "create",
      "--from-json",
      "file://~/missing-input.json",
    ]);
    expect(missingFromJsonFile.exitCode).toBe(1);
    expect(missingFromJsonFile.stdout).toBe("");
    expect(missingFromJsonFile.stderr).toMatch(
      /^The specified file 'file:\/\/~\/missing-input\.json' did not exist {2}\(Resolved to path: '.*\/missing-input\.json'\)\n$/,
    );

    const badComplexJson = await runCli(CLIS.boci, [
      "os",
      "bucket",
      "create",
      "--namespace-name",
      "ns",
      "--name",
      "b",
      "--compartment-id",
      "c",
      "--metadata",
      "{invalid",
    ]);
    expect(badComplexJson.exitCode).toBe(1);
    expect(badComplexJson.stdout).toBe("");
    expect(badComplexJson.stderr).toBe(
      "Parameter 'metadata' must be in JSON format.\nFor help with formatting JSON input see our documentation here: https://docs.cloud.oracle.com/iaas/Content/API/SDKDocs/cliusing.htm#ManagingCLIInputandOutput\n",
    );
  });

  test("enforces CLI flags > --from-json > oci_cli_rc defaults precedence and converts --from-json keys and values", async () => {
    const run = await runCli(
      CLIS.boci,
      [
        "os",
        "bucket",
        "create",
        "--name",
        "cli-name",
        "--endpoint",
        "{endpoint}",
        "--from-json",
        "file://~/input.json",
      ],
      {
        sandbox: {
          files: {
            "input.json": JSON.stringify({
              name: "json-name",
              compartment_id: "json-compartment",
              "namespace-name": "json-namespace",
              storageTier: "archive",
              objectEventsEnabled: "true",
              metadata: "file://~/meta.json",
            }),
            "meta.json": '{"k":"v"}',
            ".oci/oci_cli_rc":
              "[DEFAULT]\nname = rc-name\ncompartment-id = rc-compartment\nstorage-tier = Standard\npublic-access-type = ObjectRead\n",
          },
        },
        replies: { body: {} },
      },
    );
    expect(run.exitCode).toBe(0);
    expect(run.requests[0]?.path).toBe("/n/json-namespace/b");
    expect(JSON.parse(run.requests[0]?.body ?? "{}")).toEqual({
      name: "cli-name",
      compartmentId: "json-compartment",
      storageTier: "Archive",
      publicAccessType: "ObjectRead",
      objectEventsEnabled: true,
      metadata: { k: "v" },
    });
  });
});

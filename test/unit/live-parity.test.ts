import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceSpec } from "../../src/core/spec.ts";
import {
  buildReadCommandPlan,
  compareLiveRuns,
  formatCounter,
  formatDuration,
  formatElapsedHMS,
  formatMarkdownReport,
  isRateLimited,
  type LiveContext,
  type LiveParityRecord,
  loadCompletedRecords,
  normalizeLiveOutput,
  parseOciProfile,
  summarizeRecords,
} from "../../scripts/live-parity-lib.ts";

const ctx: LiveContext = {
  profile: "TEST",
  tenancy: "ocid1.tenancy.oc1..aaaaaaaafake",
  user: "ocid1.user.oc1..aaaaaaaafake",
  region: "us-ashburn-1",
  namespace: "fakens",
  availabilityDomain: "Uocm:US-ASHBURN-AD-1",
};

function makeSpec(
  service: string,
  commands: Record<string, unknown>,
  clients: Record<string, unknown> = {
    default: { regionalClient: true },
  },
): ServiceSpec {
  return {
    service,
    top: { hidden: false, helpDoc: {} as never },
    groups: {},
    commands: commands as ServiceSpec["commands"],
    clients: clients as ServiceSpec["clients"],
    jsonExamplePool: {},
    models: {},
  } as ServiceSpec;
}

describe("parseOciProfile", () => {
  test("extracts tenancy, user, and region for matching profile", () => {
    const config = `[DEFAULT]
tenancy=ocid1.tenancy.oc1..default
user=ocid1.user.oc1..default
region=us-phoenix-1

[TEST]
tenancy = ocid1.tenancy.oc1..test
user = ocid1.user.oc1..test
region = us-ashburn-1
`;
    expect(parseOciProfile(config, "TEST")).toEqual({
      tenancy: "ocid1.tenancy.oc1..test",
      user: "ocid1.user.oc1..test",
      region: "us-ashburn-1",
    });
  });

  test("throws when profile is missing", () => {
    expect(() => parseOciProfile("[DEFAULT]\ntenancy=x\n", "NOPE")).toThrow(
      /not found/,
    );
  });
});

describe("buildReadCommandPlan", () => {
  test("includes only regional GET/HEAD commands whose required params are satisfiable", () => {
    const specs: ServiceSpec[] = [
      makeSpec("iam", {
        "region list": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "list_regions",
            http: "GET",
            path: "/regions",
            queryParams: {},
          },
          params: [],
        },
        "compartment list": {
          hidden: false,
          kind: "custom",
          operation: {
            client: "default",
            method: "list_compartments",
            http: "GET",
            path: "/compartments",
            queryParams: {},
          },
          params: [
            {
              name: "compartment_id",
              opts: ["--compartment-id", "-c"],
              required: true,
            },
          ],
        },
        "user create": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "create_user",
            http: "POST",
            path: "/users",
            queryParams: {},
          },
          params: [
            {
              name: "compartment_id",
              opts: ["--compartment-id"],
              required: true,
            },
          ],
        },
        "user delete": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "delete_user",
            http: "DELETE",
            path: "/users/{id}",
            queryParams: {},
          },
          params: [{ name: "user_id", opts: ["--user-id"], required: true }],
        },
        "group get": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "get_group",
            http: "GET",
            path: "/groups/{id}",
            queryParams: {},
          },
          params: [{ name: "group_id", opts: ["--group-id"], required: true }],
        },
      }),
      makeSpec("os", {
        "ns get": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "get_namespace",
            http: "GET",
            path: "/n",
            queryParams: {},
          },
          params: [],
        },
        "bucket list": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "list_buckets",
            http: "GET",
            path: "/n/{ns}/b",
            queryParams: {},
          },
          params: [
            {
              name: "compartment_id",
              opts: ["--compartment-id"],
              required: true,
            },
            {
              name: "namespace_name",
              opts: ["--namespace-name", "-ns"],
              required: true,
            },
          ],
        },
        "object get": {
          hidden: false,
          kind: "custom",
          operation: {
            client: "default",
            method: "get_object",
            http: "GET",
            path: "/n/{ns}/b/{b}/o/{o}",
            responseType: "stream",
            queryParams: {},
          },
          params: [{ name: "file", opts: ["--file"], required: false }],
        },
      }),
      makeSpec(
        "identity-domains",
        {
          "users list": {
            hidden: false,
            kind: "custom",
            operation: {
              client: "nonreg",
              method: "list_users",
              http: "GET",
              path: "/Users",
              queryParams: {},
            },
            params: [],
          },
        },
        { nonreg: { regionalClient: false } },
      ),
      makeSpec("setup", {
        config: {
          hidden: false,
          kind: "custom",
          operation: {
            client: "default",
            method: "x",
            http: "GET",
            path: "/x",
            queryParams: {},
          },
          params: [],
        },
      }),
    ];

    const plan = buildReadCommandPlan(specs, ctx);
    expect(plan.map((p) => p.key)).toEqual([
      "iam compartment list",
      "iam region list",
      "os bucket list",
      "os ns get",
    ]);
    expect(plan.find((p) => p.key === "os bucket list")?.argv).toEqual([
      "os",
      "bucket",
      "list",
      "--compartment-id",
      ctx.tenancy,
      "--namespace-name",
      "fakens",
      "--no-retry",
    ]);
  });

  test("passes optional --compartment-id to avoid MissingParameter errors", () => {
    const specs = [
      makeSpec("adm", {
        "knowledge-base list": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "list_knowledge_bases",
            http: "GET",
            path: "/knowledgeBases",
            queryParams: {},
          },
          params: [
            {
              name: "compartment_id",
              opts: ["--compartment-id", "-c"],
              required: false,
            },
            { name: "id", opts: ["--id"], required: false },
          ],
        },
      }),
    ];
    const plan = buildReadCommandPlan(specs, ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.argv).toEqual([
      "adm",
      "knowledge-base",
      "list",
      "--compartment-id",
      ctx.tenancy,
      "--no-retry",
    ]);
  });

  test("excludes commands that have any non-GET/HEAD sdkOperation", () => {
    const specs = [
      makeSpec("compute", {
        "mixed cmd": {
          hidden: false,
          kind: "custom",
          operation: {
            client: "default",
            method: "get_x",
            http: "GET",
            path: "/x",
            queryParams: {},
          },
          sdkOperations: [
            {
              client: "default",
              method: "post_y",
              http: "POST",
              path: "/y",
              queryParams: {},
            },
          ],
          params: [],
        },
      }),
    ];
    expect(buildReadCommandPlan(specs, ctx)).toEqual([]);
  });

  test("respects service and substring filters", () => {
    const specs = [
      makeSpec("iam", {
        "region list": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "list_regions",
            http: "GET",
            path: "/regions",
            queryParams: {},
          },
          params: [],
        },
      }),
      makeSpec("os", {
        "ns get": {
          hidden: false,
          kind: "generated",
          operation: {
            client: "default",
            method: "get_ns",
            http: "GET",
            path: "/n",
            queryParams: {},
          },
          params: [],
        },
      }),
    ];
    expect(
      buildReadCommandPlan(specs, ctx, { services: ["os"] }).map((p) => p.key),
    ).toEqual(["os ns get"]);
    expect(
      buildReadCommandPlan(specs, ctx, { filter: "region" }).map((p) => p.key),
    ).toEqual(["iam region list"]);
  });
});

describe("live output comparison & rate-limit detection", () => {
  test("matches ServiceError envelopes that differ only in opc-request-id and timestamp", () => {
    const ociErr = `ServiceError:
{
    "code": "NotAuthorizedOrNotFound",
    "message": "Authorization failed",
    "opc-request-id": "AAA111/BBB222/CCC333",
    "status": 404,
    "timestamp": "2026-11-26T15:00:01.123456+00:00"
}
`;
    const bociErr = `ServiceError:
{
    "code": "NotAuthorizedOrNotFound",
    "message": "Authorization failed",
    "opc-request-id": "DDD444/EEE555/FFF666",
    "status": 404,
    "timestamp": "2026-11-26T15:00:02.654321+00:00"
}
`;
    expect(normalizeLiveOutput(ociErr, "stderr")).toBe(
      normalizeLiveOutput(bociErr, "stderr"),
    );
    const res = compareLiveRuns(
      { exitCode: 1, elapsedMs: 900, stdout: "", stderr: ociErr },
      { exitCode: 1, elapsedMs: 120, stdout: "", stderr: bociErr },
    );
    expect(res.match).toBe(true);
    expect(res.outcome).toBe("api-error");
  });

  test("signals divergence when stdout or exit code differs", () => {
    const res = compareLiveRuns(
      { exitCode: 0, elapsedMs: 800, stdout: '{"data": "a"}\n', stderr: "" },
      { exitCode: 0, elapsedMs: 100, stdout: '{"data": "b"}\n', stderr: "" },
    );
    expect(res.match).toBe(false);
    expect(res.diffs.length).toBe(1);
    expect(res.diffs[0]).toContain("stdout");
  });

  test("ignores per-request opc-next-page and etag differences when data is identical", () => {
    const res = compareLiveRuns(
      {
        exitCode: 0,
        elapsedMs: 800,
        stdout:
          '{"data": [{"id": 1}], "opc-next-page": "tok-a", "etag": "e1"}\n',
        stderr: "",
      },
      {
        exitCode: 0,
        elapsedMs: 100,
        stdout:
          '{"data": [{"id": 1}], "opc-next-page": "tok-b", "etag": "e2"}\n',
        stderr: "",
      },
    );
    expect(res.match).toBe(true);
    expect(res.volatileReasons).toEqual(["envelope-token"]);
  });

  test("classifies recent same-format server timestamps, JWTs, and reordered arrays as live-volatile matches", () => {
    const ts = compareLiveRuns(
      {
        exitCode: 0,
        elapsedMs: 500,
        stdout:
          '{"data":{"time-created":"2026-11-26T19:07:22.760000+00:00"}}\n',
        stderr: "",
      },
      {
        exitCode: 0,
        elapsedMs: 100,
        stdout:
          '{"data":{"time-created":"2026-11-26T19:07:23.184000+00:00"}}\n',
        stderr: "",
      },
    );
    expect(ts.match).toBe(true);
    expect(ts.volatileReasons).toEqual(["server-timestamp"]);

    // Different timestamp format MUST still diverge
    const badTs = compareLiveRuns(
      {
        exitCode: 0,
        elapsedMs: 500,
        stdout:
          '{"data":{"time-created":"2026-11-26T19:07:22.760000+00:00"}}\n',
        stderr: "",
      },
      {
        exitCode: 0,
        elapsedMs: 100,
        stdout: '{"data":{"time-created":"2026-11-26T19:07:22.760Z"}}\n',
        stderr: "",
      },
    );
    expect(badTs.match).toBe(false);

    // Freshly minted JWT with identical header & non-time claims (including embedded request signature/date in sub)
    const mkJwt = (iat: number, date: string, reqSig: string, sig: string) =>
      `${Buffer.from('{"typ":"JWT","alg":"HS256"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({
          sub: JSON.stringify({
            userId: "u1",
            claims: [
              {
                key: "authorization",
                value: `Signature keyId="k",signature="${reqSig}",version="1"`,
              },
              { key: "h_date", value: date },
            ],
          }),
          iat,
          exp: iat + 3600,
        }),
      ).toString("base64url")}.${sig}`;
    const jwt = compareLiveRuns(
      {
        exitCode: 0,
        elapsedMs: 500,
        stdout: JSON.stringify({
          data: {
            "access-token": mkJwt(
              1795720052,
              "Thu, 26 Nov 2026 19:28:56 GMT",
              "reqSigA==",
              "sigA",
            ),
          },
        }),
        stderr: "",
      },
      {
        exitCode: 0,
        elapsedMs: 100,
        stdout: JSON.stringify({
          data: {
            "access-token": mkJwt(
              1795720053,
              "Thu, 26 Nov 2026 19:28:57 GMT",
              "reqSigB==",
              "sigB",
            ),
          },
        }),
        stderr: "",
      },
    );
    expect(jwt.match).toBe(true);
    expect(jwt.volatileReasons).toEqual(["jwt-token"]);

    // Nondeterministic server array order -> volatile match when multiset is identical
    const arr = compareLiveRuns(
      {
        exitCode: 0,
        elapsedMs: 500,
        stdout: JSON.stringify({
          data: {
            items: [
              { type: "A", count: 1 },
              { type: "B", count: 2 },
            ],
          },
        }),
        stderr: "",
      },
      {
        exitCode: 0,
        elapsedMs: 100,
        stdout: JSON.stringify({
          data: {
            items: [
              { type: "B", count: 2 },
              { type: "A", count: 1 },
            ],
          },
        }),
        stderr: "",
      },
    );
    expect(arr.match).toBe(true);
    expect(arr.volatileReasons).toEqual(["array-order"]);
  });

  test("masks embedded opcRequestId inside ServiceError messages", () => {
    const mk = (id: string) =>
      `ServiceError:\n{\n    "original_message": "failed: opcRequestId=${id}"\n}\n`;
    expect(
      compareLiveRuns(
        { exitCode: 1, elapsedMs: 500, stdout: "", stderr: mk("AAA/BBB/CCC") },
        {
          exitCode: 1,
          elapsedMs: 100,
          stdout: "",
          stderr: mk("oci-123/DDD/EEE"),
        },
      ).match,
    ).toBe(true);
  });

  test("detects HTTP 429 / TooManyRequests rate limiting", () => {
    expect(
      isRateLimited({
        exitCode: 1,
        elapsedMs: 500,
        stdout: "",
        stderr:
          'ServiceError:\n{\n    "code": "TooManyRequests",\n    "status": 429\n}\n',
      }),
    ).toBe(true);
    expect(
      isRateLimited({ exitCode: 0, elapsedMs: 500, stdout: "429", stderr: "" }),
    ).toBe(false);
  });
});

describe("resume & reporting", () => {
  test("loads JSONL records, ignores truncated trailing line, and keeps latest per key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-live-parity-"));
    try {
      const file = join(dir, "results.jsonl");
      const r1: LiveParityRecord = {
        key: "os ns get",
        service: "os",
        argv: ["os", "ns", "get", "--no-retry"],
        timestamp: "2026-11-26T15:00:00.000Z",
        oci: {
          exitCode: 0,
          elapsedMs: 1000,
          stdout: '{"data":"x"}\n',
          stderr: "",
        },
        boci: { exitCode: 1, elapsedMs: 100, stdout: "", stderr: "oops" },
        speedup: 10,
        status: "diverged",
        outcome: "ok",
        diffs: ["exitCode: oci=0 vs boci=1"],
      };
      const r1Fixed: LiveParityRecord = {
        ...r1,
        boci: {
          exitCode: 0,
          elapsedMs: 100,
          stdout: '{"data":"x"}\n',
          stderr: "",
        },
        status: "match",
        diffs: [],
      };
      await Bun.write(
        file,
        `${JSON.stringify(r1)}\n${JSON.stringify(r1Fixed)}\n{"key":"partial`,
      );
      const map = await loadCompletedRecords(file);
      expect(map.size).toBe(1);
      expect(map.get("os ns get")?.status).toBe("match");

      const summary = summarizeRecords([...map.values()], 5);
      expect(summary.completed).toBe(1);
      expect(summary.remaining).toBe(4);
      expect(summary.matchedOk).toBe(1);
      expect(summary.overallSpeedup).toBe(10);

      const md = formatMarkdownReport(summary, [...map.values()]);
      expect(md).toContain("os ns get");
      expect(md).toContain("10.00×");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats durations, hh:mm:ss elapsed time, and fixed-width counters cleanly", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
    expect(formatElapsedHMS(0)).toBe("00:00:00");
    expect(formatElapsedHMS(5_900)).toBe("00:00:05");
    expect(formatElapsedHMS(3_661_000)).toBe("01:01:01");
    expect(formatCounter(1, 1123)).toBe("0001/1123");
    expect(formatCounter(42, 40)).toBe("0042/0040");
  });
});

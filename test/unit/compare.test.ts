import { describe, expect, test } from "bun:test";
import type { Run } from "../harness/runner.ts";
import {
  normalizeRun,
  parseAuthorization,
  requestOnlyMismatch,
} from "../harness/compare.ts";

const auth =
  'Signature algorithm="rsa-sha256",headers="date (request-target) host",keyId="ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb",signature="QUJD",version="1"';

const run = (over: Partial<Run> = {}): Run => ({
  stdout: '{\n  "data": "ns"\n}\n',
  stderr: "",
  exitCode: 0,
  requests: [
    {
      method: "GET",
      path: "/n",
      rawQuery: "",
      query: [],
      headers: {
        date: "Sat, 21 Nov 2026 07:00:00 GMT",
        authorization: auth,
        "opc-request-id": "ABC",
        "opc-client-request-id": "ABC",
        "user-agent": "Oracle-PythonSDK/2.192.0",
        accept: "application/json",
        host: "127.0.0.1:1234",
      },
      body: "",
    },
  ],
  ...over,
});

test("parses the Authorization signature header", () => {
  expect(parseAuthorization(auth)).toEqual({
    scheme: "Signature",
    algorithm: "rsa-sha256",
    headers: "date (request-target) host",
    keyId: "ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb",
    version: "1",
  });
});

test("volatile headers are dropped and the signature reduced to its structure", () => {
  const n = normalizeRun(run());
  const headers = n.requests[0]?.headers ?? {};
  expect(headers.date).toBeUndefined();
  expect(headers["opc-request-id"]).toBeUndefined();
  expect(headers["user-agent"]).toBeUndefined();
  expect(headers.host).toBeUndefined();
  expect(headers.accept).toBe("application/json");
  expect(n.requests[0]?.authorization?.headers).toBe(
    "date (request-target) host",
  );
});

test("two runs differing only in volatile values normalize equal", () => {
  const other = run();
  const req = other.requests[0];
  if (req) {
    req.headers = {
      ...req.headers,
      date: "Sun, 22 Nov 2026 01:02:03 GMT",
      "opc-request-id": "XYZ",
      authorization: auth.replace("QUJD", "WFla"),
    };
  }
  expect(normalizeRun(other)).toEqual(normalizeRun(run()));
});

test("JSON request bodies compare structurally, other bodies verbatim", () => {
  const a = run();
  const b = run();
  if (a.requests[0] && b.requests[0]) {
    a.requests[0].body = '{"a":1,"b":2}';
    b.requests[0].body = '{"b": 2, "a": 1}';
  }
  expect(normalizeRun(a)).toEqual(normalizeRun(b));
});

test("stderr warnings and error JSON are kept, stdout is byte-exact", () => {
  expect(normalizeRun(run({ stdout: "x " })).stdout).toBe("x ");
});

test("successful stdout timestamps, including timezone-free values, compare exactly", () => {
  const a = '{"timestamp": "2026-01-01T00:00:00"}';
  const b = '{"timestamp": "2026-01-02T00:00:00"}';
  expect(normalizeRun(run({ stdout: a })).stdout).toBe(a);
  expect(normalizeRun(run({ stdout: a })).stdout).not.toBe(
    normalizeRun(run({ stdout: b })).stdout,
  );
});

test("only the top-level timestamp of a recognized stderr exception is masked", () => {
  const a =
    'ServiceError:\n{\n    "timestamp": "2026-01-01T00:00:00.000000+00:00",\n    "details": {\n        "timestamp": "2026-01-01T00:00:00"\n    }\n}\n';
  const b = a.replaceAll("2026-01-01", "2026-01-02");
  expect(normalizeRun(run({ stderr: a })).stderr).not.toBe(
    normalizeRun(run({ stderr: b })).stderr,
  );
  expect(normalizeRun(run({ stderr: a })).stderr).toContain(
    '"timestamp": "<timestamp>"',
  );
  expect(
    normalizeRun(
      run({ stderr: a.replace("ServiceError:", "UnrelatedException:") }),
    ).stderr,
  ).toContain("2026-01-01");
});

describe("requestOnlyMismatch", () => {
  const norm = (over: Partial<Run> = {}) => normalizeRun(run(over));

  test("passes when only the output differs", () => {
    expect(
      requestOnlyMismatch(
        norm({ stdout: "boci output\n" }),
        norm({ stdout: "oci output\n" }),
      ),
    ).toBeUndefined();
  });

  test("fails when boci reports the command is not implemented", () => {
    const notImplemented = norm({
      exitCode: 3,
      stdout: "",
      stderr:
        "boci: 'network-firewall mapped-secret create' is not implemented yet (run `bun run status` in the boci repo for coverage).\n",
      requests: [],
    });
    expect(
      requestOnlyMismatch(notImplemented, norm({ exitCode: 2, requests: [] })),
    ).toContain("not implemented");
  });

  test("fails when boci exits 3 and the Reference CLI did not", () => {
    expect(
      requestOnlyMismatch(
        norm({ exitCode: 3, requests: [] }),
        norm({ requests: [] }),
      ),
    ).toContain("exit");
  });

  test("fails when only one side sent a request", () => {
    expect(requestOnlyMismatch(norm({ requests: [] }), norm())).toContain(
      "request",
    );
    expect(requestOnlyMismatch(norm(), norm({ requests: [] }))).toContain(
      "request",
    );
  });

  test("passes when neither side sent a request", () => {
    expect(
      requestOnlyMismatch(
        norm({ requests: [], exitCode: 1, stderr: "x" }),
        norm({ requests: [], exitCode: 2, stderr: "y" }),
      ),
    ).toBeUndefined();
  });
});

test("requestOnlyMismatch ignores the phrase inside a crash's stack trace", () => {
  const crash = normalizeRun(
    run({
      exitCode: 1,
      stderr:
        "86 | throw e.err(`ERROR: 'oci session authenticate' is not implemented yet.\\n`)\n\nTypeError: ECONNREFUSED\n",
      requests: [],
    }),
  );
  expect(
    requestOnlyMismatch(
      crash,
      normalizeRun(run({ exitCode: 1, requests: [] })),
    ),
  ).toBeUndefined();
});

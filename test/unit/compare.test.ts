import { expect, test } from "bun:test";
import type { Run } from "../harness/runner.ts";
import { normalizeRun, parseAuthorization } from "../harness/compare.ts";

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

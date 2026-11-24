import { describe, expect, test } from "bun:test";
import { createPublicKey, createVerify } from "node:crypto";
import {
  buildPresignedTokenUrl,
  formatExpirationTimestamp,
  urlsafeBase64Encode,
} from "../../src/commands/ce/cluster_generate_token.ts";
import { parseAuthorization } from "../harness/compare.ts";
import { runInProcess } from "../harness/runner.ts";
import { FAKE_KEY_PEM } from "../harness/sandbox.ts";

const FAKE_PUBLIC_KEY = createPublicKey(FAKE_KEY_PEM)
  .export({ type: "spki", format: "pem" })
  .toString();

type ExecCredential = {
  apiVersion: string;
  kind: string;
  status: {
    token: string;
    expirationTimestamp: string;
  };
};

function verifyExecCredentialToken(
  stdout: string,
  publicKeyPem: string,
  expectedBaseUrl: string,
  expectedExtraParams: Record<string, string> = {},
) {
  expect(stdout.startsWith("\n{\n")).toBe(true);
  expect(stdout.endsWith("}\n    \n")).toBe(true);

  const parsed = JSON.parse(stdout) as ExecCredential;
  expect(parsed.apiVersion).toBe("client.authentication.k8s.io/v1beta1");
  expect(parsed.kind).toBe("ExecCredential");

  // Token must be padded urlsafe base64.
  const token = parsed.status.token;
  expect(token).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
  expect(token.length % 4).toBe(0);

  const decodedUrl = Buffer.from(
    token.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  ).toString("utf8");
  const url = new URL(decodedUrl);
  expect(`${url.origin}${url.pathname}`).toBe(expectedBaseUrl);

  const authorization = url.searchParams.get("authorization");
  const date = url.searchParams.get("date");
  expect(authorization).toBeTruthy();
  expect(date).toMatch(
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  );

  for (const [k, v] of Object.entries(expectedExtraParams)) {
    expect(url.searchParams.get(k)).toBe(v);
  }

  // Cryptographically verify the RSA-SHA256 signature against the signed headers.
  const auth = parseAuthorization(authorization!);
  expect(auth.scheme).toBe("Signature");
  expect(auth.algorithm).toBe("rsa-sha256");
  expect(auth.version).toBe("1");
  const sig = /signature="([^"]+)"/.exec(authorization!)?.[1];
  expect(sig).toBeTruthy();

  const headerValues: Record<string, string> = {
    date: date!,
    host: url.host,
    ...expectedExtraParams,
  };
  const headerNames = (auth.headers ?? "").split(" ");
  const signingString = headerNames
    .map((name) =>
      name === "(request-target)"
        ? `(request-target): get ${url.pathname}`
        : `${name}: ${headerValues[name] ?? ""}`,
    )
    .join("\n");

  const valid = createVerify("sha256")
    .update(signingString)
    .verify(publicKeyPem, sig!, "base64");
  expect(valid).toBe(true);

  return { parsed, url, auth, decodedUrl };
}

describe("ce cluster generate-token", () => {
  test("produces a cryptographically valid presigned URL for api_key auth", async () => {
    const before = Date.now();
    const run = await runInProcess([
      "ce",
      "cluster",
      "generate-token",
      "--cluster-id",
      "ocid1.cluster.oc1..verify",
    ]);
    const after = Date.now();

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.requests).toHaveLength(0);

    const { parsed, auth } = verifyExecCredentialToken(
      run.stdout,
      FAKE_PUBLIC_KEY,
      "https://containerengine.us-ashburn-1.oraclecloud.com/cluster_request/ocid1.cluster.oc1..verify",
    );
    expect(auth.headers).toBe("date (request-target) host");
    expect(auth.keyId).toContain("ocid1.tenancy.oc1..aaaaaaaabocifaketenancy");

    expect(parsed.status.expirationTimestamp).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/,
    );
    const expMs = Date.parse(parsed.status.expirationTimestamp);
    expect(expMs).toBeGreaterThanOrEqual(before + 4 * 60 * 1000 - 1000);
    expect(expMs).toBeLessThanOrEqual(after + 4 * 60 * 1000 + 1000);
  });

  test("signs and embeds opc-obo-token for instance_obo_user auth", async () => {
    const run = await runInProcess(
      [
        "--auth",
        "instance_obo_user",
        "--region",
        "us-phoenix-1",
        "--federation-endpoint",
        "{federation}",
        "ce",
        "cluster",
        "generate-token",
        "--cluster-id",
        "ocid1.cluster.oc1..obo-verify",
      ],
      {
        env: { OCI_METADATA_BASE_URL: "{metadata}" },
        config: "delegation_token_file=~/.oci/delegation_token\n",
        sandbox: {
          files: {
            ".oci/delegation_token": "  obo-jwt-token.payload.sig \n",
          },
        },
        instanceMetadata: true,
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.requests).toHaveLength(0);
    expect(run.sessionPublicKey).toBeTruthy();

    const { auth } = verifyExecCredentialToken(
      run.stdout,
      run.sessionPublicKey!,
      "https://containerengine.us-phoenix-1.oraclecloud.com/cluster_request/ocid1.cluster.oc1..obo-verify",
      { "opc-obo-token": "obo-jwt-token.payload.sig" },
    );
    expect(auth.headers).toBe("date (request-target) host opc-obo-token");
    expect(auth.keyId?.startsWith("ST$")).toBe(true);
  });

  test("matches Python urllib.parse.quote_plus and urlsafe_b64encode", () => {
    const url = buildPresignedTokenUrl(
      "https://containerengine.us-ashburn-1.oraclecloud.com/cluster_request/c1",
      [
        ["authorization", 'Signature headers="date (request-target) host"'],
        ["date", "Tue, 24 Nov 2026 10:40:00 GMT"],
        ["opc-obo-token", "a~b!c*d'e"],
      ],
    );
    expect(url).toBe(
      "https://containerengine.us-ashburn-1.oraclecloud.com/cluster_request/c1?authorization=Signature+headers%3D%22date+%28request-target%29+host%22&date=Tue%2C+24+Nov+2026+10%3A40%3A00+GMT&opc-obo-token=a~b%21c%2Ad%27e",
    );
    expect(urlsafeBase64Encode("?>>?")).toBe("Pz4-Pw==");
    expect(
      formatExpirationTimestamp(Date.UTC(2026, 10, 24, 10, 40, 0, 123)),
    ).toBe("2026-11-24T10:44:00.123000Z");
  });
});

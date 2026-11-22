import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegionsSpec } from "../../src/endpoint.ts";
import {
  ResourcePrincipalError,
  resolveResourcePrincipal,
} from "../../src/resource-principal.ts";
import { signRequest } from "../../src/signer.ts";
import { parseAuthorization, signatureValid } from "../harness/compare.ts";
import { startFakeMetadataService } from "../harness/fake-metadata.ts";
import { FAKE_KEY_PEM } from "../harness/sandbox.ts";

const REGIONS: RegionsSpec = {
  regions: ["us-ashburn-1", "us-phoenix-1", "us-langley-1"],
  shortNames: { iad: "us-ashburn-1", phx: "us-phoenix-1" },
  regionRealms: {
    "us-ashburn-1": "oc1",
    "us-phoenix-1": "oc1",
    "us-langley-1": "oc2",
  },
  realms: { oc1: "oraclecloud.com", oc2: "oraclegovcloud.com" },
  serviceEndpoints: {},
  domainFormat: "{service}.{region}.{secondLevelDomain}",
};

const FAKE_RPST =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjIwODQxMDAwMDAsImlhdCI6MjA4NDA5MDAwMH0.eA";
const FAKE_PUBLIC_KEY_PEM = createPublicKey(FAKE_KEY_PEM)
  .export({ type: "spki", format: "pem" })
  .toString();

function toPublicKeyPem(sanitized: string): string {
  const lines = sanitized.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

describe("resource principal auth", () => {
  test("v2.2 loads inline RPST and private key and resolves short region name", async () => {
    const creds = await resolveResourcePrincipal({
      env: {
        OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
        OCI_RESOURCE_PRINCIPAL_RPST: FAKE_RPST,
        OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: FAKE_KEY_PEM,
        OCI_RESOURCE_PRINCIPAL_REGION: "phx",
      },
      regions: REGIONS,
    });

    expect(creds.keyId).toBe(`ST$${FAKE_RPST}`);
    expect(creds.region).toBe("us-phoenix-1");

    const req = {
      method: "GET",
      url: "http://127.0.0.1:9999/20160918/instances?compartmentId=test",
      headers: {} as Record<string, string>,
      body: "",
    };
    signRequest(req, { keyId: creds.keyId, privateKey: creds.privateKey });
    expect(
      signatureValid(
        {
          method: "GET",
          path: "/20160918/instances",
          rawQuery: "compartmentId=test",
          query: [["compartmentId", "test"]],
          headers: req.headers,
          body: "",
        },
        FAKE_PUBLIC_KEY_PEM,
      ),
    ).toBe(true);
  });

  test("v2.2 reads RPST and private key from absolute file paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-rp-test-"));
    try {
      const rpstPath = join(dir, "rpst");
      const keyPath = join(dir, "key.pem");
      await Bun.write(rpstPath, FAKE_RPST);
      await Bun.write(keyPath, FAKE_KEY_PEM);

      const creds = await resolveResourcePrincipal({
        env: {
          OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
          OCI_RESOURCE_PRINCIPAL_RPST: rpstPath,
          OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: keyPath,
          OCI_RESOURCE_PRINCIPAL_REGION: "us-ashburn-1",
        },
        regions: REGIONS,
      });

      expect(creds.keyId).toBe(`ST$${FAKE_RPST}`);
      expect(creds.region).toBe("us-ashburn-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("v2.2 rejects missing RPST or private key", async () => {
    await expect(
      resolveResourcePrincipal({
        env: {
          OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
          OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: FAKE_KEY_PEM,
        },
        regions: REGIONS,
      }),
    ).rejects.toThrow(ResourcePrincipalError);

    await expect(
      resolveResourcePrincipal({
        env: {
          OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
          OCI_RESOURCE_PRINCIPAL_RPST: FAKE_RPST,
        },
        regions: REGIONS,
      }),
    ).rejects.toThrow(ResourcePrincipalError);
  });

  test("rejects missing or unsupported OCI_RESOURCE_PRINCIPAL_VERSION", async () => {
    await expect(
      resolveResourcePrincipal({ env: {}, regions: REGIONS }),
    ).rejects.toThrow("OCI_RESOURCE_PRINCIPAL_VERSION is not defined");

    await expect(
      resolveResourcePrincipal({
        env: { OCI_RESOURCE_PRINCIPAL_VERSION: "9.9" },
        regions: REGIONS,
      }),
    ).rejects.toThrow("Unsupported OCI_RESOURCE_PRINCIPAL_VERSION: 9.9");
  });

  test("v1.1 exchanges RPT + SPST for RPST using instance principal signer", async () => {
    using metadata = startFakeMetadataService({ region: "iad" });
    let capturedRptPath = "";
    let rpSessionPublicKey: string | undefined;
    const rpServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const headers = Object.fromEntries(req.headers);
        const body = await req.text();
        const auth = parseAuthorization(headers.authorization ?? "");
        expect(auth.scheme).toBe("Signature");
        expect(
          signatureValid(
            {
              method: req.method,
              path: url.pathname,
              rawQuery: url.search.slice(1),
              query: [...url.searchParams],
              headers,
              body,
            },
            metadata.sessionPublicKey!,
          ),
        ).toBe(true);

        if (req.method === "GET") {
          capturedRptPath = url.pathname;
          return Response.json({
            resourcePrincipalToken: "fake-rpt-blob",
            servicePrincipalSessionToken: "fake-spst-blob",
          });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/v1/resourcePrincipalSessionToken"
        ) {
          const parsed = JSON.parse(body) as {
            resourcePrincipalToken: string;
            servicePrincipalSessionToken: string;
            sessionPublicKey: string;
          };
          expect(parsed.resourcePrincipalToken).toBe("fake-rpt-blob");
          expect(parsed.servicePrincipalSessionToken).toBe("fake-spst-blob");
          rpSessionPublicKey = toPublicKeyPem(parsed.sessionPublicKey);
          return Response.json({ token: FAKE_RPST });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      const origin = `http://127.0.0.1:${rpServer.port}`;
      const creds = await resolveResourcePrincipal({
        env: {
          OCI_RESOURCE_PRINCIPAL_VERSION: "1.1",
          OCI_METADATA_BASE_URL: metadata.baseUrl,
          OCI_CLI_FEDERATION_ENDPOINT: metadata.federationEndpoint,
          OCI_RESOURCE_PRINCIPAL_RPT_ENDPOINT: origin,
          OCI_RESOURCE_PRINCIPAL_RPST_ENDPOINT: origin,
          OCI_RESOURCE_PRINCIPAL_RPT_ID: "ocid1.resource.oc1..test",
        },
        regions: REGIONS,
      });

      expect(capturedRptPath).toBe(
        "/20180711/resourcePrincipalToken/ocid1.resource.oc1..test",
      );
      expect(creds.keyId).toBe(`ST$${FAKE_RPST}`);
      expect(creds.region).toBe("us-ashburn-1");
      expect(rpSessionPublicKey).toBeDefined();

      const apiReq = {
        method: "GET",
        url: "http://127.0.0.1:9999/20160918/instances",
        headers: {} as Record<string, string>,
        body: "",
      };
      signRequest(apiReq, {
        keyId: creds.keyId,
        privateKey: creds.privateKey,
      });
      expect(
        signatureValid(
          {
            method: "GET",
            path: "/20160918/instances",
            rawQuery: "",
            query: [],
            headers: apiReq.headers,
            body: "",
          },
          rpSessionPublicKey!,
        ),
      ).toBe(true);
    } finally {
      rpServer.stop(true);
    }
  });
});

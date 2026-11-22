import { describe, expect, test } from "bun:test";
import type { RegionsSpec } from "../../src/endpoint.ts";
import {
  defaultFederationEndpoint,
  resolveInstancePrincipal,
} from "../../src/instance-principal.ts";
import { signRequest } from "../../src/signer.ts";
import { parseAuthorization, signatureValid } from "../harness/compare.ts";
import {
  DEFAULT_INSTANCE_TOKEN,
  startFakeMetadataService,
} from "../harness/fake-metadata.ts";

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

describe("instance principal auth", () => {
  test("fetches IMDS certs, signs federation request, and returns ST$ token with ephemeral key", async () => {
    using metadata = startFakeMetadataService({ region: "phx" });
    const creds = await resolveInstancePrincipal({
      env: { OCI_METADATA_BASE_URL: metadata.baseUrl },
      regions: REGIONS,
      federationEndpoint: metadata.federationEndpoint,
      authPurpose: "service_principal",
    });

    expect(creds.keyId).toBe(`ST$${DEFAULT_INSTANCE_TOKEN}`);
    expect(creds.region).toBe("us-phoenix-1");
    expect(metadata.sessionPublicKey).toBeDefined();

    // Every IMDS request carried Authorization: Bearer Oracle.
    expect(metadata.metadataRequests.length).toBe(4);
    for (const r of metadata.metadataRequests) {
      expect(r.headers.authorization).toBe("Bearer Oracle");
    }

    // Federation request used fed-x509 keyId and omitted `host` from signed headers.
    expect(metadata.federationRequests.length).toBe(1);
    const fedReq = metadata.federationRequests[0]!;
    const auth = parseAuthorization(fedReq.headers.authorization ?? "");
    expect(auth.scheme).toBe("Signature");
    expect(auth.headers).toBe(
      "date (request-target) content-length content-type x-content-sha256",
    );
    expect(auth.keyId).toMatch(
      /^ocid1\.tenancy\.oc1\.\.aaaaaaaabocifaketenancy\/fed-x509\/([0-9A-F]{2}:){19}[0-9A-F]{2}$/,
    );
    const fedBody = JSON.parse(fedReq.body) as {
      certificate: string;
      publicKey: string;
      intermediateCertificates: string[];
      purpose?: string;
    };
    expect(fedBody.certificate).not.toContain("BEGIN CERTIFICATE");
    expect(fedBody.publicKey).not.toContain("BEGIN PUBLIC KEY");
    expect(fedBody.intermediateCertificates).toHaveLength(1);
    expect(fedBody.purpose).toBe("SERVICE_PRINCIPAL");

    // Signing an API request with the returned ephemeral key verifies against the submitted public key.
    const apiReq = {
      method: "GET",
      url: "http://127.0.0.1:9999/20160918/instances?compartmentId=test",
      headers: {} as Record<string, string>,
      body: "",
    };
    signRequest(apiReq, { keyId: creds.keyId, privateKey: creds.privateKey });
    expect(
      signatureValid(
        {
          method: "GET",
          path: "/20160918/instances",
          rawQuery: "compartmentId=test",
          query: [["compartmentId", "test"]],
          headers: apiReq.headers,
          body: "",
        },
        metadata.sessionPublicKey!,
      ),
    ).toBe(true);
  });

  test("derives default federation endpoint from region and realm", () => {
    expect(defaultFederationEndpoint("us-phoenix-1", REGIONS)).toBe(
      "https://auth.us-phoenix-1.oraclecloud.com/v1/x509",
    );
    expect(defaultFederationEndpoint("us-langley-1", REGIONS)).toBe(
      "https://auth.us-langley-1.oraclegovcloud.com/v1/x509",
    );
  });

  test("fails when IMDS returns an error", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    try {
      await expect(
        resolveInstancePrincipal({
          env: {
            OCI_METADATA_BASE_URL: `http://127.0.0.1:${server.port}/opc/v2`,
          },
          regions: REGIONS,
        }),
      ).rejects.toThrow("IMDS request failed (500)");
    } finally {
      server.stop(true);
    }
  });
});

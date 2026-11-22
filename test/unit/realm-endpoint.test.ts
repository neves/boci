import { expect, test } from "bun:test";
import { resolveEndpoint, type RegionsSpec } from "../../src/core/endpoint.ts";

const regions: RegionsSpec = {
  regions: ["us-ashburn-1"],
  shortNames: {},
  regionRealms: { "us-ashburn-1": "oc1" },
  realms: { oc1: "oraclecloud.com" },
  serviceEndpoints: {},
  domainFormat: "{region}.{secondLevelDomain}",
};

const client = {
  endpointTemplate: "https://objectstorage.{region}.{secondLevelDomain}",
  endpointTemplatePerRealm: {
    oc1: "https://{namespaceName+Dot}objectstorage.{region}.oraclecloud.com",
  },
  serviceName: "object_storage",
};

const options = {
  region: "us-ashburn-1",
  realmSpecific: true,
  dualStack: false,
};

test("inserts a dotted service parameter into a realm-specific endpoint", () => {
  expect(
    resolveEndpoint(client, regions, {
      ...options,
      serviceParams: { namespaceName: "tenant" },
    }).resolved,
  ).toBe("https://tenant.objectstorage.us-ashburn-1.oraclecloud.com");
});

test("removes the optional dotted service parameter when it is absent", () => {
  expect(resolveEndpoint(client, regions, options).resolved).toBe(
    "https://objectstorage.us-ashburn-1.oraclecloud.com",
  );
});

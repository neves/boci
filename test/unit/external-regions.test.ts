import { expect, test } from "bun:test";
import { createSandbox } from "../harness/sandbox.ts";
import {
  loadExternalRegionMetadata,
  resolveEndpoint,
  type RegionsSpec,
} from "../../src/endpoint.ts";

const regions: RegionsSpec = {
  regions: ["known-region"],
  shortNames: {},
  regionRealms: {},
  realms: { oc1: "oraclecloud.com" },
  serviceEndpoints: {},
  domainFormat: "{region}.{secondLevelDomain}",
};

const metadata = (domain: string, region = "custom-region-1") => ({
  realmKey: "OC9",
  realmDomainComponent: domain,
  regionKey: "CST",
  regionIdentifier: region,
});

test("loads an unknown region from regions-config.json before the environment", async () => {
  await using sandbox = await createSandbox("", {
    files: {
      ".oci/regions-config.json": JSON.stringify([metadata("file.example")]),
    },
  });
  const env = {
    ...sandbox.env,
    OCI_REGION_METADATA: JSON.stringify(metadata("env.example")),
  };

  const regionMetadata = await loadExternalRegionMetadata(
    "custom-region-1",
    regions,
    env,
  );
  expect(regionMetadata).toEqual({
    realmKey: "oc9",
    realmDomainComponent: "file.example",
    regionKey: "cst",
    regionIdentifier: "custom-region-1",
  });
  expect(
    resolveEndpoint(
      {
        serviceName: "object_storage",
        endpointTemplate: "https://objectstorage.{region}.{secondLevelDomain}",
      },
      regions,
      {
        region: "custom-region-1",
        realmSpecific: false,
        dualStack: false,
        env,
        regionMetadata,
      },
    ).resolved,
  ).toBe("https://objectstorage.custom-region-1.file.example");
});

test("falls back to OCI_REGION_METADATA when the file has no matching region", async () => {
  await using sandbox = await createSandbox("", {
    files: {
      ".oci/regions-config.json": JSON.stringify([
        metadata("file.example", "another-region"),
      ]),
    },
  });
  const env = {
    ...sandbox.env,
    OCI_REGION_METADATA: JSON.stringify(metadata("env.example")),
  };

  expect(
    await loadExternalRegionMetadata("custom-region-1", regions, env),
  ).toEqual({
    realmKey: "oc9",
    realmDomainComponent: "env.example",
    regionKey: "cst",
    regionIdentifier: "custom-region-1",
  });
});

test("does not let external metadata replace a built-in region", async () => {
  await using sandbox = await createSandbox("", {
    files: {
      ".oci/regions-config.json": JSON.stringify([
        metadata("wrong.example", "known-region"),
      ]),
    },
  });

  expect(
    await loadExternalRegionMetadata("known-region", regions, sandbox.env),
  ).toBeUndefined();
});

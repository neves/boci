import { expect, test } from "bun:test";
import {
  type ClientInfo,
  MissingEndpointForNonRegionalServiceClient,
  resolveEndpoint,
} from "../../src/endpoint.ts";

type Case = {
  client: string;
  region: string;
  endpoint: string | null;
  realmSpecific: boolean;
  dualStack: boolean;
  stored?: string;
  resolved?: string;
  error?: { type: string };
};
const root = `${import.meta.dir}/../..`;
const cases = (await Bun.file(
  `${root}/test/fixtures/endpoints.json`,
).json()) as Case[];
const index = await Bun.file(`${root}/spec/index.json`).json();
const clients: Record<string, ClientInfo> = {};
for await (const f of new Bun.Glob("*.json").scan(`${root}/spec`)) {
  if (f === "index.json") continue;
  Object.assign(
    clients,
    (await Bun.file(`${root}/spec/${f}`).json()).clients ?? {},
  );
}

// Generated from real SDK clients by tools/extract/endpoint_fixtures.py.
test("endpoints match the SDK for every client, region form and flag combination", () => {
  for (const c of cases) {
    const client = clients[c.client] as ClientInfo;
    const opts = {
      region: c.region,
      endpoint: c.endpoint,
      realmSpecific: c.realmSpecific,
      dualStack: c.dualStack,
      env: {},
    };
    const label = {
      client: c.client,
      region: c.region,
      endpoint: c.endpoint,
      realmSpecific: c.realmSpecific,
      dualStack: c.dualStack,
    };
    if (c.error) {
      expect(() => resolveEndpoint(client, index.regions, opts)).toThrow(
        MissingEndpointForNonRegionalServiceClient,
      );
      continue;
    }
    expect({
      ...label,
      ...resolveEndpoint(client, index.regions, opts),
    }).toEqual({
      ...label,
      stored: c.stored as string,
      resolved: c.resolved as string,
    });
  }
});

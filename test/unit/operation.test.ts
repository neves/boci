// callOperation against a local fake endpoint: retries and --all pagination, which the
// Parity cases only pin through rendered output.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegionsSpec } from "../../src/endpoint.ts";
import { Exit, type Invocation } from "../../src/io.ts";
import {
  type GeneratedCommand,
  type OperationCall,
  callOperation,
} from "../../src/operation.ts";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "boci-operation-"));
  const key = join(import.meta.dir, "../fixtures/fake_oci_api_key.pem");
  writeFileSync(
    join(dir, "config"),
    `[DEFAULT]\nuser=u\nfingerprint=f\ntenancy=t\nregion=us-ashburn-1\nkey_file=${key}\n`,
  );
});

// Retry backoff sleeps 1-2 s per attempt; the tests only care that it retries.
const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
afterEach(() => sleep.mockClear());
afterAll(() => sleep.mockRestore());

function invocation() {
  const err: string[] = [];
  const io: Invocation = {
    argv: [],
    env: { OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True" },
    cwd: dir,
    out: () => {},
    err: (t) => err.push(t),
    isTTY: () => false,
    columns: () => undefined,
  };
  return { io, err };
}

const listThings = {
  kind: "generated",
  operation: {
    client: "things",
    method: "list_things",
    http: "GET",
    path: "/things",
    responseType: "list[Thing]",
    queryParams: { compartmentId: { arg: "compartment_id" } },
  },
} as unknown as GeneratedCommand;

function call(
  endpoint: string,
  values: Record<string, unknown>,
  rootValues: Record<string, unknown> = {},
  command = listThings,
): OperationCall {
  return {
    command,
    values,
    rootValues: { endpoint, ...rootValues },
    settings: { configFile: join(dir, "config"), profile: "DEFAULT" },
    spec: { clients: { things: { basePath: "/v1" } } },
    index: { regions: {} as RegionsSpec },
  };
}

test("retries 5xx and 429 until a success, re-signing each attempt", async () => {
  using fake = startFakeEndpoint([
    { status: 503 },
    { status: 429 },
    { status: 200, body: { items: [] } },
  ]);
  const { io } = invocation();
  const result = await callOperation(
    io,
    call(fake.url, { compartment_id: "c1" }),
  );
  expect(result.response.status).toBe(200);
  expect(fake.requests).toHaveLength(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(fake.requests[0]?.path).toBe("/v1/things");
  expect(fake.requests[0]?.rawQuery).toBe("compartmentId=c1");
  expect(fake.requests[0]?.headers["opc-client-retries"]).toBe("true");
  expect(fake.requests[2]?.headers.authorization).toContain('keyId="t/u/f"');
});

test("--max-retries caps attempts and --no-retry sends once", async () => {
  using fake = startFakeEndpoint({ status: 500 });
  const { io } = invocation();
  const capped = await callOperation(
    io,
    call(fake.url, {}, { max_retries: 2 }),
  );
  expect(capped.response.status).toBe(500);
  expect(fake.requests).toHaveLength(2);
  const once = await callOperation(io, call(fake.url, {}, { no_retry: true }));
  expect(once.response.status).toBe(500);
  expect(fake.requests).toHaveLength(3);
  expect(fake.requests[2]?.headers["opc-client-retries"]).toBeUndefined();
});

test("does not retry a 409 other than IncorrectState/LockConflict", async () => {
  using fake = startFakeEndpoint({ status: 409, body: { code: "Conflict" } });
  const { io } = invocation();
  await callOperation(io, call(fake.url, {}));
  expect(fake.requests).toHaveLength(1);
});

test("--all follows opc-next-page and gathers every page's items", async () => {
  using fake = startFakeEndpoint([
    { headers: { "opc-next-page": "p2" }, body: { items: [{ id: 1 }] } },
    { headers: { "opc-next-page": "p3" }, body: { items: [{ id: 2 }] } },
    { body: { items: [{ id: 3 }] } },
  ]);
  const { io } = invocation();
  const result = await callOperation(
    io,
    call(fake.url, { all_pages: true, page_size: 1 }),
  );
  expect(result.allPages).toBe(true);
  expect(result.pageItems).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(fake.requests.map((r) => r.rawQuery)).toEqual([
    "limit=1",
    "limit=1&page=p2",
    "limit=1&page=p3",
  ]);
  expect(result.url.toString()).toBe(`${fake.url}/v1/things?limit=1`);
});

test("without --all only the first page is fetched", async () => {
  using fake = startFakeEndpoint({
    headers: { "opc-next-page": "p2" },
    body: { items: [{ id: 1 }] },
  });
  const { io } = invocation();
  const result = await callOperation(io, call(fake.url, {}));
  expect(fake.requests).toHaveLength(1);
  expect(result.pageItems).toEqual([]);
  expect(result.response.headers.get("opc-next-page")).toBe("p2");
});

test("--all with --limit is a usage error before any request", async () => {
  using fake = startFakeEndpoint();
  const { io, err } = invocation();
  const thrown = await callOperation(
    io,
    call(fake.url, { all_pages: true, limit: 5 }),
  ).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Exit);
  expect((thrown as Exit).code).toBe(1);
  expect(err.join("")).toContain("--all option you cannot provide the --limit");
  expect(fake.requests).toHaveLength(0);
});

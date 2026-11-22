// callOperation against a local fake endpoint: retries and --all pagination, which the
// Parity cases only pin through rendered output.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegionsSpec } from "../../src/core/endpoint.ts";
import { fetchWithConnectionTimeout } from "../../src/core/connection-timeout.ts";
import { Exit, type Invocation } from "../../src/lib/io.ts";
import {
  type GeneratedCommand,
  type OperationCall,
  callOperation,
} from "../../src/core/operation.ts";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";
import { startFakeHttpsProxy } from "../harness/fake-https-proxy.ts";

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

test("generated PUT signs Python-compatible JSON bytes for nested Unicode bodies", async () => {
  using fake = startFakeEndpoint();
  const { io } = invocation();
  const command = {
    kind: "generated",
    operation: {
      client: "things",
      method: "update_thing",
      http: "PUT",
      path: "/things",
    },
    bindings: [{ target: "body", key: ["payload"], param: "payload" }],
  } as unknown as GeneratedCommand;
  const payload = { items: [1, true, null], label: "é" };
  await callOperation(io, call(fake.url, { payload }, {}, command));

  const request = fake.requests[0]!;
  const expectedBody =
    '{"payload": {"items": [1, true, null], "label": "\\u00e9"}}';
  expect(request.body).toBe(expectedBody);
  expect(request.headers["content-length"]).toBe(String(expectedBody.length));
  expect(request.headers["x-content-sha256"]).toBe(
    new Bun.CryptoHasher("sha256").update(expectedBody).digest("base64"),
  );
});

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
    settings: {
      configFile: join(dir, "config"),
      profile: "DEFAULT",
      auth: null,
    },
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

test("connection timeout ends a stalled TLS handshake on the request socket", async () => {
  let connections = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections++;
      },
      data() {},
    },
  });
  try {
    const { io, err } = invocation();
    const endpoint = `https://127.0.0.1:${listener.port}`;
    await expect(
      callOperation(
        io,
        call(
          endpoint,
          {},
          {
            connection_timeout: 0.15,
            read_timeout: 0.05,
            no_retry: true,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(Exit);
    expect(connections).toBe(1);
    expect(err.join("")).toContain("RequestException:");
    expect(err.join("")).toContain("The request timed out.");
  } finally {
    listener.stop(true);
  }
});

test("connection timeout allows delayed response headers through a trusted TLS proxy", async () => {
  sleep.mockImplementationOnce(
    (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms))),
  );
  using proxy = await startFakeHttpsProxy({
    delayMs: 350,
    body: { items: [] },
  });
  const { io } = invocation();
  io.env.HTTPS_PROXY = proxy.proxyUrl;
  io.env.REQUESTS_CA_BUNDLE = proxy.caCertPath;
  const result = await callOperation(
    io,
    call(
      "https://auth.custom.example.com",
      {},
      {
        connection_timeout: 0.2,
        no_retry: true,
      },
    ),
  );
  expect(result.response.status).toBe(200);
  expect(proxy.requests.map((request) => request.path)).toEqual(["/v1/things"]);
});

test("connection timeout preserves redirected request bytes and compressed downloads", async () => {
  const requests: {
    method: string;
    body: string;
    authorization: string | null;
  }[] = [];
  const bytes = Bun.gzipSync("object bytes");
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        method: req.method,
        body: await req.text(),
        authorization: req.headers.get("authorization"),
      });
      return new Response(bytes, { headers: { "content-encoding": "gzip" } });
    },
  });
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(target.url.href, 307);
    },
  });
  try {
    const { io } = invocation();
    for (const decompress of [true, false]) {
      const response = await fetchWithConnectionTimeout(
        io,
        redirect.url,
        {
          method: "PUT",
          headers: { authorization: "test-credential" },
          body: "signed bytes",
        },
        1000,
        new AbortController().signal,
        decompress,
      );
      if (decompress) expect(await response.text()).toBe("object bytes");
      else expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    expect(requests).toEqual(
      Array(2).fill({
        method: "PUT",
        body: "signed bytes",
        authorization: null,
      }),
    );
  } finally {
    redirect.stop(true);
    target.stop(true);
  }
});

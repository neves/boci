import { expect, test } from "bun:test";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";

test("records method, raw path, ordered query, headers and body", async () => {
  using fake = startFakeEndpoint();
  await fetch(`${fake.url}/n/ns/b?compartmentId=c1&fields=a%2Cb&fields=x`, {
    method: "POST",
    headers: { "X-Custom": "1", "content-type": "application/json" },
    body: '{"name":"b"}',
  });
  expect(fake.requests).toHaveLength(1);
  const req = fake.requests[0];
  expect(req?.method).toBe("POST");
  expect(req?.path).toBe("/n/ns/b");
  expect(req?.rawQuery).toBe("compartmentId=c1&fields=a%2Cb&fields=x");
  expect(req?.query).toEqual([
    ["compartmentId", "c1"],
    ["fields", "a,b"],
    ["fields", "x"],
  ]);
  expect(req?.headers["x-custom"]).toBe("1");
  expect(req?.body).toBe('{"name":"b"}');
});

test("serves the canned reply, defaulting to 200 {}", async () => {
  using fake = startFakeEndpoint();
  const res = await fetch(`${fake.url}/anything`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("serves replies in order and repeats the last one", async () => {
  using fake = startFakeEndpoint([
    { status: 200, headers: { "opc-next-page": "2" }, body: [1] },
    { status: 404, body: { code: "NotFound", message: "gone" } },
  ]);
  const a = await fetch(fake.url);
  expect(a.headers.get("opc-next-page")).toBe("2");
  expect(await a.json()).toEqual([1]);
  expect((await fetch(fake.url)).status).toBe(404);
  expect((await fetch(fake.url)).status).toBe(404);
});

test("string bodies are sent verbatim", async () => {
  using fake = startFakeEndpoint({
    body: "raw-bytes",
    headers: { "content-type": "text/plain" },
  });
  expect(await (await fetch(fake.url)).text()).toBe("raw-bytes");
});

test("percent-encoding in the path is preserved", async () => {
  using fake = startFakeEndpoint();
  await fetch(`${fake.url}/n/ns/b/bk/o/dir%2Ffile%20name.txt`);
  expect(fake.requests[0]?.path).toBe("/n/ns/b/bk/o/dir%2Ffile%20name.txt");
});

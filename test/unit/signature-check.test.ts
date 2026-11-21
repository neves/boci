import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { signatureValid } from "../harness/compare.ts";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";
import {
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "../../src/signer.ts";

const pem = await Bun.file(
  `${import.meta.dir}/../fixtures/fake_oci_api_key.pem`,
).text();
const publicKey = createPublicKey(pem)
  .export({ type: "spki", format: "pem" })
  .toString();
const key = { keyId: "t/u/f", privateKey: loadPrivateKey(pem) };

test("the harness verifies signatures of requests as captured on the wire", async () => {
  using fake = startFakeEndpoint();
  const url = `${fake.url}/n/ns/b?compartmentId=c&fields=tags`;
  const req = {
    method: "POST",
    url,
    headers: {} as Record<string, string>,
    body: '{"a": 1}',
  };
  prepareContentLength(req);
  signRequest(req, key);
  await fetch(url, { method: "POST", headers: req.headers, body: req.body });
  const captured = fake.requests[0];
  expect(captured && signatureValid(captured, publicKey)).toBe(true);
  if (captured) captured.headers.date = "Sun, 01 Jan 2023 00:00:00 GMT";
  expect(captured && signatureValid(captured, publicKey)).toBe(false);
});

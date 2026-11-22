import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import {
  InvalidPrivateKey,
  MissingPrivateKeyPassphrase,
  loadPrivateKey,
  prepareContentLength,
  signRequest,
} from "../../src/core/signer.ts";

type Case = {
  method: string;
  url: string;
  body: string | null;
  enforceContentHeaders: boolean;
  headers: Record<string, string>;
};
const cases = (await Bun.file(
  `${import.meta.dir}/../fixtures/signer.json`,
).json()) as Case[];
const key = {
  keyId: "ocid1.tenancy.oc1..t/ocid1.user.oc1..u/aa:bb:cc",
  privateKey: loadPrivateKey(
    await Bun.file(
      `${import.meta.dir}/../fixtures/fake_oci_api_key.pem`,
    ).text(),
  ),
};

// Generated with oci.signer.Signer by tools/extract/signer_fixtures.py (same key, fixed date).
test("signatures and injected headers match the OCI SDK byte for byte", () => {
  for (const c of cases) {
    const headers: Record<string, string> = {
      date: c.headers.date as string,
      accept: "application/json",
    };
    const req = { method: c.method, url: c.url, headers, body: c.body };
    prepareContentLength(req);
    signRequest(req, key, c.enforceContentHeaders);
    const got = Object.fromEntries(
      Object.keys(c.headers).map((k) => [k, headers[k]]),
    );
    expect({ method: c.method, url: c.url, headers: got }).toEqual({
      method: c.method,
      url: c.url,
      headers: c.headers,
    });
    for (const k of ["content-length", "x-content-sha256"]) {
      if (!(k in c.headers))
        expect(
          headers[k],
          `${c.method} ${c.url} must not set ${k}`,
        ).toBeUndefined();
    }
  }
});

test("a key that isn't a private key is rejected with oci's message", () => {
  expect(() => loadPrivateKey("not a key")).toThrow(
    "The provided key is not a private key, or the provided passphrase is incorrect.",
  );
});

test("encrypted private keys handle passphrase, missing passphrase, wrong passphrase, empty passphrase, and public keys", () => {
  const encPkcs8 = `${key.privateKey
    .export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "secret",
    })
    .toString()}OCI_API_KEY\n`;
  const encPkcs1 = `${key.privateKey
    .export({
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "secret",
    })
    .toString()}OCI_API_KEY\n`;

  for (const pem of [encPkcs8, encPkcs1]) {
    expect(loadPrivateKey(pem, "secret").asymmetricKeyType).toBe("rsa");
    expect(() => loadPrivateKey(pem, null)).toThrow(
      MissingPrivateKeyPassphrase,
    );
    expect(() => loadPrivateKey(pem, "wrong")).toThrow(InvalidPrivateKey);
    expect(() => loadPrivateKey(pem, "")).toThrow(TypeError);
  }

  const pubPem = createPublicKey(key.privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  expect(() => loadPrivateKey(pubPem)).toThrow(
    "Authentication requires a private key, but a public key was provided.",
  );
});

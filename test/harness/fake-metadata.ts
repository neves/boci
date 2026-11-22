// Local stand-in for OCI Instance Metadata Service (IMDS v2) and X.509 Federation
// endpoint, used by `--auth instance_principal` parity and unit tests.
import { createPublicKey } from "node:crypto";
import { join } from "node:path";
import { signatureValid } from "./compare.ts";
import type { CapturedRequest } from "./fake-endpoint.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const LEAF_CERT_PEM = await Bun.file(
  join(FIXTURES, "fake_instance_cert.pem"),
).text();
const LEAF_KEY_PEM = await Bun.file(
  join(FIXTURES, "fake_oci_api_key.pem"),
).text();
const LEAF_PUBLIC_KEY_PEM = createPublicKey(LEAF_KEY_PEM)
  .export({ type: "spki", format: "pem" })
  .toString();

export const DEFAULT_INSTANCE_TOKEN =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjIwODQxMDAwMDAsImlhdCI6MjA4NDA5MDAwMH0.eA";

export type MetadataServiceOptions = {
  region?: string;
  token?: string;
};

export type FakeMetadataService = {
  /** Base URL for OCI_METADATA_BASE_URL, e.g. http://127.0.0.1:<port>/opc/v2 */
  baseUrl: string;
  /** Full URL for --federation-endpoint, e.g. http://127.0.0.1:<port>/v1/x509 */
  federationEndpoint: string;
  /** Ephemeral session public key (SPKI PEM) submitted to /v1/x509, once received. */
  get sessionPublicKey(): string | undefined;
  metadataRequests: CapturedRequest[];
  federationRequests: CapturedRequest[];
  [Symbol.dispose](): void;
};

function toPublicKeyPem(sanitized: string): string {
  const lines = sanitized.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

export function startFakeMetadataService(
  opts: MetadataServiceOptions = {},
): FakeMetadataService {
  const region = opts.region ?? "us-ashburn-1";
  const token = opts.token ?? DEFAULT_INSTANCE_TOKEN;
  const metadataRequests: CapturedRequest[] = [];
  const federationRequests: CapturedRequest[] = [];
  let sessionPublicKey: string | undefined;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = req.url.slice(
        req.url.indexOf("/", req.url.indexOf("//") + 2),
      );
      const q = raw.indexOf("?");
      const path = q === -1 ? raw : raw.slice(0, q);
      const rawQuery = q === -1 ? "" : raw.slice(q + 1);
      const captured: CapturedRequest = {
        method: req.method,
        path,
        rawQuery,
        query: [...new URLSearchParams(rawQuery)],
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      };

      if (path.startsWith("/opc/v2/")) {
        metadataRequests.push(captured);
        if (req.headers.get("authorization") !== "Bearer Oracle") {
          return new Response("Missing Authorization: Bearer Oracle", {
            status: 401,
          });
        }
        if (path === "/opc/v2/identity/cert.pem")
          return new Response(LEAF_CERT_PEM, {
            headers: { "content-type": "text/plain" },
          });
        if (path === "/opc/v2/identity/key.pem")
          return new Response(LEAF_KEY_PEM, {
            headers: { "content-type": "text/plain" },
          });
        if (path === "/opc/v2/identity/intermediate.pem")
          return new Response(LEAF_CERT_PEM, {
            headers: { "content-type": "text/plain" },
          });
        if (path === "/opc/v2/instance/region")
          return new Response(region, {
            headers: { "content-type": "text/plain" },
          });
        return new Response("Not Found", { status: 404 });
      }

      if (path === "/v1/x509" && req.method === "POST") {
        federationRequests.push(captured);
        if (!signatureValid(captured, LEAF_PUBLIC_KEY_PEM)) {
          return Response.json(
            {
              code: "NotAuthenticated",
              message: "Invalid federation signature",
            },
            { status: 401 },
          );
        }
        const payload = JSON.parse(captured.body) as {
          certificate?: string;
          publicKey?: string;
          intermediateCertificates?: string[];
        };
        if (!payload.certificate || !payload.publicKey) {
          return Response.json(
            {
              code: "InvalidParameter",
              message: "Missing certificate or publicKey",
            },
            { status: 400 },
          );
        }
        sessionPublicKey = toPublicKeyPem(payload.publicKey);
        return Response.json({ token });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl: `${origin}/opc/v2`,
    federationEndpoint: `${origin}/v1/x509`,
    get sessionPublicKey() {
      return sessionPublicKey;
    },
    metadataRequests,
    federationRequests,
    [Symbol.dispose]() {
      server.stop(true);
    },
  };
}

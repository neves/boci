// OCI Instance Principals authentication (oci.auth.signers.InstancePrincipalsSecurityTokenSigner
// + oci.auth.federation_client.X509FederationClient): fetch leaf/intermediate certs, private
// key and region from IMDS v2, generate an ephemeral RSA-2048 session key pair, exchange the
// leaf cert for a security token at the X.509 federation endpoint, and return ST$<token> + key.
import {
  X509Certificate,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { RegionsSpec } from "./endpoint.ts";
import type { Env } from "../lib/io.ts";
import { loadPrivateKey, prepareContentLength, signRequest } from "./signer.ts";

const DEFAULT_METADATA_URL_BASE = "http://169.254.169.254/opc/v2";
const DEFAULT_METADATA_URL_BASE_IPV6 = "http://[fd00:c1::a9fe:a9fe]/opc/v2";
const METADATA_AUTH_HEADERS = { Authorization: "Bearer Oracle" } as const;
const FEDERATION_GENERIC_HEADERS = ["date", "(request-target)"] as const;

export type InstancePrincipalCredentials = {
  keyId: string;
  privateKey: KeyObject;
  region: string;
};

export type InstancePrincipalOptions = {
  env: Env;
  regions: RegionsSpec;
  federationEndpoint?: string;
  authPurpose?: string;
};

export class InstancePrincipalError extends Error {}

export function sanitizePem(pem: string): string {
  return pem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\r?\n/g, "");
}

export function extractTenancyId(cert: X509Certificate): string {
  for (const line of cert.subject.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const val = line.slice(eq + 1);
    if (val.startsWith("opc-tenant:")) return val.slice("opc-tenant:".length);
    if (val.startsWith("opc-identity:"))
      return val.slice("opc-identity:".length);
  }
  throw new InstancePrincipalError(
    "The certificate does not contain a tenancy OCID",
  );
}

export function defaultFederationEndpoint(
  region: string,
  regions: RegionsSpec,
): string {
  const realm = regions.regionRealms[region] ?? "oc1";
  const domain = regions.realms[realm] ?? "oraclecloud.com";
  return `https://auth.${region}.${domain}/v1/x509`;
}

async function fetchImdsText(url: string): Promise<string> {
  const res = await fetch(url, { headers: METADATA_AUTH_HEADERS });
  if (!res.ok) {
    throw new InstancePrincipalError(
      `IMDS request failed (${res.status}) for ${url}`,
    );
  }
  return await res.text();
}

function metadataBaseCandidates(env: Env): string[] {
  const override = env.OCI_METADATA_BASE_URL?.trim();
  if (override) return [override.replace(/\/+$/, "")];
  return [DEFAULT_METADATA_URL_BASE, DEFAULT_METADATA_URL_BASE_IPV6];
}

async function fetchMetadataBundle(env: Env): Promise<{
  leafCertPem: string;
  leafKeyPem: string;
  intermediateCertPem: string;
  regionRaw: string;
}> {
  const candidates = metadataBaseCandidates(env);
  let lastError: unknown;
  for (const base of candidates) {
    try {
      const [leafCertPem, leafKeyPem, intermediateCertPem, regionRaw] =
        await Promise.all([
          fetchImdsText(`${base}/identity/cert.pem`),
          fetchImdsText(`${base}/identity/key.pem`),
          fetchImdsText(`${base}/identity/intermediate.pem`),
          fetchImdsText(`${base}/instance/region`),
        ]);
      return { leafCertPem, leafKeyPem, intermediateCertPem, regionRaw };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function resolveInstancePrincipal(
  opts: InstancePrincipalOptions,
): Promise<InstancePrincipalCredentials> {
  const { leafCertPem, leafKeyPem, intermediateCertPem, regionRaw } =
    await fetchMetadataBundle(opts.env);

  const cert = new X509Certificate(leafCertPem);
  const tenancyId = extractTenancyId(cert);
  const fingerprint = cert.fingerprint;
  const leafPrivateKey = loadPrivateKey(leafKeyPem);

  const normalizedRegion = regionRaw.trim().toLowerCase();
  const region = opts.regions.shortNames[normalizedRegion] ?? normalizedRegion;

  const explicitFederation =
    opts.federationEndpoint?.trim() ||
    opts.env.OCI_CLI_FEDERATION_ENDPOINT?.trim();
  const federationEndpoint =
    explicitFederation || defaultFederationEndpoint(region, opts.regions);

  const { publicKey, privateKey: sessionPrivateKey } = generateKeyPairSync(
    "rsa",
    { modulusLength: 2048, publicExponent: 0x10001 },
  );
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const payload: Record<string, unknown> = {
    certificate: sanitizePem(leafCertPem),
    publicKey: sanitizePem(publicKeyPem),
    intermediateCertificates: [sanitizePem(intermediateCertPem)],
  };
  if (opts.authPurpose) {
    payload.purpose = opts.authPurpose.toUpperCase();
  }

  const fedReq = {
    method: "POST",
    url: federationEndpoint,
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify(payload),
  };
  prepareContentLength(fedReq);
  signRequest(
    fedReq,
    {
      keyId: `${tenancyId}/fed-x509/${fingerprint}`,
      privateKey: leafPrivateKey,
    },
    true,
    FEDERATION_GENERIC_HEADERS,
  );

  const fedRes = await fetch(fedReq.url, {
    method: fedReq.method,
    headers: fedReq.headers,
    body: fedReq.body,
  });
  const fedText = await fedRes.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fedText) as Record<string, unknown>;
  } catch {
    throw new InstancePrincipalError(
      `Unable to parse response from auth service (${federationEndpoint}): ${fedText}`,
    );
  }
  if (!fedRes.ok) {
    throw new InstancePrincipalError(
      `Federation request failed (${fedRes.status}): ${String(parsed.message ?? fedText)}`,
    );
  }
  if (typeof parsed.token !== "string" || !parsed.token) {
    throw new InstancePrincipalError(
      `Could not find token in response from auth service (${federationEndpoint})`,
    );
  }

  return {
    keyId: `ST$${parsed.token}`,
    privateKey: sessionPrivateKey,
    region,
  };
}

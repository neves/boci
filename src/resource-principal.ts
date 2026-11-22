// OCI Resource Principals authentication (oci.auth.signers.resource_principals_signer):
// - v2.2 (EphemeralResourcePrincipalSigner): reads RPST and PEM private key from env
//   (inline strings or absolute file paths, optional passphrase, optional region).
// - v1.1 (ResourcePrincipalsFederationSigner): uses Instance Principals auth to fetch
//   RPT + SPST from OCI_RESOURCE_PRINCIPAL_RPT_ENDPOINT, then exchanges them for an
//   RPST with an ephemeral RSA-2048 session key at OCI_RESOURCE_PRINCIPAL_RPST_ENDPOINT.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RegionsSpec } from "./endpoint.ts";
import { resolveInstancePrincipal, sanitizePem } from "./instance-principal.ts";
import type { Env } from "./io.ts";
import { loadPrivateKey, prepareContentLength, signRequest } from "./signer.ts";

const DEFAULT_METADATA_URL_BASE = "http://169.254.169.254/opc/v2";
const DEFAULT_METADATA_URL_BASE_IPV6 = "http://[fd00:c1::a9fe:a9fe]/opc/v2";
const METADATA_AUTH_HEADERS = { Authorization: "Bearer Oracle" } as const;
const DEFAULT_RPT_PATH_TEMPLATE = "/20180711/resourcePrincipalToken/{id}";
const RP_DEBUG_HINT =
  "Resource principals authentication can only be used in certain OCI services. Please check that the OCI service you're running this code from supports Resource principals.";

export type ResourcePrincipalCredentials = {
  keyId: string;
  privateKey: KeyObject;
  region?: string;
};

export type ResourcePrincipalOptions = {
  env: Env;
  regions: RegionsSpec;
};

export class ResourcePrincipalError extends Error {}

function resolveRegion(
  regionRaw: string | undefined,
  regions: RegionsSpec,
): string | undefined {
  if (!regionRaw) return undefined;
  const trimmed = regionRaw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return regions.shortNames[trimmed] ?? regions.shortNames[lower] ?? trimmed;
}

function defaultAuthEndpoint(region: string, regions: RegionsSpec): string {
  const realm = regions.regionRealms[region] ?? "oc1";
  const domain = regions.realms[realm] ?? "oraclecloud.com";
  return `https://auth.${region}.${domain}`;
}

async function fetchInstanceIdFromImds(env: Env): Promise<string> {
  const override = env.OCI_METADATA_BASE_URL?.trim();
  const candidates = override
    ? [override.replace(/\/+$/, "")]
    : [DEFAULT_METADATA_URL_BASE, DEFAULT_METADATA_URL_BASE_IPV6];
  let lastError: unknown;
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/instance/id`, {
        headers: METADATA_AUTH_HEADERS,
      });
      if (!res.ok) {
        throw new ResourcePrincipalError(
          `IMDS request failed (${res.status}) for ${base}/instance/id`,
        );
      }
      return (await res.text()).trim().toLowerCase();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function resolveV22(
  env: Env,
  regions: RegionsSpec,
): ResourcePrincipalCredentials {
  const rpstSource = env.OCI_RESOURCE_PRINCIPAL_RPST;
  if (rpstSource === undefined) {
    throw new ResourcePrincipalError(
      `session_token was not provided ${RP_DEBUG_HINT}`,
    );
  }
  const privateKeySource = env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM;
  if (privateKeySource === undefined) {
    throw new ResourcePrincipalError(
      `private_key must be provided ${RP_DEBUG_HINT}`,
    );
  }
  const passphraseSource = env.OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PASSPHRASE;

  const token = isAbsolute(rpstSource)
    ? readFileSync(rpstSource, "utf8")
    : rpstSource;

  let privateKey: KeyObject;
  if (isAbsolute(privateKeySource)) {
    const pem = readFileSync(privateKeySource, "utf8");
    const passphrase =
      passphraseSource !== undefined
        ? isAbsolute(passphraseSource)
          ? readFileSync(passphraseSource, "utf8")
          : passphraseSource
        : undefined;
    privateKey = loadPrivateKey(pem, passphrase);
  } else {
    privateKey = loadPrivateKey(privateKeySource, passphraseSource);
  }

  return {
    keyId: `ST$${token}`,
    privateKey,
    region: resolveRegion(env.OCI_RESOURCE_PRINCIPAL_REGION, regions),
  };
}

async function resolveV11(
  env: Env,
  regions: RegionsSpec,
): Promise<ResourcePrincipalCredentials> {
  const rptEndpoint = env.OCI_RESOURCE_PRINCIPAL_RPT_ENDPOINT?.trim();
  if (!rptEndpoint) {
    throw new ResourcePrincipalError(
      "resource_principal_token_endpoint must be provided",
    );
  }

  const ip = await resolveInstancePrincipal({ env, regions });

  const pathTemplate =
    env.OCI_RESOURCE_PRINCIPAL_RPT_PATH?.trim() || DEFAULT_RPT_PATH_TEMPLATE;
  let rptPath = pathTemplate;
  if (rptPath.includes("{id}")) {
    const rptId =
      env.OCI_RESOURCE_PRINCIPAL_RPT_ID?.trim() ||
      (await fetchInstanceIdFromImds(env));
    rptPath = rptPath.replaceAll("{id}", rptId);
  }

  const rptReq = {
    method: "GET",
    url: `${rptEndpoint.replace(/\/+$/, "")}${rptPath}`,
    headers: {} as Record<string, string>,
    body: "",
  };
  signRequest(rptReq, { keyId: ip.keyId, privateKey: ip.privateKey });

  const rptRes = await fetch(rptReq.url, {
    method: rptReq.method,
    headers: rptReq.headers,
  });
  const rptText = await rptRes.text();
  let rptData: Record<string, unknown>;
  try {
    rptData = JSON.parse(rptText) as Record<string, unknown>;
  } catch {
    throw new ResourcePrincipalError(
      `Unable to parse RPT response (${rptReq.url}): ${rptText}`,
    );
  }
  if (!rptRes.ok) {
    throw new ResourcePrincipalError(
      `RPT request failed (${rptRes.status}): ${String(rptData.message ?? rptText)}`,
    );
  }
  const resourcePrincipalToken = rptData.resourcePrincipalToken;
  const servicePrincipalSessionToken = rptData.servicePrincipalSessionToken;
  if (
    typeof resourcePrincipalToken !== "string" ||
    typeof servicePrincipalSessionToken !== "string"
  ) {
    throw new ResourcePrincipalError(
      `Missing resourcePrincipalToken or servicePrincipalSessionToken in RPT response (${rptReq.url})`,
    );
  }

  const { publicKey, privateKey: sessionPrivateKey } = generateKeyPairSync(
    "rsa",
    { modulusLength: 2048, publicExponent: 0x10001 },
  );
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const rpstBase =
    env.OCI_RESOURCE_PRINCIPAL_RPST_ENDPOINT?.trim() ||
    defaultAuthEndpoint(ip.region, regions);
  const rpstUrl = `${rpstBase.replace(/\/+$/, "")}/v1/resourcePrincipalSessionToken`;

  const rpstReq = {
    method: "POST",
    url: rpstUrl,
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify({
      resourcePrincipalToken,
      servicePrincipalSessionToken,
      sessionPublicKey: sanitizePem(publicKeyPem),
    }),
  };
  prepareContentLength(rpstReq);
  signRequest(rpstReq, { keyId: ip.keyId, privateKey: ip.privateKey });

  const rpstRes = await fetch(rpstReq.url, {
    method: rpstReq.method,
    headers: rpstReq.headers,
    body: rpstReq.body,
  });
  const rpstText = await rpstRes.text();
  let rpstData: Record<string, unknown>;
  try {
    rpstData = JSON.parse(rpstText) as Record<string, unknown>;
  } catch {
    throw new ResourcePrincipalError(
      `Unable to parse RPST response (${rpstUrl}): ${rpstText}`,
    );
  }
  if (!rpstRes.ok) {
    throw new ResourcePrincipalError(
      `RPST request failed (${rpstRes.status}): ${String(rpstData.message ?? rpstText)}`,
    );
  }
  if (typeof rpstData.token !== "string" || !rpstData.token) {
    throw new ResourcePrincipalError(
      `Could not find token in RPST response (${rpstUrl})`,
    );
  }

  return {
    keyId: `ST$${rpstData.token}`,
    privateKey: sessionPrivateKey,
    region: ip.region,
  };
}

export async function resolveResourcePrincipal(
  opts: ResourcePrincipalOptions,
): Promise<ResourcePrincipalCredentials> {
  const rpVersion = opts.env.OCI_RESOURCE_PRINCIPAL_VERSION;
  if (rpVersion === undefined) {
    throw new ResourcePrincipalError(
      "OCI_RESOURCE_PRINCIPAL_VERSION is not defined",
    );
  }
  if (rpVersion === "2.2") {
    return resolveV22(opts.env, opts.regions);
  }
  if (rpVersion === "1.1") {
    return await resolveV11(opts.env, opts.regions);
  }
  throw new ResourcePrincipalError(
    `Unsupported OCI_RESOURCE_PRINCIPAL_VERSION: ${rpVersion}`,
  );
}

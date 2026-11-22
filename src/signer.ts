// OCI HTTP Signature request signing (oci.signer.Signer + httpsig_cffi), ADR 0002.
// RSA-SHA256 PKCS#1 v1.5 is deterministic, so signatures match the SDK byte for byte.
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  type KeyObject,
} from "node:crypto";

const GENERIC_HEADERS = ["date", "(request-target)", "host"];
const BODY_HEADERS = ["content-length", "content-type", "x-content-sha256"];

export type SignableRequest = {
  method: string;
  url: string;
  /** Lower-case header names; updated in place with the injected and signed headers. */
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
};

export type ApiKey = { keyId: string; privateKey: KeyObject };

export class InvalidPrivateKey extends Error {}
export class MissingPrivateKeyPassphrase extends Error {}

function isPublicKey(pem: string): boolean {
  if (/^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp\d+)\s+\S+/.test(pem))
    return true;
  try {
    createPublicKey({ key: pem, format: "pem" });
    return true;
  } catch {
    return false;
  }
}

export function loadPrivateKey(
  pem: string,
  passPhrase?: string | null,
): KeyObject {
  const key = pem.trim();
  const hasPassphrase = passPhrase !== null && passPhrase !== undefined;
  try {
    return createPrivateKey({
      key,
      format: "pem",
      ...(hasPassphrase && passPhrase !== "" ? { passphrase: passPhrase } : {}),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ERR_MISSING_PASSPHRASE") {
      if (!hasPassphrase) {
        throw new MissingPrivateKeyPassphrase(
          "The provided key requires a passphrase.",
          { cause: e },
        );
      }
      // oci.signer.load_private_key: an empty passphrase string triggers TypeError
      // in cryptography, then retries with None and raises this TypeError.
      throw new TypeError(
        "Password was not given but private key is encrypted",
      );
    }
    if (isPublicKey(key)) {
      throw new InvalidPrivateKey(
        "Authentication requires a private key, but a public key was provided.",
        { cause: e },
      );
    }
    throw new InvalidPrivateKey(
      "The provided key is not a private key, or the provided passphrase is incorrect.",
      { cause: e },
    );
  }
}

/** email.utils.formatdate(usegmt=True) */
export const httpDate = (d = new Date()) => d.toUTCString();

/** urlparse(url).netloc */
const netloc = (url: string) =>
  /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
/** requests' PreparedRequest.path_url: path (default "/") plus "?query" when present. */
function pathUrl(url: string): string {
  const rest = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
    .replace(/#.*$/, "");
  const q = rest.indexOf("?");
  const path = (q === -1 ? rest : rest.slice(0, q)) || "/";
  return q === -1 || q === rest.length - 1 ? path : `${path}${rest.slice(q)}`;
}

/** oci.signer.AbstractBaseSigner.do_request_sign */
export function signRequest(
  req: SignableRequest,
  key: ApiKey,
  enforceContentHeaders = true,
  genericHeaders: readonly string[] = GENERIC_HEADERS,
): void {
  const verb = req.method.toLowerCase();
  if (!["get", "head", "delete", "put", "post", "patch"].includes(verb)) {
    throw new Error(`Don't know how to sign request verb ${verb}`);
  }
  const signBody = ["put", "post", "patch"].includes(verb);
  const h = req.headers;
  const headers =
    signBody && enforceContentHeaders
      ? [...genericHeaders, ...BODY_HEADERS]
      : [...genericHeaders];
  if (!(signBody && enforceContentHeaders)) delete h["transfer-encoding"];

  // inject_missing_headers
  h.date ??= httpDate();
  h.host ??= netloc(req.url);
  h["content-type"] ??= "application/json";
  if (
    enforceContentHeaders &&
    signBody &&
    h["x-content-sha256"] === undefined
  ) {
    const body = req.body ?? "";
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (typeof body === "string") h["content-length"] ??= String(bytes.length);
    h["x-content-sha256"] = new Bun.CryptoHasher("sha256")
      .update(bytes)
      .digest("base64");
  }

  const host = netloc(req.url);
  const lines = headers.map((name) => {
    if (name === "(request-target)")
      return `(request-target): ${verb} ${pathUrl(req.url)}`;
    if (name === "host") return `host: ${host}`;
    const value = h[name];
    if (value === undefined)
      throw new Error(`missing required header "${name}"`);
    return `${name}: ${value}`;
  });
  const signature = createSign("sha256")
    .update(lines.join("\n"))
    .sign(key.privateKey, "base64");
  h.authorization = `Signature algorithm="rsa-sha256",headers="${headers.join(" ")}",keyId="${key.keyId}",signature="${signature}",version="1"`;
}

/**
 * requests.PreparedRequest.prepare_content_length, which runs before signing: bodies get
 * their length; body-less requests other than GET/HEAD get "0". For a str body requests
 * uses len(str), i.e. code points, not bytes — identical for the ASCII-escaped JSON the
 * SDK sends (json.dumps ensure_ascii), and mirrored here for signature parity.
 */
export function prepareContentLength(req: SignableRequest): void {
  const body = req.body;
  if (body !== undefined && body !== null && body !== "") {
    req.headers["content-length"] = String(
      typeof body === "string" ? [...body].length : body.length,
    );
  } else if (
    !["GET", "HEAD"].includes(req.method.toUpperCase()) &&
    req.headers["content-length"] === undefined
  ) {
    req.headers["content-length"] = "0";
  }
}

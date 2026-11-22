import type { KeyObject } from "node:crypto";

/** Serialize an RSA public key as a JSON Web Key (JWK) string. */
export function publicKeyToJwk(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as {
    n?: string;
    e?: string;
  };
  return `{"kty": "RSA", "n": ${JSON.stringify(jwk.n ?? "")}, "e": ${JSON.stringify(jwk.e ?? "")}, "kid": "Ignored"}`;
}

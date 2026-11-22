import { createHash, type KeyObject } from "node:crypto";

/** Compute the colon-separated MD5 fingerprint of a public key's SPKI DER bytes. */
export function publicKeyToMd5Fingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  const hex = createHash("md5").update(der).digest("hex");
  return hex.match(/../g)?.join(":") ?? hex;
}

import { generateKeyPairSync, type KeyObject } from "node:crypto";

/** Generate an RSA key pair (default 2048-bit) with public exponent 65537. */
export function generateRsaKeyPair(keySize = 2048): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  return generateKeyPairSync("rsa", {
    modulusLength: keySize,
    publicExponent: 0x10001,
  });
}

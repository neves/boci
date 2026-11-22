/** Decode a base64url-encoded string into a Buffer, throwing on invalid characters or padding. */
export function decodeBase64Url(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error("Invalid padding");
  }
  const rem = segment.length % 4;
  if (rem === 1) {
    throw new Error("Invalid padding");
  }
  const padded = rem === 0 ? segment : segment + "=".repeat(4 - rem);
  return Buffer.from(
    padded.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
}

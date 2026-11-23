import { decodeBase64Url } from "../utils/decodeBase64Url.ts";

export class SecurityTokenDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export class SecurityTokenKeyError extends Error {
  constructor(key: string) {
    super(`'${key}'`);
    this.name = "KeyError";
  }
}

function decodeBase64UrlSegment(segment: string): Buffer {
  try {
    return decodeBase64Url(segment);
  } catch {
    throw new SecurityTokenDecodeError("Invalid padding");
  }
}

/**
 * Port of `oci.auth.security_token_container.SecurityTokenContainer(None, token)`
 * (`jwt.decode(jwt=security_token, options={"verify_signature": False})`).
 */
export function decodeSecurityToken(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new SecurityTokenDecodeError("Not enough segments");
  }
  const [headerSeg, payloadSeg] = parts as [string, string, string];
  let header: unknown;
  try {
    header = JSON.parse(decodeBase64UrlSegment(headerSeg).toString("utf8"));
  } catch {
    throw new SecurityTokenDecodeError("Invalid header string");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new SecurityTokenDecodeError(
      "Invalid header string: must be a json object",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlSegment(payloadSeg).toString("utf8"));
  } catch {
    throw new SecurityTokenDecodeError("Invalid payload string");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SecurityTokenDecodeError(
      "Invalid payload string: must be a json object",
    );
  }
  return payload as Record<string, unknown>;
}

/** Port of `SecurityTokenContainer.valid()`: `not (int(time.time()) > self.jwt['exp'])`. */
export function isSecurityTokenValid(
  jwtPayload: Record<string, unknown>,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!("exp" in jwtPayload) || jwtPayload.exp === undefined) {
    throw new SecurityTokenKeyError("exp");
  }
  return !(nowEpochSeconds > Number(jwtPayload.exp));
}

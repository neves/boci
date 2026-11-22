import { describe, expect, test } from "bun:test";
import {
  SecurityTokenDecodeError,
  SecurityTokenKeyError,
  decodeSecurityToken,
  formatLocalTimestamp,
  isSecurityTokenValid,
} from "../../src/session.ts";

describe("session validate helpers", () => {
  test("decodeSecurityToken parses valid JWT payload", () => {
    const token =
      "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjIwODQxMDAwMDAsImlhdCI6MjA4NDA5MDAwMH0.eA";
    expect(decodeSecurityToken(token)).toEqual({
      exp: 2084100000,
      iat: 2084090000,
    });
  });

  test("decodeSecurityToken rejects malformed tokens", () => {
    expect(() => decodeSecurityToken("not-a-jwt")).toThrow(
      SecurityTokenDecodeError,
    );
    expect(() => decodeSecurityToken("a.b")).toThrow("Not enough segments");
    expect(() => decodeSecurityToken("a.b.c")).toThrow(
      SecurityTokenDecodeError,
    );
  });

  test("isSecurityTokenValid checks epoch boundary without jitter", () => {
    expect(isSecurityTokenValid({ exp: 1000 }, 999)).toBe(true);
    expect(isSecurityTokenValid({ exp: 1000 }, 1000)).toBe(true);
    expect(isSecurityTokenValid({ exp: 1000 }, 1001)).toBe(false);
    expect(() => isSecurityTokenValid({ iat: 1000 }, 1000)).toThrow(
      SecurityTokenKeyError,
    );
  });

  test("formatLocalTimestamp respects TZ", () => {
    expect(formatLocalTimestamp(2084100000, "UTC")).toBe("2036-01-16 12:40:00");
    expect(formatLocalTimestamp(0, "UTC")).toBe("1970-01-01 00:00:00");
    expect(formatLocalTimestamp(2084100000, "America/Sao_Paulo")).toBe(
      "2036-01-16 09:40:00",
    );
  });
});

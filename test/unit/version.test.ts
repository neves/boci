import { expect, test } from "bun:test";
import index from "../../spec/index.json";
import pkg from "../../package.json";
import {
  REFERENCE_VERSION,
  resolveBociVersion,
} from "../../src/core/version.ts";

test("boci reports the Reference CLI version the spec was extracted from", () => {
  expect(REFERENCE_VERSION).toBe(index.referenceVersion);
});

test("resolveBociVersion strips leading v and falls back to package.json version", () => {
  expect(resolveBociVersion("v1.2.3")).toBe("1.2.3");
  expect(resolveBociVersion("V1.2.3")).toBe("1.2.3");
  expect(resolveBociVersion(" 1.2.3 ")).toBe("1.2.3");
  expect(resolveBociVersion("")).toBe(pkg.version);
  expect(resolveBociVersion("   ")).toBe(pkg.version);
  expect(resolveBociVersion(undefined)).toBe(pkg.version);
});

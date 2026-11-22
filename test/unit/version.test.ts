import { expect, test } from "bun:test";
import index from "../../spec/index.json";
import { REFERENCE_VERSION } from "../../src/core/version.ts";

test("boci reports the Reference CLI version the spec was extracted from", () => {
  expect(REFERENCE_VERSION).toBe(index.referenceVersion);
});

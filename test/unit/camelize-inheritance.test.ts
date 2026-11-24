import { expect, test } from "bun:test";
import { camelizeKeys } from "../../src/core/camelize.ts";

test("request subtype discriminator is inherited through named models", () => {
  const keys = {
    complexTypes: { config: "module:Item" },
    models: {
      module: {
        Base: {
          attributes: [],
          discriminator: {
            field: "kind",
            values: { SPECIAL: "Special" },
            fallback: "Base",
          },
        },
        Middle: { attributes: [], discriminator: "Base" },
        Item: { attributes: [], discriminator: "Middle" },
        Special: {
          attributes: [
            ["kind", "str", "kind"],
            ["special_value", "str", "specialValue"],
          ] as [string, string, string][],
        },
      },
    },
  };
  expect(
    camelizeKeys(keys, { kind: "SPECIAL", special_value: "yes" }, "config"),
  ).toEqual({ kind: "SPECIAL", specialValue: "yes" });
  expect(() => camelizeKeys(keys, { special_value: "yes" }, "config")).toThrow(
    "kind",
  );
});

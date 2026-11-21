import { expect, test } from "bun:test";
import pkg from "../../package.json";

test("package exposes the boci binary and the dev scripts the Ladder relies on", () => {
  expect(pkg.bin.boci).toBe("src/main.ts");
  for (const script of ["status", "extract", "build", "parity:live"]) {
    expect(Object.keys(pkg.scripts)).toContain(script);
  }
});

test("main entry point exists", async () => {
  expect(await Bun.file(`${import.meta.dir}/../../src/main.ts`).exists()).toBe(
    true,
  );
});

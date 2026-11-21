import { expect, test } from "bun:test";

const root = `${import.meta.dir}/../../spec`;
const load = async (name: string) =>
  (await Bun.file(`${root}/${name}.json`).json()) as {
    commands: Record<string, { kind: "generated" | "custom" }>;
  };
const index = (await Bun.file(`${root}/index.json`).json()) as {
  kinds: Record<string, { generated: number; custom: number }>;
};

test("leaf commands mapping straight onto one operation are generated", async () => {
  const os = await load("os");
  expect(os.commands["ns get"]?.kind).toBe("generated");
  expect(os.commands["bucket list"]?.kind).toBe("generated");
});

test("hand-written leaf commands are custom", async () => {
  const os = await load("os");
  expect(os.commands["object put"]?.kind).toBe("custom");
  expect(os.commands["object bulk-upload"]?.kind).toBe("custom");
  expect((await load("setup")).commands.config?.kind).toBe("custom");
});

test("index records generated/custom counts per service", () => {
  const os = index.kinds.os;
  expect(os?.generated).toBeGreaterThan(0);
  expect(os?.custom).toBeGreaterThan(0);
});

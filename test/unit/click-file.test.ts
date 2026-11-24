import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClickFileForProgram } from "../../src/core/click-file.ts";
import type { Invocation } from "../../src/lib/io.ts";

const io = (cwd: string, stdin?: string): Invocation => ({
  argv: [],
  env: {},
  cwd,
  stdin,
  out() {},
  err() {},
  isTTY: () => false,
  columns: () => undefined,
});

test("Click program input reads named bytes and stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boci-click-file-"));
  try {
    await writeFile(join(dir, "input"), Buffer.from([0, 255, 65]));
    const named = await openClickFileForProgram(io(dir), "input", "rb");
    expect(named.read()).toEqual(new Uint8Array([0, 255, 65]));
    const stdin = await openClickFileForProgram(io(dir, "hello"), "-", "r");
    expect(stdin.read()).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Click program input reports missing named files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boci-click-file-"));
  try {
    await expect(
      openClickFileForProgram(io(dir), "missing", "r"),
    ).rejects.toThrow("No such file or directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Click program write modes reject directory targets before opening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boci-click-file-"));
  try {
    await expect(openClickFileForProgram(io(dir), ".", "wb")).rejects.toThrow(
      "Is a directory",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

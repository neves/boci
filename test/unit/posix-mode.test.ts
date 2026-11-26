import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { getPosixMode, setPosixMode } from "../../src/lib/posixMode.ts";

const originalPlatform = process.platform;
let root: string;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  if (root) {
    try {
      chmodSync(join(root, "mode-directory"), 0o700);
    } catch {
      // The file-mode case has no restricted directory.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows permission modes are tied to the current filesystem object", () => {
  root = mkdtempSync(join(tmpdir(), "boci-posix-mode-"));
  const path = join(root, "mode-file");
  writeFileSync(path, "first");
  Object.defineProperty(process, "platform", { value: "win32" });

  setPosixMode(path, 0o000);
  expect(getPosixMode(path)).toBe(0o000);
  expect(statSync(path).mode & 0o777).toBe(
    originalPlatform === "win32" ? 0o444 : 0o000,
  );

  rmSync(path);
  writeFileSync(path, "replacement");
  expect(getPosixMode(path)).toBe(0o600);
});

test("Windows directory modes do not survive directory recreation", () => {
  root = mkdtempSync(join(tmpdir(), "boci-posix-mode-"));
  const path = join(root, "mode-directory");
  mkdirSync(path);
  Object.defineProperty(process, "platform", { value: "win32" });

  setPosixMode(path, 0o000);
  expect(getPosixMode(path)).toBe(0o000);
  expect(statSync(path).mode & 0o777).toBe(
    originalPlatform === "win32" ? 0o444 : 0o000,
  );

  chmodSync(path, 0o700);
  rmSync(path, { recursive: true });
  mkdirSync(path);
  expect(getPosixMode(path)).toBe(0o700);
});

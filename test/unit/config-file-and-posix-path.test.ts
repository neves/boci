import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigFile } from "../../src/utils/configFile.ts";
import { normalizePosixPath } from "../../src/utils/posixPath.ts";

describe("shared config and path helpers", () => {
  test("reads regular config files and ignores missing or directory targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-config-read-"));
    try {
      const file = join(dir, "config");
      await writeFile(file, "[DEFAULT]\n");
      expect(readConfigFile(file)).toBe("[DEFAULT]\n");
      expect(readConfigFile(join(dir, "missing"))).toBeNull();
      expect(readConfigFile(dir)).toBeNull();
      const subdir = join(dir, "subdir");
      await mkdir(subdir);
      expect(readConfigFile(subdir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("normalizes separators and strips trailing separators", () => {
    expect(normalizePosixPath("C:\\Users\\me\\.oci\\")).toBe(
      "C:/Users/me/.oci",
    );
    expect(normalizePosixPath("/tmp/config///")).toBe("/tmp/config");
  });
});

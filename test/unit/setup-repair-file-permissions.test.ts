import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { applyUserOnlyAccessPermissions } from "../../src/commands/setup.ts";

async function runSetup(argv: string[], home: string) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv,
    env: { HOME: home, LC_ALL: "C.UTF-8" },
    cwd: home,
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
    isTTY: () => false,
    columns: () => undefined,
  });
  return { stdout, stderr, exitCode };
}

describe("setup repair-file-permissions", () => {
  test("follows symlinks to files, rejects broken symlinks and symlinked directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-perm-"));
    try {
      const target = join(dir, "target.pem");
      await Bun.write(target, "secret\n");
      await chmod(target, 0o644);
      const fileLink = join(dir, "link.pem");
      await symlink(target, fileLink);

      const ok = await runSetup(
        ["setup", "repair-file-permissions", "--file", fileLink],
        dir,
      );
      expect(ok).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      expect((await stat(target)).mode & 0o777).toBe(0o600);

      const brokenLink = join(dir, "broken.pem");
      await symlink(join(dir, "missing.pem"), brokenLink);
      const broken = await runSetup(
        ["setup", "repair-file-permissions", "--file", brokenLink],
        dir,
      );
      expect(broken.exitCode).toBe(2);
      expect(broken.stdout).toContain(
        `Error: Could not find file: ${brokenLink}`,
      );

      const subDir = join(dir, "subdir");
      await mkdir(subDir, { mode: 0o755 });
      const dirLink = join(dir, "dirlink");
      await symlink(subDir, dirLink);
      const onDir = await runSetup(
        ["setup", "repair-file-permissions", "--file", dirLink],
        dir,
      );
      expect(onDir.exitCode).toBe(2);
      expect(onDir.stdout).toContain(
        "Error: This command is only supported for files.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applyUserOnlyAccessPermissions sets 0o700 on directories and throws when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-dir-"));
    try {
      const subDir = join(dir, "nested");
      await mkdir(subDir, { mode: 0o755 });
      applyUserOnlyAccessPermissions(subDir);
      expect((await stat(subDir)).mode & 0o777).toBe(0o700);
      expect(() =>
        applyUserOnlyAccessPermissions(join(dir, "missing")),
      ).toThrow("path that does not exist");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

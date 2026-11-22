import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { OCI_AUTOCOMPLETE_SCRIPT } from "../../src/setup.ts";

async function runAutocomplete(home: string, stdin: string) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv: ["setup", "autocomplete"],
    env: { HOME: home, LC_ALL: "C.UTF-8" },
    cwd: home,
    stdin,
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

describe("setup autocomplete", () => {
  test("creates .bashrc, symlinks ~/lib/oci_autocomplete.sh, and writes source line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-"));
    try {
      const res = await runAutocomplete(dir, "y\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");

      const softLink = join(dir, "lib", "oci_autocomplete.sh");
      const linkStat = await lstat(softLink);
      expect(linkStat.isSymbolicLink()).toBe(true);
      const target = await readlink(softLink);
      expect(await readFile(target, "utf8")).toBe(OCI_AUTOCOMPLETE_SCRIPT);
      expect(await readFile(softLink, "utf8")).toBe(OCI_AUTOCOMPLETE_SCRIPT);

      const expectedLine = `[[ -e "${softLink}" ]] && source "${softLink}"`;
      const bashrc = await readFile(join(dir, ".bashrc"), "utf8");
      expect(bashrc).toBe(`\n${expectedLine}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends to existing .bashrc without clobbering existing content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-exist-"));
    try {
      const bashrcPath = join(dir, ".bashrc");
      await writeFile(bashrcPath, "export FOO=bar\n");
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);

      const softLink = join(dir, "lib", "oci_autocomplete.sh");
      const expectedLine = `[[ -e "${softLink}" ]] && source "${softLink}"`;
      expect(await readFile(bashrcPath, "utf8")).toBe(
        `export FOO=bar\n\n${expectedLine}\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not duplicate line when already configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-dup-"));
    try {
      const bashrcPath = join(dir, ".bashrc");
      const softLink = join(dir, "lib", "oci_autocomplete.sh");
      const existing = `export FOO=1\n[[ -e "${softLink}" ]] && source "${softLink}"\n`;
      await writeFile(bashrcPath, existing);
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        `It looks like tab completion for oci is already configured in ${bashrcPath}.`,
      );
      expect(await readFile(bashrcPath, "utf8")).toBe(existing);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prefers .bashrc over .bash_profile when both exist on Linux", async () => {
    if (process.platform === "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-both-"));
    try {
      await writeFile(join(dir, ".bashrc"), "# bashrc\n");
      await writeFile(join(dir, ".bash_profile"), "# profile\n");
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        `leave blank to use '${join(dir, ".bashrc")}'`,
      );
      expect(await readFile(join(dir, ".bash_profile"), "utf8")).toBe(
        "# profile\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("broken existing symlink at ~/lib/oci_autocomplete.sh reports unable to symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-broken-"));
    try {
      await writeFile(join(dir, ".bashrc"), "# keep\n");
      await mkdir(join(dir, "lib"), { recursive: true });
      await symlink(
        join(dir, "does-not-exist.sh"),
        join(dir, "lib", "oci_autocomplete.sh"),
      );
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        "Unable to symlink ~/lib/oci_autocomplete.sh to",
      );
      expect(await readFile(join(dir, ".bashrc"), "utf8")).toBe("# keep\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("declining confirmation after auto-creating default .bashrc leaves empty .bashrc and no symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-decline-"));
    try {
      const res = await runAutocomplete(dir, "y\nn\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        "Exiting script. Tab completion not set up.",
      );
      expect(await readFile(join(dir, ".bashrc"), "utf8")).toBe("");
      await expect(
        lstat(join(dir, "lib", "oci_autocomplete.sh")),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("declining default creation and leaving path blank fails with CLIInstallError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-empty-"));
    try {
      const res = await runAutocomplete(dir, "n\n\n");
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toBe(
        "CLIInstallError: No suitable profile file found.\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("EOF during prompt_input exits 1 with EOFError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-ac-eof-"));
    try {
      const res = await runAutocomplete(dir, "");
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toBe("EOFError: EOF when reading a line\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { OCI_AUTOCOMPLETE_SCRIPT } from "../../src/commands/setup.ts";

async function makeTempHome(prefix: string): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), prefix));
  return (await realpath(raw)).replaceAll("\\", "/");
}

async function runAutocomplete(
  home: string,
  stdin: string,
  platform = "linux",
  usePlatformOverride = true,
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv: ["setup", "autocomplete"],
    env: {
      HOME: home,
      LC_ALL: "C.UTF-8",
      ...(usePlatformOverride ? { BOCI_SETUP_PLATFORM: platform } : {}),
    },
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
    const dir = await makeTempHome("boci-setup-ac-");
    try {
      const res = await runAutocomplete(dir, "y\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");

      const softLink = `${dir}/lib/oci_autocomplete.sh`;
      const linkStat = await lstat(softLink);
      expect(linkStat.isSymbolicLink()).toBe(true);
      const target = await readlink(softLink);
      expect(await readFile(target, "utf8")).toBe(OCI_AUTOCOMPLETE_SCRIPT);
      expect(await readFile(softLink, "utf8")).toBe(OCI_AUTOCOMPLETE_SCRIPT);

      const expectedLine = `[[ -e "${softLink}" ]] && source "${softLink}"`;
      const bashrc = await readFile(`${dir}/.bashrc`, "utf8");
      expect(bashrc).toBe(`\n${expectedLine}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends to existing .bashrc without clobbering existing content", async () => {
    const dir = await makeTempHome("boci-setup-ac-exist-");
    try {
      const bashrcPath = `${dir}/.bashrc`;
      await writeFile(bashrcPath, "export FOO=bar\n");
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);

      const softLink = `${dir}/lib/oci_autocomplete.sh`;
      const expectedLine = `[[ -e "${softLink}" ]] && source "${softLink}"`;
      expect(await readFile(bashrcPath, "utf8")).toBe(
        `export FOO=bar\n\n${expectedLine}\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not duplicate line when already configured", async () => {
    const dir = await makeTempHome("boci-setup-ac-dup-");
    try {
      const bashrcPath = `${dir}/.bashrc`;
      const softLink = `${dir}/lib/oci_autocomplete.sh`;
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
    const dir = await makeTempHome("boci-setup-ac-both-");
    try {
      await writeFile(`${dir}/.bashrc`, "# bashrc\n");
      await writeFile(`${dir}/.bash_profile`, "# profile\n");
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`leave blank to use '${dir}/.bashrc'`);
      expect(await readFile(`${dir}/.bash_profile`, "utf8")).toBe(
        "# profile\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prefers .bash_profile and creates it by default on macOS", async () => {
    const dir = await makeTempHome("boci-setup-ac-darwin-");
    try {
      await writeFile(`${dir}/.bashrc`, "# bashrc\n");
      await writeFile(`${dir}/.bash_profile`, "# profile\n");
      const res = await runAutocomplete(dir, "\ny\n", "darwin");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`leave blank to use '${dir}/.bash_profile'`);
      expect(await readFile(`${dir}/.bash_profile`, "utf8")).toContain(
        `source "${dir}/lib/oci_autocomplete.sh"`,
      );
      expect(await readFile(`${dir}/.bashrc`, "utf8")).toBe("# bashrc\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "uses .bash_profile by default on macOS without an override",
    async () => {
      const dir = await makeTempHome("boci-setup-ac-darwin-default-");
      try {
        await writeFile(`${dir}/.bashrc`, "# bashrc\n");
        await writeFile(`${dir}/.bash_profile`, "# profile\n");
        const res = await runAutocomplete(dir, "\ny\n", "linux", false);
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain(
          `leave blank to use '${dir}/.bash_profile'`,
        );
        expect(await readFile(`${dir}/.bash_profile`, "utf8")).toContain(
          `source "${dir}/lib/oci_autocomplete.sh"`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("creates .bash_profile when it is the macOS default", async () => {
    const dir = await makeTempHome("boci-setup-ac-darwin-create-");
    try {
      const res = await runAutocomplete(dir, "y\ny\n", "darwin");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`Create ${dir}/.bash_profile now?`);
      expect(await readFile(`${dir}/.bash_profile`, "utf8")).toContain(
        `source "${dir}/lib/oci_autocomplete.sh"`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("broken existing symlink at ~/lib/oci_autocomplete.sh reports unable to symlink", async () => {
    const dir = await makeTempHome("boci-setup-ac-broken-");
    try {
      await writeFile(`${dir}/.bashrc`, "# keep\n");
      await mkdir(`${dir}/lib`, { recursive: true });
      await symlink(
        `${dir}/does-not-exist.sh`,
        `${dir}/lib/oci_autocomplete.sh`,
      );
      const res = await runAutocomplete(dir, "\ny\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        "Unable to symlink ~/lib/oci_autocomplete.sh to",
      );
      expect(await readFile(`${dir}/.bashrc`, "utf8")).toBe("# keep\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("declining confirmation after auto-creating default .bashrc leaves empty .bashrc and no symlink", async () => {
    const dir = await makeTempHome("boci-setup-ac-decline-");
    try {
      const res = await runAutocomplete(dir, "y\nn\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(
        "Exiting script. Tab completion not set up.",
      );
      expect(await readFile(`${dir}/.bashrc`, "utf8")).toBe("");
      await expect(lstat(`${dir}/lib/oci_autocomplete.sh`)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("declining default creation and leaving path blank fails with CLIInstallError", async () => {
    const dir = await makeTempHome("boci-setup-ac-empty-");
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
    const dir = await makeTempHome("boci-setup-ac-eof-");
    try {
      const res = await runAutocomplete(dir, "");
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toBe("EOFError: EOF when reading a line\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

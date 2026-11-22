import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { formatParsedConfig, parseConfig } from "../../src/configparser.ts";
import { removeProfileFromConfig } from "../../src/setup.ts";
import { buildZip } from "../../src/zip.ts";

async function runCliInHome(
  argv: string[],
  home: string,
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv,
    env: {
      HOME: home,
      LC_ALL: "C.UTF-8",
      SUPPRESS_LABEL_WARNING: "True",
      ...opts.env,
    },
    cwd: home,
    stdin: opts.stdin,
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

describe("session import helpers", () => {
  test("formatParsedConfig matches CPython ConfigParser.write with default_section=''", () => {
    const parsed = parseConfig(
      "[DEFAULT]\nregion=us-ashburn-1\n\n[SESSION]\nregion=us-phoenix-1\n\n[OTHER]\nkey=line1\n\tline2\n",
      "config",
      "",
    );
    parsed.sections.delete("SESSION");
    expect(formatParsedConfig(parsed, "")).toBe(
      "[DEFAULT]\nregion = us-ashburn-1\n\n[OTHER]\nkey = line1\n\tline2\n\n",
    );
  });

  test("removeProfileFromConfig removes named section or standard DEFAULT keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-rm-prof-"));
    try {
      const cfg = join(dir, "config");
      await writeFile(
        cfg,
        "[DEFAULT]\nuser=u\nregion=us-ashburn-1\ncustom=keep\n\n[DEV]\nregion=us-phoenix-1\n",
      );
      removeProfileFromConfig(cfg, cfg, "DEV");
      expect(await readFile(cfg, "utf8")).toBe(
        "[DEFAULT]\nuser = u\nregion = us-ashburn-1\ncustom = keep\n\n",
      );

      removeProfileFromConfig(cfg, cfg, "DEFAULT");
      expect(await readFile(cfg, "utf8")).toBe("[DEFAULT]\ncustom = keep\n\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session export -> import round-trip", () => {
  test("exports a session profile and imports it cleanly into another home", async () => {
    const srcHome = await mkdtemp(join(tmpdir(), "boci-sess-src-"));
    const dstHome = await mkdtemp(join(tmpdir(), "boci-sess-dst-"));
    try {
      const srcOci = join(srcHome, ".oci");
      await mkdir(srcOci, { recursive: true });
      await writeFile(join(srcOci, "oci_api_key.pem"), "EXPORTED-KEY-DATA\n");
      await chmod(join(srcOci, "oci_api_key.pem"), 0o600);
      await writeFile(join(srcOci, "token"), "exported.jwt.token");
      await chmod(join(srcOci, "token"), 0o600);
      await writeFile(
        join(srcOci, "config"),
        [
          "[DEV]",
          "region=us-phoenix-1",
          "tenancy=ocid1.tenancy.oc1..roundtrip",
          "fingerprint=11:22:33",
          "key_file=~/.oci/oci_api_key.pem",
          "security_token_file=~/.oci/token",
          "",
        ].join("\n"),
      );

      const exportRes = await runCliInHome(
        [
          "session",
          "export",
          "--profile",
          "DEV",
          "--output-file",
          join(dstHome, "exported-dev"),
        ],
        srcHome,
      );
      expect(exportRes.exitCode).toBe(0);

      await mkdir(join(dstHome, ".oci"), { recursive: true });
      const importRes = await runCliInHome(
        [
          "session",
          "import",
          "--session-archive",
          join(dstHome, "exported-dev.zip"),
        ],
        dstHome,
      );
      expect(importRes.exitCode).toBe(0);
      const dstCfg = join(dstHome, ".oci", "config");
      expect(importRes.stderr).toBe(
        `Imported profile DEV written to: ${dstCfg}\n`,
      );
      expect(await readFile(dstCfg, "utf8")).toBe(
        [
          "[DEV]",
          "fingerprint=11:22:33",
          `key_file=${join(dstHome, ".oci/sessions/DEV/oci_api_key.pem")}`,
          "tenancy=ocid1.tenancy.oc1..roundtrip",
          "region=us-phoenix-1",
          `security_token_file=${join(dstHome, ".oci/sessions/DEV/token")}`,
          "",
        ].join("\n"),
      );
      expect(
        await readFile(
          join(dstHome, ".oci/sessions/DEV/oci_api_key.pem"),
          "utf8",
        ),
      ).toBe("EXPORTED-KEY-DATA\n");
      expect(
        await readFile(join(dstHome, ".oci/sessions/DEV/token"), "utf8"),
      ).toBe("exported.jwt.token");
      expect((await stat(dstCfg)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(join(dstHome, ".oci/sessions/DEV/oci_api_key.pem"))).mode &
          0o777,
      ).toBe(0o600);
      expect(
        (await stat(join(dstHome, ".oci/sessions/DEV/token"))).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await rm(srcHome, { recursive: true, force: true });
      await rm(dstHome, { recursive: true, force: true });
    }
  });

  test("fails cleanly when archive config references a file missing from the archive", async () => {
    const home = await mkdtemp(join(tmpdir(), "boci-sess-missing-"));
    try {
      await mkdir(join(home, ".oci"), { recursive: true });
      const zipPath = join(home, "broken.zip");
      await writeFile(
        zipPath,
        buildZip([
          {
            name: "config",
            data: Buffer.from(
              "[BROKEN]\nregion = us-phoenix-1\nsecurity_token_file = missing.tok\n",
            ),
          },
        ]),
      );
      const res = await runCliInHome(
        ["session", "import", "--session-archive", zipPath],
        home,
      );
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("FileNotFoundError:");
      expect(res.stderr).toContain("missing.tok");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

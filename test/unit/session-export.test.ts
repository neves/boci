import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import {
  formatConfigSection,
  translateConfigFilepathsToPrefix,
} from "../../src/commands/session.ts";
import { buildZip, readZip } from "../../src/lib/zip.ts";
import { setPosixMode } from "../../src/lib/posixMode.ts";

async function runExport(
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

describe("session export helpers", () => {
  test("translateConfigFilepathsToPrefix rewrites _file and _token keys only", () => {
    const input = new Map([
      ["region", "us-phoenix-1"],
      ["key_file", "~/.oci/sessions/dev/oci_api_key.pem"],
      ["security_token_file", "/tmp/tok/token"],
      ["custom_token", "nested/my.tok"],
      ["fingerprint", "aa:bb:cc"],
    ]);
    expect([...translateConfigFilepathsToPrefix(input)]).toEqual([
      ["region", "us-phoenix-1"],
      ["key_file", "oci_api_key.pem"],
      ["security_token_file", "token"],
      ["custom_token", "my.tok"],
      ["fingerprint", "aa:bb:cc"],
    ]);
    expect([...translateConfigFilepathsToPrefix(input, "/opt/sess")]).toEqual([
      ["region", "us-phoenix-1"],
      ["key_file", "/opt/sess/oci_api_key.pem"],
      ["security_token_file", "/opt/sess/token"],
      ["custom_token", "/opt/sess/my.tok"],
      ["fingerprint", "aa:bb:cc"],
    ]);
  });

  test("formatConfigSection matches CPython ConfigParser.write output", () => {
    const text = formatConfigSection(
      "SESSION",
      new Map([
        ["region", "us-phoenix-1"],
        ["key_file", "key.pem"],
        ["security_token_file", "token"],
      ]),
    );
    expect(text).toBe(
      "[SESSION]\nregion = us-phoenix-1\nkey_file = key.pem\nsecurity_token_file = token\n\n",
    );
  });

  test("buildZip and readZip round-trip entries, binary bytes, utf8 names, and modes", () => {
    const bin = new Uint8Array([0, 1, 2, 255, 128, 64, 0]);
    const zip = buildZip([
      { name: "config", data: Buffer.from("[DEFAULT]\n"), mode: 0o100644 },
      { name: "key.pem", data: bin, mode: 0o100600 },
      { name: "empty.txt", data: new Uint8Array(0), mode: 0o100640 },
      { name: "café.txt", data: Buffer.from("hello"), mode: 0o100644 },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "config",
      "key.pem",
      "empty.txt",
      "café.txt",
    ]);
    expect(entries[0]?.data.toString("utf8")).toBe("[DEFAULT]\n");
    expect(new Uint8Array(entries[1]!.data)).toEqual(bin);
    expect(entries[1]!.mode & 0o777).toBe(0o600);
    expect(entries[2]?.data.length).toBe(0);
    expect(entries[3]?.data.toString("utf8")).toBe("hello");
  });
});

describe("session export archive contents", () => {
  test("exports config, key, token, and custom _file/_token files with inherited DEFAULT keys", async () => {
    const dir = (
      await mkdtemp(join(tmpdir(), "boci-session-export-"))
    ).replaceAll("\\", "/");
    try {
      const ociDir = `${dir}/.oci`;
      await mkdir(ociDir, { recursive: true });
      const keyPath = `${ociDir}/oci_api_key.pem`;
      const tokPath = `${ociDir}/token`;
      const extraPath = `${ociDir}/extra.tok`;
      const cfgPath = `${ociDir}/config`;

      await writeFile(keyPath, "PRIVATE-KEY-BYTES\n");
      setPosixMode(keyPath, 0o600);
      await writeFile(tokPath, "jwt.payload.sig");
      setPosixMode(tokPath, 0o600);
      await writeFile(extraPath, "extra-token-bytes");
      setPosixMode(extraPath, 0o640);
      await writeFile(
        cfgPath,
        [
          "[DEFAULT]",
          "region=us-ashburn-1",
          "tenancy=ocid1.tenancy.oc1..abc",
          "",
          "[DEV]",
          "region=us-phoenix-1",
          "key_file=~/.oci/oci_api_key.pem",
          "security_token_file=~/.oci/token",
          "extra_token=~/.oci/extra.tok",
          "",
        ].join("\n"),
      );

      const res = await runExport(
        [
          "session",
          "export",
          "--profile",
          "DEV",
          "--output-file",
          "exports/dev-session",
        ],
        dir,
      );
      expect(res.exitCode).toBe(0);
      const zipPath = `${dir}/exports/dev-session.zip`;
      expect(res.stderr).toBe(
        `Exporting profile: DEV from config file: ${cfgPath}\nExport file written to: ${zipPath}\n`,
      );

      const entries = readZip(await readFile(zipPath));
      const byName = new Map(entries.map((e) => [e.name, e]));
      expect([...byName.keys()].sort()).toEqual([
        "config",
        "extra.tok",
        "oci_api_key.pem",
        "token",
      ]);
      expect(byName.get("config")?.data.toString("utf8")).toBe(
        [
          "[DEV]",
          "region = us-phoenix-1",
          "key_file = oci_api_key.pem",
          "security_token_file = token",
          "extra_token = extra.tok",
          "tenancy = ocid1.tenancy.oc1..abc",
          "",
          "",
        ].join("\n"),
      );
      expect(byName.get("oci_api_key.pem")?.data.toString("utf8")).toBe(
        "PRIVATE-KEY-BYTES\n",
      );
      expect(byName.get("oci_api_key.pem")!.mode & 0o777).toBe(0o600);
      expect(byName.get("token")?.data.toString("utf8")).toBe(
        "jwt.payload.sig",
      );
      expect(byName.get("extra.tok")?.data.toString("utf8")).toBe(
        "extra-token-bytes",
      );
      expect(byName.get("extra.tok")!.mode & 0o777).toBe(0o640);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

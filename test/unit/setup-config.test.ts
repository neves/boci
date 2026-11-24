import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import {
  PRIVATE_KEY_LABEL,
  publicKeyToFingerprint,
} from "../../src/commands/setup.ts";
import { loadPrivateKey } from "../../src/core/signer.ts";
import { getPosixMode, setPosixMode } from "../../src/lib/posixMode.ts";
import { FAKE, FAKE_KEY_PEM } from "../harness/sandbox.ts";

async function runConfig(
  home: string,
  stdin: string,
  opts: { ttyStdout?: boolean; env?: Record<string, string> } = {},
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv: ["setup", "config"],
    env: { HOME: home, LC_ALL: "C.UTF-8", ...opts.env },
    cwd: home,
    stdin,
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
    isTTY: (fd) => (fd === 1 ? Boolean(opts.ttyStdout) : false),
    columns: () => undefined,
  });
  return { stdout, stderr, exitCode };
}

describe("setup config", () => {
  test("creates a new config and key pair with matching fingerprint and permissions", async () => {
    const dir = (
      await mkdtemp(join(tmpdir(), "boci-setup-config-"))
    ).replaceAll("\\", "/");
    try {
      const stdin = [
        "",
        FAKE.user,
        FAKE.tenancy,
        "1",
        "",
        "",
        "",
        "N/A",
        "N/A",
        "",
      ].join("\n");
      const res = await runConfig(dir, stdin);
      expect(res.exitCode).toBe(0);

      const ociDir = `${dir}/.oci`;
      const configPath = `${ociDir}/config`;
      const pubPath = `${ociDir}/oci_api_key_public.pem`;
      const privPath = `${ociDir}/oci_api_key.pem`;

      expect(getPosixMode(ociDir)).toBe(0o700);
      expect(getPosixMode(configPath)).toBe(0o600);
      expect(getPosixMode(pubPath)).toBe(0o600);
      expect(getPosixMode(privPath)).toBe(0o600);

      const pubPem = await readFile(pubPath, "utf8");
      const privPem = await readFile(privPath, "utf8");
      expect(privPem.endsWith(PRIVATE_KEY_LABEL)).toBe(true);
      const loaded = loadPrivateKey(privPem, null);
      const expectedFp = publicKeyToFingerprint(createPublicKey(loaded));
      expect(publicKeyToFingerprint(createPublicKey(pubPem))).toBe(expectedFp);
      expect(res.stdout).toContain(`Fingerprint: ${expectedFp}\n`);

      const configText = await readFile(configPath, "utf8");
      expect(configText).toBe(
        [
          "[DEFAULT]",
          `user=${FAKE.user}`,
          `fingerprint=${expectedFp}`,
          `key_file=${privPath}`,
          `tenancy=${FAKE.tenancy}`,
          "region=af-casablanca-1",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes pass_phrase only when confirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-config-pass-"));
    try {
      const cfgWritten = join(dir, "with-pass");
      const stdinYes = [
        cfgWritten,
        FAKE.user,
        FAKE.tenancy,
        "us-ashburn-1",
        "y",
        join(dir, "k1"),
        "k",
        "s3cr3t",
        "s3cr3t",
        "y",
        "",
      ].join("\n");
      const r1 = await runConfig(dir, stdinYes);
      expect(r1.exitCode).toBe(0);
      const text1 = await readFile(cfgWritten, "utf8");
      expect(text1).toContain("pass_phrase=s3cr3t\n");
      const priv1 = await readFile(join(dir, "k1", "k.pem"), "utf8");
      expect(loadPrivateKey(priv1, "s3cr3t").asymmetricKeyType).toBe("rsa");

      const cfgOmitted = join(dir, "no-pass");
      const stdinNo = [
        cfgOmitted,
        FAKE.user,
        FAKE.tenancy,
        "us-ashburn-1",
        "y",
        join(dir, "k2"),
        "k",
        "s3cr3t",
        "s3cr3t",
        "n",
        "",
      ].join("\n");
      const r2 = await runConfig(dir, stdinNo);
      expect(r2.exitCode).toBe(0);
      const text2 = await readFile(cfgOmitted, "utf8");
      expect(text2).not.toContain("pass_phrase=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("appends a new profile with blank-line separator and overwrites when requested", async () => {
    const dir = (
      await mkdtemp(join(tmpdir(), "boci-setup-config-exist-"))
    ).replaceAll("\\", "/");
    try {
      const ociDir = `${dir}/.oci`;
      await mkdir(ociDir, { mode: 0o700 });
      setPosixMode(ociDir, 0o700);
      const keyPath = `${ociDir}/existing.pem`;
      await Bun.write(keyPath, `${FAKE_KEY_PEM.trimEnd()}`);
      setPosixMode(keyPath, 0o600);
      const configPath = `${ociDir}/config`;
      await Bun.write(configPath, "[DEFAULT]\nuser=old\n");

      const expectedFp = publicKeyToFingerprint(
        createPublicKey(loadPrivateKey(FAKE_KEY_PEM, null)),
      );

      // Append a new profile
      const addRes = await runConfig(
        dir,
        [
          "",
          "y",
          "DevProfile",
          FAKE.user,
          FAKE.tenancy,
          "us-phoenix-1",
          "n",
          keyPath,
          "",
        ].join("\n"),
      );
      expect(addRes.exitCode).toBe(0);
      const appended = await readFile(configPath, "utf8");
      expect(appended).toBe(
        [
          "[DEFAULT]",
          "user=old",
          "",
          "",
          "[DevProfile]",
          `user=${FAKE.user}`,
          `fingerprint=${expectedFp}`,
          `key_file=${keyPath}`,
          `tenancy=${FAKE.tenancy}`,
          "region=us-phoenix-1",
          "",
        ].join("\n"),
      );

      // Overwrite removes existing profiles and writes fresh [DEFAULT]
      const overwriteRes = await runConfig(
        dir,
        [
          "",
          "n",
          "y",
          FAKE.user,
          FAKE.tenancy,
          "us-ashburn-1",
          "n",
          keyPath,
          "",
        ].join("\n"),
      );
      expect(overwriteRes.exitCode).toBe(0);
      const overwritten = await readFile(configPath, "utf8");
      expect(overwritten).toBe(
        [
          "[DEFAULT]",
          `user=${FAKE.user}`,
          `fingerprint=${expectedFp}`,
          `key_file=${keyPath}`,
          `tenancy=${FAKE.tenancy}`,
          "region=us-ashburn-1",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("colors the unlabeled private key warning yellow only when stdout is a TTY", async () => {
    const dir = (
      await mkdtemp(join(tmpdir(), "boci-setup-config-tty-"))
    ).replaceAll("\\", "/");
    try {
      const keyPath = `${dir}/unlabeled.pem`;
      await Bun.write(keyPath, FAKE_KEY_PEM.replace(/OCI_API_KEY\s*$/, ""));

      const stdin = [
        join(dir, "cfg1"),
        FAKE.user,
        FAKE.tenancy,
        "us-ashburn-1",
        "n",
        keyPath,
        "",
      ].join("\n");
      const ttyRes = await runConfig(dir, stdin, { ttyStdout: true });
      expect(ttyRes.exitCode).toBe(0);
      expect(ttyRes.stdout).toContain(
        `\x1b[33mWarning: To increase security of your API key located at ${keyPath},`,
      );
      expect(ttyRes.stdout).toContain("\x1b[0m\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

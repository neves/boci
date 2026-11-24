import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey } from "node:crypto";
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

async function runKeys(argv: string[], home: string, stdin?: string) {
  let stdout = "";
  let stderr = "";
  const exitCode = await run({
    argv,
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

describe("setup keys", () => {
  test("generates an unencrypted 2048-bit RSA key pair with label and matching fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-keys-"));
    try {
      const outDir = join(dir, "keys");
      const res = await runKeys(
        ["setup", "keys", "--output-dir", outDir],
        dir,
        "N/A\nN/A\n",
      );
      expect(res.exitCode).toBe(0);
      expect(getPosixMode(outDir)).toBe(0o700);

      const pubPath = join(outDir, "oci_api_key_public.pem");
      const privPath = join(outDir, "oci_api_key.pem");
      expect(getPosixMode(pubPath)).toBe(0o600);
      expect(getPosixMode(privPath)).toBe(0o600);

      const pubPem = await readFile(pubPath, "utf8");
      const privPem = await readFile(privPath, "utf8");
      expect(pubPem.startsWith("-----BEGIN PUBLIC KEY-----\n")).toBe(true);
      expect(privPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
      expect(
        privPem.endsWith(`-----END PRIVATE KEY-----\n${PRIVATE_KEY_LABEL}`),
      ).toBe(true);

      const loadedPriv = loadPrivateKey(privPem, null);
      expect(loadedPriv.asymmetricKeyType).toBe("rsa");
      expect(loadedPriv.asymmetricKeyDetails?.modulusLength).toBe(2048);

      const derivedPubPem = createPublicKey(loadedPriv)
        .export({ type: "spki", format: "pem" })
        .toString();
      expect(derivedPubPem).toBe(pubPem);

      const pubObj = createPublicKey(pubPem);
      const expectedFp =
        createHash("md5")
          .update(pubObj.export({ type: "spki", format: "der" }))
          .digest("hex")
          .match(/../g)
          ?.join(":") ?? "";
      expect(publicKeyToFingerprint(pubObj)).toBe(expectedFp);
      expect(res.stdout).toContain(`Public key fingerprint: ${expectedFp}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("encrypts private key with --passphrase and decrypts only with the right passphrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-keys-enc-"));
    try {
      const outDir = join(dir, "keys");
      const res = await runKeys(
        [
          "setup",
          "keys",
          "--output-dir",
          outDir,
          "--key-name",
          "enc_key",
          "--passphrase",
          "s3cr3t!",
        ],
        dir,
      );
      expect(res.exitCode).toBe(0);

      const pubPem = await readFile(join(outDir, "enc_key_public.pem"), "utf8");
      const privPem = await readFile(join(outDir, "enc_key.pem"), "utf8");
      expect(
        privPem.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----\n"),
      ).toBe(true);
      expect(
        privPem.endsWith(
          `-----END ENCRYPTED PRIVATE KEY-----\n${PRIVATE_KEY_LABEL}`,
        ),
      ).toBe(true);

      const loaded = loadPrivateKey(privPem, "s3cr3t!");
      expect(
        createPublicKey(loaded)
          .export({ type: "spki", format: "pem" })
          .toString(),
      ).toBe(pubPem);
      expect(() => loadPrivateKey(privPem, "wrong")).toThrow();
      expect(() => loadPrivateKey(privPem, null)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches Python readline() for --passphrase-file (including trailing newline)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-keys-pf-"));
    try {
      const withNl = join(dir, "with-nl.txt");
      const withoutNl = join(dir, "without-nl.txt");
      await Bun.write(withNl, "first-line\nsecond-line\n");
      await Bun.write(withoutNl, "bare-secret");

      const r1 = await runKeys(
        [
          "setup",
          "keys",
          "--output-dir",
          join(dir, "k1"),
          "--passphrase-file",
          withNl,
        ],
        dir,
      );
      expect(r1.exitCode).toBe(0);
      const priv1 = await readFile(join(dir, "k1", "oci_api_key.pem"), "utf8");
      expect(() => loadPrivateKey(priv1, "first-line")).toThrow();
      expect(loadPrivateKey(priv1, "first-line\n").asymmetricKeyType).toBe(
        "rsa",
      );

      const r2 = await runKeys(
        [
          "setup",
          "keys",
          "--output-dir",
          join(dir, "k2"),
          "--passphrase-file",
          withoutNl,
        ],
        dir,
      );
      expect(r2.exitCode).toBe(0);
      const priv2 = await readFile(join(dir, "k2", "oci_api_key.pem"), "utf8");
      expect(loadPrivateKey(priv2, "bare-secret").asymmetricKeyType).toBe(
        "rsa",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves existing directory mode and relative ./ prefix in output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boci-setup-keys-dir-"));
    try {
      const existing = join(dir, "existing");
      await mkdir(existing, { mode: 0o755 });
      setPosixMode(existing, 0o755);

      const res = await runKeys(
        [
          "setup",
          "keys",
          "--output-dir",
          "./existing",
          "--passphrase",
          "mysecret",
        ],
        dir,
      );
      expect(res.exitCode).toBe(0);
      expect(getPosixMode(existing)).toBe(0o755);
      expect(res.stdout).toContain(
        "Public key written to: ./existing/oci_api_key_public.pem\n",
      );
      expect(res.stdout).toContain(
        "Private key written to: ./existing/oci_api_key.pem\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

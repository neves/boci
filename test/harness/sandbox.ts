// Isolated HOME + OCI config signed with a committed throwaway key, so no test
// ever reads the real ~/.oci or needs real credentials.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "../../src/lib/zip.ts";
import { setPosixMode } from "../../src/lib/posixMode.ts";

export const FAKE = {
  tenancy:
    "ocid1.tenancy.oc1..aaaaaaaabocifaketenancy0000000000000000000000000000000000",
  user: "ocid1.user.oc1..aaaaaaaabocifakeuser000000000000000000000000000000000000000",
  region: "us-ashburn-1",
} as const;

const KEY_SOURCE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "fake_oci_api_key.pem",
);
export const FAKE_KEY_PEM = await Bun.file(KEY_SOURCE).text();

export async function fingerprint(keyFile: string): Promise<string> {
  const der = createPublicKey(await Bun.file(keyFile).text()).export({
    type: "spki",
    format: "der",
  });
  const hex = new Bun.CryptoHasher("md5").update(der).digest("hex");
  return hex.match(/../g)?.join(":") ?? "";
}

/**
 * Safety net: anything that is not the local fake endpoint goes to a dead proxy and fails at
 * once, so a case that accidentally reaches a real OCI endpoint can't leave the machine.
 * Both python-requests and Bun's fetch honour these.
 */
export const PROXY_ENV = {
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
} as const;

export type Sandbox = {
  home: string;
  configFile: string;
  keyFile: string;
  /** Environment for spawning either CLI: isolated HOME, no inherited OCI_* settings. */
  env: Record<string, string>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type SandboxOptions = {
  /** false: write the API key without the trailing OCI_API_KEY label line. */
  keyLabel?: boolean;
  /** Encrypt the sandbox API key with this passphrase. */
  keyPassphrase?: string;
  /** PEM format when keyPassphrase is set (default: "pkcs8"). */
  keyFormat?: "pkcs8" | "pkcs1";
  /** Extra files to create, relative to the sandbox HOME (e.g. ".oci/oci_cli_rc"). */
  files?: Record<string, string>;
  /** Extra ZIP archives to create, relative to the sandbox HOME: `{ "a.zip": { "config": "..." } }`. */
  zipFiles?: Record<string, Record<string, string>>;
  /** Optional Unix mode overrides for extra sandbox files (default 0o600). */
  fileModes?: Record<string, number>;
  /** true: omit ~/.oci/config and ~/.oci/key.pem (e.g. for instance/resource principal tests). */
  noConfig?: boolean;
  configMode?: number;
  keyMode?: number;
};

const keyFingerprints = new Map<string, Promise<string>>();

export async function createSandbox(
  extraConfig = "",
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const rawHome = await mkdtemp(join(tmpdir(), "boci-sandbox-"));
  const home = (await realpath(rawHome)).replaceAll("\\", "/");
  const dir = `${home}/.oci`;
  await mkdir(dir, { mode: 0o700 });
  setPosixMode(dir, 0o700);
  const keyFile = `${dir}/key.pem`;
  const configFile = `${dir}/config`;
  if (!options.noConfig) {
    let key = FAKE_KEY_PEM;
    if (options.keyPassphrase !== undefined) {
      const exported = createPrivateKey(FAKE_KEY_PEM.trim())
        .export({
          type: options.keyFormat ?? "pkcs8",
          format: "pem",
          cipher: "aes-256-cbc",
          passphrase: options.keyPassphrase,
        })
        .toString();
      key = `${exported}OCI_API_KEY\n`;
    }
    await Bun.write(
      keyFile,
      options.keyLabel === false ? key.replace(/OCI_API_KEY\s*$/, "") : key,
    );
    await Bun.write(
      configFile,
      `[DEFAULT]\nuser=${FAKE.user}\nfingerprint=${await keyFingerprint(KEY_SOURCE, options.keyLabel)}\ntenancy=${FAKE.tenancy}\nregion=${FAKE.region}\nkey_file=${keyFile}\n${extraConfig}`,
    );
    setPosixMode(keyFile, options.keyMode ?? 0o600);
    setPosixMode(configFile, options.configMode ?? 0o600);
  }
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const path = `${home}/${rel}`;
    await Bun.write(
      path,
      content.replaceAll("{home}", home).replaceAll("{fakeKey}", FAKE_KEY_PEM),
    );
    setPosixMode(path, options.fileModes?.[rel] ?? 0o600);
  }
  for (const [rel, entries] of Object.entries(options.zipFiles ?? {})) {
    const path = `${home}/${rel}`;
    const zipEntries = Object.entries(entries).map(([name, content]) => ({
      name,
      data: Buffer.from(
        content
          .replaceAll("{home}", home)
          .replaceAll("{fakeKey}", FAKE_KEY_PEM),
        "utf8",
      ),
    }));
    await Bun.write(path, buildZip(zipEntries));
    setPosixMode(path, options.fileModes?.[rel] ?? 0o600);
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OCI_") && !k.startsWith("BOCI_"))
      env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    ...PROXY_ENV,
  });

  return {
    home,
    configFile,
    keyFile,
    env,
    async [Symbol.asyncDispose]() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** The fake key's fingerprint, computed once per key variant (the label doesn't change it). */
function keyFingerprint(keyFile: string, label = true): Promise<string> {
  const id = String(label);
  let fp = keyFingerprints.get(id);
  if (!fp) {
    fp = fingerprint(keyFile);
    keyFingerprints.set(id, fp);
  }
  return fp;
}

const shared = new Map<string, Promise<Sandbox>>();

/**
 * One sandbox per distinct config and options, reused for the life of the process (for
 * runs that only read it, like boci's). Removed by disposeSharedSandboxes().
 */
export function sharedSandbox(
  extraConfig = "",
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const id = JSON.stringify([extraConfig, options]);
  let sb = shared.get(id);
  if (!sb) {
    sb = createSandbox(extraConfig, options);
    shared.set(id, sb);
  }
  return sb;
}

export async function disposeSharedSandboxes(): Promise<void> {
  const all = [...shared.values()];
  shared.clear();
  await Promise.all(all.map(async (sb) => (await sb)[Symbol.asyncDispose]()));
}

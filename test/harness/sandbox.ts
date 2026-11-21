// Isolated HOME + OCI config signed with a committed throwaway key, so no test
// ever reads the real ~/.oci or needs real credentials.
import { createPublicKey } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export async function fingerprint(keyFile: string): Promise<string> {
  const der = createPublicKey(await Bun.file(keyFile).text()).export({
    type: "spki",
    format: "der",
  });
  const hex = new Bun.CryptoHasher("md5").update(der).digest("hex");
  return hex.match(/../g)?.join(":") ?? "";
}

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
  /** Extra files to create, relative to the sandbox HOME (e.g. ".oci/oci_cli_rc"). */
  files?: Record<string, string>;
  configMode?: number;
  keyMode?: number;
};

export async function createSandbox(
  extraConfig = "",
  options: SandboxOptions = {},
): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "boci-sandbox-"));
  const dir = join(home, ".oci");
  await mkdir(dir, { mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const configFile = join(dir, "config");
  const key = await Bun.file(KEY_SOURCE).text();
  await Bun.write(
    keyFile,
    options.keyLabel === false ? key.replace(/OCI_API_KEY\s*$/, "") : key,
  );
  await Bun.write(
    configFile,
    `[DEFAULT]\nuser=${FAKE.user}\nfingerprint=${await fingerprint(keyFile)}\ntenancy=${FAKE.tenancy}\nregion=${FAKE.region}\nkey_file=${keyFile}\n${extraConfig}`,
  );
  await chmod(keyFile, options.keyMode ?? 0o600);
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const path = join(home, rel);
    await Bun.write(path, content.replaceAll("{home}", home));
    await chmod(path, 0o600);
  }
  await chmod(configFile, options.configMode ?? 0o600);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OCI_") && !k.startsWith("BOCI_"))
      env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    // Safety net: anything that is not the local fake endpoint goes to a dead proxy and
    // fails at once, so a case that accidentally reaches a real OCI endpoint can't leave
    // the machine. Both python-requests and Bun's fetch honour these.
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
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

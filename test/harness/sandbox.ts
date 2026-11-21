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

export async function createSandbox(extraConfig = ""): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "boci-sandbox-"));
  const dir = join(home, ".oci");
  await mkdir(dir, { mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const configFile = join(dir, "config");
  await Bun.write(keyFile, Bun.file(KEY_SOURCE));
  await Bun.write(
    configFile,
    `[DEFAULT]\nuser=${FAKE.user}\nfingerprint=${await fingerprint(keyFile)}\ntenancy=${FAKE.tenancy}\nregion=${FAKE.region}\nkey_file=${keyFile}\n${extraConfig}`,
  );
  await chmod(keyFile, 0o600);
  await chmod(configFile, 0o600);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OCI_") && !k.startsWith("BOCI_"))
      env[k] = v;
  }
  Object.assign(env, { HOME: home, LC_ALL: "C.UTF-8", TZ: "UTC" });

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

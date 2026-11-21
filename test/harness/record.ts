// Live Recordings: run the Reference CLI against the real account with the
// sitecustomize hook (tools/record), then scrub identifying values before saving.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIS } from "./runner.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const RECORDINGS_DIR = join(ROOT, "test", "recordings");

export const FAKE_NAMESPACE = "bocifakens";
export const FAKE_FINGERPRINT =
  "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00";

type Body = { text?: string; base64?: string; stream?: boolean };
export type Exchange = {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Body;
  };
  response: { status: number; headers: Record<string, string>; body: Body };
};
export type Recording = {
  id: string;
  argv: string[];
  referenceVersion: string;
  exchanges: Exchange[];
};

const OCID =
  /ocid1\.([a-z0-9_]+)\.([a-z0-9]+)\.([a-z0-9-]*)\.([A-Za-z0-9_-]+)/g;

/** Same type/realm/region/length, deterministic fake unique part. */
export function scrubOcid(ocid: string): string {
  return ocid.replace(
    OCID,
    (_m, type: string, realm: string, region: string, unique: string) => {
      let fake = "boci";
      for (let i = 0; fake.length < unique.length; i++) {
        fake += Bun.hash(`${unique}:${i}`).toString(36);
      }
      return `ocid1.${type}.${realm}.${region}.${fake.slice(0, unique.length)}`;
    },
  );
}

export type Secrets = { namespace?: string; fingerprint?: string };

export function scrub(text: string, secrets: Secrets): string {
  // Real signatures are useless after the clock-skew window, but never publish them.
  let out = scrubOcid(text).replace(
    /signature=\\?"[A-Za-z0-9+/=]+\\?"/g,
    'signature=\\"scrubbed\\"',
  );
  if (secrets.fingerprint)
    out = out.replaceAll(secrets.fingerprint, FAKE_FINGERPRINT);
  if (secrets.namespace) {
    const ns = secrets.namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9])${ns}(?![A-Za-z0-9])`, "g"),
      FAKE_NAMESPACE,
    );
  }
  return out;
}

/** Run the Reference CLI live with the given profile and capture its HTTP exchanges. */
export async function recordLive(argv: string[], profile: string) {
  const dir = await mkdtemp(join(tmpdir(), "boci-record-"));
  const file = join(dir, "exchanges.jsonl");
  try {
    const proc = Bun.spawn([...CLIS.oci, ...argv, "--profile", profile], {
      env: {
        ...process.env,
        PYTHONPATH: join(ROOT, "tools", "record"),
        BOCI_RECORD_FILE: file,
        OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const f = Bun.file(file);
    const exchanges = (await f.exists())
      ? ((await f.text())
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)) as Exchange[])
      : [];
    return { stdout, stderr, exitCode, exchanges };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

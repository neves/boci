import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECORDINGS_DIR, recordLive, scrub } from "../harness/record.ts";

const profile = Bun.env.BOCI_TEST_PROFILE;
const ROOT = join(import.meta.dir, "..", "..");
const TEST_TAG = { "boci-parity": "true" };

type LiveRun = { stdout: string; stderr: string; exitCode: number };

async function runBoci(argv: string[]): Promise<LiveRun> {
  const proc = Bun.spawn(["bun", join(ROOT, "src", "main.ts"), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function profileValue(config: string, name: string, key: string): string {
  const section =
    config.split(/^\[/m).find((part) => part.startsWith(`${name}]`)) ?? "";
  const value = new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m").exec(section)?.[1];
  if (!value) throw new Error(`${key} missing from OCI profile ${name}`);
  return value;
}

async function taggedBucket(namespace: string, name: string): Promise<boolean> {
  const run = await recordLive(
    [
      "os",
      "bucket",
      "get",
      "--namespace-name",
      namespace,
      "--name",
      name,
      "--no-retry",
    ],
    profile!,
  );
  if (run.exitCode !== 0) return false;
  const bucket = JSON.parse(run.stdout) as {
    data?: { "freeform-tags"?: Record<string, string> };
  };
  return bucket.data?.["freeform-tags"]?.["boci-parity"] === "true";
}

async function deleteTaggedBucket(namespace: string, name: string) {
  if (!(await taggedBucket(namespace, name))) return;
  const run = await recordLive(
    [
      "os",
      "bucket",
      "delete",
      "--namespace-name",
      namespace,
      "--name",
      name,
      "--force",
      "--no-retry",
    ],
    profile!,
  );
  expect(run.exitCode).toBe(0);
}

// Live: runs only via `bun run parity:live` (BOCI_LIVE=1). Bun auto-loads .env.test
// under `bun test`, so the profile alone must not enable network calls.
test.skipIf(!Bun.env.BOCI_LIVE)(
  "curated live list/get recordings",
  async () => {
    if (!profile) throw new Error("BOCI_TEST_PROFILE must be set in .env.test");
    const config = await Bun.file(join(homedir(), ".oci", "config")).text();
    const section =
      config.split(/^\[/m).find((s) => s.startsWith(`${profile}]`)) ?? "";
    const fingerprint = /^fingerprint\s*=\s*(\S+)/m.exec(section)?.[1];

    // Region enumeration is tenant independent. The get is targeted at OCI's
    // stable capability schema singleton and does not create or modify resources.
    const commands = [["iam-region-list", ["iam", "region", "list"]]] as const;

    // Discover and scrub namespace using an approved live read before recording
    // any command that could include it in headers or payloads.
    const ns = await recordLive(["os", "ns", "get"], profile);
    expect(ns.exitCode).toBe(0);
    const namespace = (JSON.parse(ns.stdout) as { data: string }).data;
    const recordings = [
      ...commands.map(([id, argv]) => ({ id, argv })),
      { id: "os-ns-get", argv: ["os", "ns", "get"] },
    ];
    for (const { id, argv } of recordings) {
      const run = await recordLive([...argv], profile);
      expect(run.exitCode).toBe(0);
      const text = scrub(
        JSON.stringify(
          { id, argv, referenceVersion: "3.96.3", exchanges: run.exchanges },
          null,
          2,
        ),
        { namespace, fingerprint },
      );
      expect(text).not.toContain(namespace);
      if (fingerprint) expect(text).not.toContain(fingerprint);
      await Bun.write(join(RECORDINGS_DIR, `${id}.json`), `${text}\n`);
    }
  },
);

test.skipIf(!Bun.env.BOCI_LIVE)(
  "boci creates a tagged Always-Free bucket in the root compartment and cleans it up",
  async () => {
    if (!profile) throw new Error("BOCI_TEST_PROFILE must be set in .env.test");
    const config = await Bun.file(join(homedir(), ".oci", "config")).text();
    const compartmentId = profileValue(config, profile, "tenancy");
    const namespaceRun = await recordLive(
      ["os", "ns", "get", "--no-retry"],
      profile,
    );
    expect(namespaceRun.exitCode).toBe(0);
    const namespace = (JSON.parse(namespaceRun.stdout) as { data: string })
      .data;
    const name = `boci-parity-${Bun.randomUUIDv7().toLowerCase()}`;

    try {
      const created = await runBoci([
        "os",
        "bucket",
        "create",
        "--name",
        name,
        "--namespace-name",
        namespace,
        "--compartment-id",
        compartmentId,
        "--freeform-tags",
        JSON.stringify(TEST_TAG),
        "--profile",
        profile,
        "--no-retry",
      ]);
      expect(created.exitCode, created.stderr).toBe(0);
      expect(await taggedBucket(namespace, name)).toBe(true);
    } finally {
      await deleteTaggedBucket(namespace, name);
    }
  },
  60_000,
);

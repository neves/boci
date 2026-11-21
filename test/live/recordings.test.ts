import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECORDINGS_DIR, recordLive, scrub } from "../harness/record.ts";

const profile = Bun.env.BOCI_TEST_PROFILE;

test("curated live list/get recordings", async () => {
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
});

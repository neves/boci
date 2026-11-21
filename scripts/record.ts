// `bun run record <id> -- <oci args...>`: record a live Reference CLI run against the
// profile in .env.test and save it, scrubbed, to test/recordings/<id>.json.
// Recordings are committed to a public repo: record only read-only commands on
// resources whose names are fine to publish, and review the file before committing.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  RECORDINGS_DIR,
  type Recording,
  recordLive,
  scrub,
} from "../test/harness/record.ts";
import { CLIS } from "../test/harness/runner.ts";

const sep = Bun.argv.indexOf("--");
const id = Bun.argv[2];
if (!id || sep === -1 || !/^[\w.-]+$/.test(id)) {
  console.error("usage: bun run record <id> -- <oci args...>");
  process.exit(2);
}
const argv = Bun.argv.slice(sep + 1);
const profile = Bun.env.BOCI_TEST_PROFILE;
if (!profile)
  throw new Error(
    "BOCI_TEST_PROFILE missing: run via `bun run record` (loads .env.test)",
  );

// Secrets to scrub: the profile's fingerprint and the tenancy's namespace.
const config = await Bun.file(join(homedir(), ".oci", "config")).text();
const section =
  config.split(/^\[/m).find((s) => s.startsWith(`${profile}]`)) ?? "";
const fingerprint = /^fingerprint\s*=\s*(\S+)/m.exec(section)?.[1];
const ns = await recordLive(["os", "ns", "get"], profile);
const namespace = (JSON.parse(ns.stdout) as { data: string }).data;

const run = await recordLive(argv, profile);
if (run.exitCode !== 0)
  console.error(`warning: oci exited ${run.exitCode}\n${run.stderr}`);
const recording: Recording = {
  id,
  argv,
  referenceVersion: (await Bun.$`${CLIS.oci} --version`.text()).trim(),
  exchanges: run.exchanges,
};
const text = scrub(JSON.stringify(recording, null, 2), {
  namespace,
  fingerprint,
});
for (const secret of [namespace, fingerprint]) {
  if (secret && text.includes(secret))
    throw new Error("scrub failed: a secret is still present");
}
await Bun.write(join(RECORDINGS_DIR, `${id}.json`), `${text}\n`);
console.log(
  `recorded ${run.exchanges.length} exchange(s) → test/recordings/${id}.json`,
);

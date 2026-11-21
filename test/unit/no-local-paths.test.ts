import { expect, test } from "bun:test";
import { homedir } from "node:os";

// Extracted data, fixtures, goldens and recordings are committed to a public repo: they
// must never carry this machine's home directory (e.g. from Python's expanduser).
test("committed data contains no local home path", async () => {
  const home = homedir();
  const offenders: string[] = [];
  const root = `${import.meta.dir}/../..`;
  for (const dir of [
    "spec",
    "test/fixtures",
    "test/parity",
    "test/recordings",
    "bench/results",
  ]) {
    for await (const file of new Bun.Glob("**/*.{json,md}").scan(
      `${root}/${dir}`,
    )) {
      if ((await Bun.file(`${root}/${dir}/${file}`).text()).includes(home))
        offenders.push(`${dir}/${file}`);
    }
  }
  expect(offenders).toEqual([]);
});

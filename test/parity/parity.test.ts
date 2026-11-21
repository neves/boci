// Parity: boci against the Reference CLI's goldens. Never runs the Reference CLI (ADR 0004).
// Cases whose key boci doesn't implement yet are skipped (and recorded as not passing);
// once a key is implemented, every case for it must match its golden.
import { afterAll, describe, expect, test } from "bun:test";
import { isImplemented } from "../../src/registry.ts";
import {
  caseHash,
  loadCases,
  loadGolden,
  RESULTS_FILE,
} from "../harness/cases.ts";
import { normalizeRun, remask } from "../harness/compare.ts";
import { CLIS, runCli } from "../harness/runner.ts";

const cases = await loadCases();
const results: Record<string, { pass: boolean }> = {};
const record = (key: string, pass: boolean) => {
  // A key is verified only if all of its cases pass.
  results[key] = { pass: (results[key]?.pass ?? true) && pass };
};

describe("parity", () => {
  for (const c of cases) {
    const implemented = isImplemented(c.key);
    test.skipIf(!implemented)(`${c.id} (${c.key})`, async () => {
      const golden = await loadGolden(c);
      expect(
        golden,
        `missing golden: run \`bun run golden --filter ${c.id}\``,
      ).toBeDefined();
      expect(
        golden?.caseHash,
        `stale golden: run \`bun run golden --filter ${c.id}\``,
      ).toBe(caseHash(c));
      const run = await runCli(CLIS.boci, c.argv, c);
      try {
        expect(normalizeRun(run)).toEqual(
          remask(golden?.observed as never) as never,
        );
        record(c.key, true);
      } catch (e) {
        record(c.key, false);
        throw e;
      }
    });
    if (!implemented) record(c.key, false);
  }
});

afterAll(async () => {
  // Merge, so running a subset of tests doesn't forget other keys.
  const file = Bun.file(RESULTS_FILE);
  const previous = (await file.exists()) ? await file.json() : {};
  const merged = Object.fromEntries(
    Object.entries({ ...previous, ...results }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  await Bun.write(RESULTS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
});

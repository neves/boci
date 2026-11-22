// Parity cases and their goldens (ADR 0004).
//  - test/parity/cases/*.json: arrays of ParityCase, hand-written or generated.
//  - test/parity/golden/<id>.json: the Reference CLI's normalised observation for that case.
import { join } from "node:path";
import type { NormalizedRun } from "./compare.ts";
import type { Reply } from "./fake-endpoint.ts";

export const PARITY_DIR = join(import.meta.dir, "..", "parity");
export const CASES_DIR = join(PARITY_DIR, "cases");
export const GOLDEN_DIR = join(PARITY_DIR, "golden");
export const RESULTS_FILE = join(PARITY_DIR, "results.json");

export type ParityCase = {
  /** Unique, filename-safe. */
  id: string;
  /** What the case verifies: a Leaf command path ("os ns get") or an Engine feature ("--version"). */
  key: string;
  argv: string[];
  replies?: Reply | Reply[];
  stdin?: string;
  env?: Record<string, string>;
  config?: string;
  sandbox?: { keyLabel?: boolean; files?: Record<string, string> };
  /** Compare only exit status and the signed HTTP request captured by the fake endpoint. */
  requestOnly?: boolean;
  /** Extra assertions on boci's run. Excluded from caseHash: adding them never stales a golden. */
  expect?: CaseExpectations;
};

export type CaseExpectations = {
  /** false: skip signature checks and the golden comparison; only these checks decide the case.
   * For output the golden can't pin (debug logs, timeout tracebacks). */
  golden?: false;
  exitCode?: number;
  /** Exact stdout. */
  stdout?: string;
  stdoutContains?: string;
  stderrContains?: string;
  /** Regex sources, each matched against stderr. */
  stderrMatches?: string[];
  /** Number of requests the fake endpoint captured. */
  requests?: number;
  /** Headers expected on the first captured request. */
  requestHeaders?: Record<string, string>;
};

export type Golden = {
  /** Hash of the case definition; a mismatch means the golden is stale. */
  caseHash: string;
  referenceVersion: string;
  observed: NormalizedRun;
};

export function caseHash(c: ParityCase): string {
  const { id: _id, key: _key, expect: _expect, ...inputs } = c;
  return Bun.hash(JSON.stringify(inputs)).toString(16);
}

/** Case files written by scripts/generate-*-cases.ts; their case ids share the prefix. */
export const isGeneratedCaseFile = (file: string) =>
  file.startsWith("generated-");

/** Generated cases run only when this is set (`bun run verify` sets it). */
export const includeGeneratedCases = () => Bun.env.BOCI_PARITY_ALL === "1";

export async function loadCases({ generated = true } = {}): Promise<
  ParityCase[]
> {
  const cases: ParityCase[] = [];
  for await (const file of new Bun.Glob("**/*.json").scan(CASES_DIR)) {
    if (!generated && isGeneratedCaseFile(file)) continue;
    cases.push(
      ...((await Bun.file(join(CASES_DIR, file)).json()) as ParityCase[]),
    );
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate parity case id: ${c.id}`);
    if (!/^[\w.-]+$/.test(c.id))
      throw new Error(`parity case id not filename-safe: ${c.id}`);
    seen.add(c.id);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export const goldenPath = (id: string) => join(GOLDEN_DIR, `${id}.json`);

export async function loadGolden(c: ParityCase): Promise<Golden | undefined> {
  const file = Bun.file(goldenPath(c.id));
  return (await file.exists()) ? ((await file.json()) as Golden) : undefined;
}

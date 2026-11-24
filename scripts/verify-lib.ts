// Change-aware test and parity selection for `bun run verify`.
// Classifies a set of changed files into the minimal unit tests and parity scope
// needed to verify the iteration, while escalating to broader or full sweeps
// whenever shared engine rules, specs, or build inputs change.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  isGeneratedCaseFile,
  type ParityCase,
  type ParityCaseWithFile,
} from "../test/harness/cases.ts";

export type ParityMode = "none" | "scoped" | "sample" | "full";

export type VerifyPlan = {
  mode: ParityMode;
  reason: string;
  needsBuild: boolean;
  allUnitTests: boolean;
  unitFiles: string[];
  parityFiles: string[];
  parityIds: string[];
  parityServices: string[];
  parityKeys: string[];
};

export type PlanOptions = {
  full?: boolean;
  hasResultsFile?: boolean;
  registryDiff?: string;
  reverseImports?: Map<string, Set<string>>;
  availableUnitTests?: Set<string>;
};

const MODE_RANK: Record<ParityMode, number> = {
  none: 0,
  scoped: 1,
  sample: 2,
  full: 3,
};

function maxMode(a: ParityMode, b: ParityMode): ParityMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

/**
 * Checks whether a unified diff of `src/core/registry.ts` modifies the generic
 * engine implementation rules (`programmed`, `engineSupports`, `requestSupported`,
 * `isImplemented`, `implementedLookup`) rather than command registrations.
 */
export function didRegistryRuleChange(diffText: string): boolean {
  if (!diffText.trim()) return false;
  const ruleIdentifiers =
    /\b(WRITE_METHODS|programmed|engineSupports|requestSupported|isImplemented|implementedLookup)\b/;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")) &&
      ruleIdentifiers.test(line)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts service names and command/feature keys added or removed in a unified
 * diff of `src/core/registry.ts`.
 */
export function extractRegistryTouched(diffText: string): {
  services: string[];
  keys: string[];
} {
  const services = new Set<string>();
  const keys = new Set<string>();
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    for (const match of line.matchAll(
      /\.\.\/commands\/([a-z0-9_-]+)(?:\/|\.ts\b)/g,
    )) {
      const svc = match[1];
      if (svc && svc !== "update") services.add(svc);
    }
    for (const match of line.matchAll(/["']([a-z0-9][a-z0-9 _:-]*)["']/g)) {
      const candidate = match[1]?.trim() ?? "";
      if (!candidate) continue;
      if (candidate.includes(" ")) {
        keys.add(candidate);
        const svc = candidate.split(" ")[0];
        if (svc) services.add(svc);
      } else if (
        candidate.startsWith("--") ||
        candidate.includes(":") ||
        candidate.includes("-")
      ) {
        keys.add(candidate);
      }
    }
  }
  return {
    services: [...services].sort(),
    keys: [...keys].sort(),
  };
}

/**
 * Builds a reverse relative-import graph across `src/`, `scripts/`, `test/harness/`,
 * and `test/unit/`, isolating command dispatch hubs so editing one command does not
 * fan out into unrelated commands' unit tests.
 */
export function buildReverseImportGraph(
  root = join(import.meta.dir, ".."),
): Map<string, Set<string>> {
  const reverseDeps = new Map<string, Set<string>>();
  for (const dir of ["src", "scripts", "test/harness", "test/unit"]) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    for (const rel of new Bun.Glob("**/*.ts").scanSync(absDir)) {
      const file = `${dir}/${rel.replaceAll("\\", "/")}`;
      const txt = readFileSync(join(root, file), "utf8");
      for (const m of txt.matchAll(
        /(?:from|import)\s*\(?["'](\.[^"']+)["']\)?/g,
      )) {
        const spec = m[1];
        if (!spec) continue;
        const target = normalize(join(dirname(file), spec)).replaceAll(
          "\\",
          "/",
        );
        // Dispatch hubs: do not propagate from a command back through registry.ts/cli.ts
        if (
          (file === "src/core/registry.ts" || file === "src/core/cli.ts") &&
          target.startsWith("src/commands/")
        ) {
          continue;
        }
        // Core edits shouldn't fan out through command implementations into command unit tests
        if (
          file.startsWith("src/commands/") &&
          !target.startsWith("src/commands/")
        ) {
          continue;
        }
        // cli.ts is imported by command unit tests as an entry point; handle cli.ts explicitly
        if (file === "src/core/cli.ts") continue;

        let set = reverseDeps.get(target);
        if (!set) {
          set = new Set();
          reverseDeps.set(target, set);
        }
        set.add(file);
      }
    }
  }
  return reverseDeps;
}

function findTransitiveUnitTests(
  startFile: string,
  reverseDeps: Map<string, Set<string>>,
): string[] {
  const visited = new Set<string>([startFile]);
  const queue = [startFile];
  const units = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.startsWith("test/unit/") && cur.endsWith(".test.ts")) {
      units.add(cur);
    }
    for (const importer of reverseDeps.get(cur) ?? []) {
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
    }
  }
  return [...units];
}

function listAvailableUnitTests(
  root = join(import.meta.dir, ".."),
): Set<string> {
  const dir = join(root, "test", "unit");
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `test/unit/${f}`),
  );
}

const DOCS_ONLY_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GLOSSARY.md",
  "README.md",
  "LICENSE",
  "TODO.md",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  "mise.toml",
]);

const FULL_TRIGGER_FILES = new Set([
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "bunfig.toml",
  "scripts/build.ts",
]);

export function planVerification(
  changedFiles: string[],
  opts: PlanOptions = {},
): VerifyPlan {
  const hasResultsFile = opts.hasResultsFile ?? true;
  const normalized = [
    ...new Set(
      changedFiles.map((f) => f.trim().replaceAll("\\", "/")).filter(Boolean),
    ),
  ].sort();

  const fullPlan = (reason: string): VerifyPlan => ({
    mode: "full",
    reason,
    needsBuild: true,
    allUnitTests: true,
    unitFiles: [],
    parityFiles: [],
    parityIds: [],
    parityServices: [],
    parityKeys: [],
  });

  if (opts.full) return fullPlan("--full requested");
  if (normalized.length === 0) return fullPlan("no diff detected");

  const registryRuleChanged =
    normalized.includes("src/core/registry.ts") &&
    (opts.registryDiff === undefined ||
      didRegistryRuleChange(opts.registryDiff));

  if (registryRuleChanged) {
    return fullPlan("registry engineSupports rule changed");
  }

  for (const file of normalized) {
    if (FULL_TRIGGER_FILES.has(file)) {
      return fullPlan(`${file} changed`);
    }
    if (file.startsWith("spec/") || file.startsWith("tools/extract/")) {
      return fullPlan("spec or extractor changed");
    }
  }

  const reverseImports = opts.reverseImports ?? buildReverseImportGraph();
  const unitPool = opts.availableUnitTests ?? listAvailableUnitTests();
  const unitFiles = new Set<string>();
  const addUnit = (...files: string[]) => {
    for (const f of files) {
      if (unitPool.size === 0 || unitPool.has(f)) unitFiles.add(f);
    }
  };
  const addServiceUnits = (service: string) => {
    for (const f of unitPool) {
      const base = f.slice("test/unit/".length);
      if (base === `${service}.test.ts` || base.startsWith(`${service}-`)) {
        unitFiles.add(f);
      }
    }
    if (service === "setup") {
      addUnit(
        "test/unit/session-authenticate.test.ts",
        "test/unit/session-import.test.ts",
      );
    }
  };

  let mode: ParityMode = "none";
  let allUnitTests = false;
  let needsBuild = false;
  const parityFiles = new Set<string>();
  const parityIds = new Set<string>();
  const parityServices = new Set<string>();
  const parityKeys = new Set<string>();

  for (const file of normalized) {
    if (
      DOCS_ONLY_FILES.has(file) ||
      file.startsWith("docs/") ||
      file.startsWith(".scratch/") ||
      file.startsWith("bench/")
    ) {
      if (file.startsWith("bench/results/")) {
        addUnit("test/unit/no-local-paths.test.ts");
      }
      continue;
    }

    if (file === "PLAN.md") {
      addUnit("test/unit/ladder.test.ts", "test/unit/status.test.ts");
      continue;
    }

    if (file === "DIVERGENCES.md") {
      addUnit("test/unit/divergences.test.ts", "test/unit/status.test.ts");
      continue;
    }

    if (
      file === "SECURITY.md" ||
      file === "CONTRIBUTING.md" ||
      file === "CHANGELOG.md" ||
      file.startsWith(".github/ISSUE_TEMPLATE/")
    ) {
      addUnit("test/unit/community-health.test.ts");
      continue;
    }

    if (file.startsWith(".github/workflows/")) {
      addUnit(
        "test/unit/ci-workflows.test.ts",
        "test/unit/release-workflow.test.ts",
        "test/unit/release-checksums.test.ts",
        "test/unit/community-health.test.ts",
      );
      continue;
    }

    if (file.startsWith("site/")) {
      addUnit("test/unit/release-checksums.test.ts");
      continue;
    }

    if (file.startsWith("tasks/")) {
      addUnit("test/unit/ci-installs.test.ts");
      continue;
    }

    if (file === "flake.nix" || file.startsWith("aur/")) {
      addUnit("test/unit/package-managers.test.ts");
      continue;
    }

    if (file.startsWith("test/unit/") && file.endsWith(".test.ts")) {
      addUnit(file);
      continue;
    }

    if (file.startsWith("test/live/")) {
      continue;
    }

    if (file.startsWith("test/parity/cases/") && file.endsWith(".json")) {
      const caseFile = file.slice("test/parity/cases/".length);
      parityFiles.add(caseFile);
      addUnit("test/unit/no-local-paths.test.ts");
      if (isGeneratedCaseFile(caseFile)) {
        addUnit("test/unit/generate-cases.test.ts");
      }
      needsBuild = true;
      mode = maxMode(mode, "scoped");
      continue;
    }

    if (file.startsWith("test/parity/golden/") && file.endsWith(".json")) {
      const id = file.slice("test/parity/golden/".length, -".json".length);
      parityIds.add(id);
      addUnit("test/unit/no-local-paths.test.ts");
      needsBuild = true;
      mode = maxMode(mode, "scoped");
      continue;
    }

    if (file === "test/parity/parity.test.ts") {
      needsBuild = true;
      mode = maxMode(mode, "sample");
      continue;
    }

    if (file.startsWith("test/recordings/")) {
      addUnit(
        "test/unit/no-local-paths.test.ts",
        "test/unit/recordings.test.ts",
        "test/unit/scrub.test.ts",
      );
      continue;
    }

    if (file.startsWith("test/fixtures/")) {
      addUnit(
        "test/unit/no-local-paths.test.ts",
        "test/unit/config.test.ts",
        "test/unit/datetime.test.ts",
        "test/unit/endpoint.test.ts",
        "test/unit/help-format.test.ts",
        "test/unit/parser.test.ts",
        "test/unit/signer.test.ts",
        "test/unit/signature-check.test.ts",
      );
      needsBuild = true;
      mode = maxMode(mode, "sample");
      continue;
    }

    if (file.startsWith("test/harness/")) {
      addUnit(...findTransitiveUnitTests(file, reverseImports));
      addUnit(
        "test/unit/compare.test.ts",
        "test/unit/warning-mask.test.ts",
        "test/unit/fake-endpoint.test.ts",
        "test/unit/runner.test.ts",
        "test/unit/sandbox.test.ts",
        "test/unit/scrub.test.ts",
        "test/unit/recordings.test.ts",
        "test/unit/fallback.test.ts",
      );
      needsBuild = true;
      mode = maxMode(mode, "sample");
      continue;
    }

    if (file.startsWith("scripts/")) {
      addUnit(...findTransitiveUnitTests(file, reverseImports));
      if (file === "scripts/ladder.ts" || file === "scripts/ladder-lib.ts") {
        addUnit("test/unit/ladder.test.ts");
      } else if (
        file === "scripts/status.ts" ||
        file === "scripts/status-lib.ts"
      ) {
        addUnit("test/unit/status.test.ts");
      } else if (file === "scripts/generate-cases.ts") {
        addUnit("test/unit/generate-cases.test.ts");
      } else if (file === "scripts/spec.ts") {
        addUnit("test/unit/spec-script.test.ts");
      } else if (file === "scripts/update-package-managers.ts") {
        addUnit("test/unit/package-managers.test.ts");
      } else if (
        file === "scripts/verify.ts" ||
        file === "scripts/verify-lib.ts"
      ) {
        addUnit("test/unit/verify.test.ts");
      } else if (file === "scripts/record.ts") {
        addUnit("test/unit/recordings.test.ts", "test/unit/scrub.test.ts");
      }
      continue;
    }

    if (file.startsWith("src/commands/")) {
      const rest = file.slice("src/commands/".length);
      const service = (rest.split("/")[0] ?? "").replace(/\.ts$/, "");
      addUnit(...findTransitiveUnitTests(file, reverseImports));
      needsBuild = true;
      mode = maxMode(mode, "scoped");
      if (service === "update") {
        addUnit("test/unit/update.test.ts");
        parityFiles.add("help-root.json");
      } else if (service) {
        parityServices.add(service);
        addServiceUnits(service);
      }
      continue;
    }

    if (file === "src/core/registry.ts") {
      addUnit("test/unit/registry.test.ts");
      needsBuild = true;
      mode = maxMode(mode, "scoped");
      const touched = extractRegistryTouched(opts.registryDiff ?? "");
      for (const svc of touched.services) {
        parityServices.add(svc);
        addServiceUnits(svc);
      }
      for (const key of touched.keys) {
        parityKeys.add(key);
      }
      continue;
    }

    if (
      file === "src/main.ts" ||
      file.startsWith("src/core/") ||
      file.startsWith("src/lib/") ||
      file.startsWith("src/utils/")
    ) {
      needsBuild = true;
      mode = maxMode(mode, "sample");
      addUnit(...findTransitiveUnitTests(file, reverseImports));
      if (file === "src/main.ts") {
        addUnit("test/unit/skeleton.test.ts", "test/unit/version.test.ts");
      } else if (file === "src/core/cli.ts") {
        addUnit(
          "test/unit/fallback.test.ts",
          "test/unit/generated-write.test.ts",
          "test/unit/registry.test.ts",
        );
      } else if (
        file === "src/core/operation.ts" ||
        file === "src/core/output.ts" ||
        file === "src/core/json-input.ts" ||
        file === "src/core/config.ts" ||
        file === "src/core/rc.ts"
      ) {
        addUnit("test/unit/generated-write.test.ts");
      } else if (file === "src/core/spec.ts") {
        addUnit(
          "test/unit/spec-bindings.test.ts",
          "test/unit/spec-index.test.ts",
          "test/unit/spec-kind.test.ts",
          "test/unit/spec-operation.test.ts",
          "test/unit/spec-script.test.ts",
          "test/unit/spec-service.test.ts",
        );
      } else if (file === "src/core/checksums.ts") {
        addUnit(
          "test/unit/package-managers.test.ts",
          "test/unit/update.test.ts",
        );
      }
      continue;
    }

    // Any unrecognized file: escalate conservatively
    needsBuild = true;
    allUnitTests = true;
    mode = maxMode(mode, "sample");
  }

  if (mode !== "none" && !hasResultsFile) {
    mode = "full";
  }

  const sortedUnits = [...unitFiles].sort();
  const sortedServices = [...parityServices].sort();
  const sortedFiles = [...parityFiles].sort();
  const sortedIds = [...parityIds].sort();
  const sortedKeys = [...parityKeys].sort();

  const summaryParts: string[] = [];
  if (sortedServices.length)
    summaryParts.push(`services: ${sortedServices.join(",")}`);
  if (sortedFiles.length)
    summaryParts.push(`${sortedFiles.length} case file(s)`);
  if (sortedIds.length) summaryParts.push(`${sortedIds.length} golden(s)`);
  if (allUnitTests) summaryParts.push("all unit tests");
  else if (sortedUnits.length)
    summaryParts.push(`${sortedUnits.length} unit file(s)`);

  return {
    mode,
    reason: summaryParts.join(", ") || `${normalized.length} changed file(s)`,
    needsBuild,
    allUnitTests,
    unitFiles: allUnitTests ? [] : sortedUnits,
    parityFiles: sortedFiles,
    parityIds: sortedIds,
    parityServices: sortedServices,
    parityKeys: sortedKeys,
  };
}

export type ParitySelectOptions = {
  mode: ParityMode;
  files?: Iterable<string>;
  ids?: Iterable<string>;
  services?: Iterable<string>;
  keys?: Iterable<string>;
  prevResults?: Record<string, { pass: boolean }>;
};

/**
 * Computes the set of case IDs that represent 1 generated case of each kind
 * (`generated-get`, `generated-request`, `generated-bodyless`, `generated-wrapper`)
 * per service, plus every hand-written case.
 */
export function computeSpawnSample(cases: ParityCase[]): Set<string> {
  const sample = new Set<string>();
  const seen = new Set<string>();
  for (const c of cases) {
    const kind = /^(generated-[a-z]+)-/.exec(c.id)?.[1];
    const group = kind ? `${kind} ${c.key.split(" ")[0]}` : c.id;
    if (!seen.has(group)) sample.add(c.id);
    seen.add(group);
  }
  return sample;
}

/**
 * Selects which Parity cases to run in `scoped`, `sample`, or `full` mode.
 * Expands any matched case to include all cases sharing its `key` so that
 * `results[key]` is always evaluated across 100% of that key's cases.
 */
export function selectParityCases(
  allWithFiles: ParityCaseWithFile[],
  opts: ParitySelectOptions,
): ParityCase[] {
  const allCases = allWithFiles.map((e) => e.case);
  if (opts.mode === "full") return allCases;
  if (opts.mode === "none") return [];

  const fileSet = new Set(opts.files ?? []);
  const idSet = new Set(opts.ids ?? []);
  const serviceSet = new Set(opts.services ?? []);
  const keySet = new Set(opts.keys ?? []);
  const sampleIds = computeSpawnSample(allCases);
  const prevResults = opts.prevResults;

  const matchedKeys = new Set<string>(keySet);

  for (const { file, case: c } of allWithFiles) {
    const service = c.key.split(" ")[0] ?? "";
    const isGenerated = isGeneratedCaseFile(file);
    const inSample = !isGenerated || sampleIds.has(c.id);

    if (
      fileSet.has(file) ||
      idSet.has(c.id) ||
      keySet.has(c.key) ||
      (serviceSet.has(service) && inSample) ||
      (opts.mode === "sample" && inSample) ||
      (prevResults !== undefined && !prevResults[c.key]?.pass)
    ) {
      matchedKeys.add(c.key);
    }
  }

  // Always include at least one fast hand-written case (`--version`) so `dist/boci` is smoke-tested.
  if (matchedKeys.size === 0) {
    const fallback = allCases.find((c) => c.key === "--version") ?? allCases[0];
    if (fallback) matchedKeys.add(fallback.key);
  }

  return allCases.filter((c) => matchedKeys.has(c.key));
}

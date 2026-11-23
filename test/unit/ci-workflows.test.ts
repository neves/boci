import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = join(import.meta.dir, "../../.github/workflows");

type WorkflowStep = {
  uses?: string;
  run?: string;
};

type WorkflowJob = {
  "runs-on"?: string;
  strategy?: {
    matrix?: {
      os?: string[];
    };
  };
  steps?: WorkflowStep[];
};

type Workflow = {
  name?: string;
  on?: {
    push?: {
      branches?: string[];
      tags?: string[];
    };
    pull_request?: unknown;
    workflow_dispatch?: unknown;
  };
  jobs?: Record<string, WorkflowJob>;
};

const MINIMUM_ACTION_MAJOR: Record<string, number> = {
  "actions/checkout": 5,
  "actions/setup-node": 5,
  "jdx/mise-action": 4,
  "softprops/action-gh-release": 3,
  "oven-sh/setup-bun": 2,
};

function parseWorkflow(filename: string): Workflow {
  const text = require("node:fs").readFileSync(
    join(WORKFLOWS_DIR, filename),
    "utf8",
  );
  return Bun.YAML.parse(text) as Workflow;
}

describe("GitHub Actions workflows", () => {
  test("ci.yml triggers on push to main and pull_request", () => {
    const ci = parseWorkflow("ci.yml");
    expect(ci.on?.push?.branches).toContain("main");
    expect("pull_request" in (ci.on ?? {})).toBe(true);
  });

  test("ci.yml runs verify across ubuntu-latest, macos-latest, and windows-latest", () => {
    const ci = parseWorkflow("ci.yml");
    const jobs = Object.values(ci.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);

    const runners = new Set<string>();
    for (const job of jobs) {
      if (job.strategy?.matrix?.os) {
        for (const os of job.strategy.matrix.os) runners.add(os);
      } else if (job["runs-on"]) {
        runners.add(job["runs-on"]);
      }

      const steps = job.steps ?? [];
      const usesCheckout = steps.some((s) =>
        s.uses?.startsWith("actions/checkout@"),
      );
      const usesSetupBun = steps.some((s) =>
        s.uses?.startsWith("oven-sh/setup-bun@"),
      );
      const runsInstall = steps.some((s) =>
        s.run?.includes("bun install --frozen-lockfile"),
      );
      const runsVerify = steps.some((s) => s.run?.includes("bun run verify"));

      expect(usesCheckout).toBe(true);
      expect(usesSetupBun).toBe(true);
      expect(runsInstall).toBe(true);
      expect(runsVerify).toBe(true);
    }

    expect(runners.has("ubuntu-latest")).toBe(true);
    expect(runners.has("macos-latest")).toBe(true);
    expect(runners.has("windows-latest")).toBe(true);
  });

  test("all workflow files are valid YAML and avoid deprecated Node 20 action majors", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    );
    expect(files).toContain("ci.yml");

    for (const file of files) {
      const wf = parseWorkflow(file);
      expect(wf.jobs).toBeDefined();

      for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          const [action, version] = step.uses.split("@");
          const minMajor = action ? MINIMUM_ACTION_MAJOR[action] : undefined;
          if (minMajor !== undefined) {
            const match = /^v(\d+)/.exec(version ?? "");
            const major = match ? Number(match[1]) : 0;
            expect(
              major,
              `${file} (${jobName}): ${step.uses} must be >= v${minMajor}`,
            ).toBeGreaterThanOrEqual(minMajor);
          }
        }
      }
    }
  });
});

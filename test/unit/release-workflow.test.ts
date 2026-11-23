import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowFile {
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

const RELEASE_WORKFLOW_PATH = resolve(
  import.meta.dir,
  "../../.github/workflows/release.yml",
);

async function loadReleaseWorkflow(): Promise<WorkflowFile> {
  const text = await Bun.file(RELEASE_WORKFLOW_PATH).text();
  return Bun.YAML.parse(text) as WorkflowFile;
}

describe("release workflow build provenance", () => {
  test("build-and-release job has attestations: write, id-token: write, and contents: write permissions", async () => {
    const workflow = await loadReleaseWorkflow();
    const buildJob = workflow.jobs?.["build-and-release"];
    expect(buildJob).toBeDefined();
    expect(buildJob?.permissions?.["attestations"]).toBe("write");
    expect(buildJob?.permissions?.["id-token"]).toBe("write");
    expect(buildJob?.permissions?.["contents"]).toBe("write");
  });

  test("build-and-release job attests build provenance for all compiled release binaries", async () => {
    const workflow = await loadReleaseWorkflow();
    const steps = workflow.jobs?.["build-and-release"]?.steps ?? [];

    const buildIndex = steps.findIndex((s) =>
      s.run?.includes("bun run build --outfile"),
    );
    const attestIndex = steps.findIndex((s) =>
      s.uses?.startsWith("actions/attest-build-provenance@"),
    );
    const releaseIndex = steps.findIndex((s) =>
      s.uses?.startsWith("softprops/action-gh-release@"),
    );

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(attestIndex).toBeGreaterThan(buildIndex);
    expect(releaseIndex).toBeGreaterThan(attestIndex);

    const attestStep = steps[attestIndex];
    const subjectPath = attestStep?.with?.["subject-path"];
    expect(subjectPath).toBeTruthy();

    const buildStep = steps[buildIndex];
    const builtBinaries = [
      ...(buildStep?.run?.matchAll(/--outfile\s+(dist\/\S+)/g) ?? []),
    ].map((m) => m[1]!);
    expect(builtBinaries.length).toBeGreaterThan(0);

    const patterns = subjectPath!
      .split(/[\n,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const globs = patterns.map((p) => new Bun.Glob(p));

    for (const binary of builtBinaries) {
      const matched = globs.some((g) => g.match(binary));
      expect(matched).toBe(true);
    }
  });
});

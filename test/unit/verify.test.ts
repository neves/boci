import { describe, expect, test } from "bun:test";
import {
  computeSpawnSample,
  didRegistryRuleChange,
  extractRegistryTouched,
  planVerification,
  selectParityCases,
} from "../../scripts/verify-lib.ts";
import type { ParityCaseWithFile } from "../harness/cases.ts";

describe("verify-lib change classification", () => {
  test("detects whether a registry.ts diff touches engineSupports vs command handlers", () => {
    const handlerDiff = `
@@ -43,6 +43,12 @@
+const computePlinkHandler: CustomCommandHandler = async (ctx) => {
+  const { runComputeInstanceConsolePlink } =
+    await import("../commands/compute/plink_connection.ts");
+  await runComputeInstanceConsolePlink(ctx);
+};
@@ -64,6 +70,10 @@
+  [
+    "compute instance-console-connection get-plink-connection-string",
+    computePlinkHandler,
+  ],
`;
    expect(didRegistryRuleChange(handlerDiff)).toBe(false);
    expect(extractRegistryTouched(handlerDiff)).toEqual({
      services: ["compute"],
      keys: ["compute instance-console-connection get-plink-connection-string"],
    });

    const ruleDiff = `
@@ -311,7 +311,7 @@ export function engineSupports(command: Command): boolean {
-  if (http === "DELETE") return operation?.body === undefined;
+  if (http === "DELETE") return true;
`;
    expect(didRegistryRuleChange(ruleDiff)).toBe(true);
  });

  test("scopes a Rung 8 custom command iteration to the touched service, case file, and unit tests", () => {
    const registryDiff = `
+    await import("../commands/compute/plink_connection.ts");
+    "compute instance-console-connection get-plink-connection-string",
`;
    const plan = planVerification(
      [
        "PLAN.md",
        "src/commands/compute/plink_connection.ts",
        "src/core/registry.ts",
        "test/parity/cases/compute-instance-console-plink.json",
        "test/parity/golden/compute-instance-console-plink-defaults.json",
      ],
      {
        hasResultsFile: true,
        registryDiff,
      },
    );

    expect(plan.mode).toBe("scoped");
    expect(plan.needsBuild).toBe(true);
    expect(plan.allUnitTests).toBe(false);
    expect(plan.parityServices).toEqual(["compute"]);
    expect(plan.parityFiles).toEqual(["compute-instance-console-plink.json"]);
    expect(plan.parityIds).toEqual(["compute-instance-console-plink-defaults"]);
    expect(plan.parityKeys).toEqual([
      "compute instance-console-connection get-plink-connection-string",
    ]);
    expect(plan.unitFiles).toEqual([
      "test/unit/ladder.test.ts",
      "test/unit/no-local-paths.test.ts",
      "test/unit/registry.test.ts",
      "test/unit/status.test.ts",
    ]);
  });

  test("skips build and parity when only PLAN.md, DIVERGENCES.md, or scripts change", () => {
    const plan = planVerification(
      ["PLAN.md", "DIVERGENCES.md", "scripts/ladder-lib.ts"],
      { hasResultsFile: true },
    );

    expect(plan.mode).toBe("none");
    expect(plan.needsBuild).toBe(false);
    expect(plan.allUnitTests).toBe(false);
    expect(plan.unitFiles).toEqual([
      "test/unit/divergences.test.ts",
      "test/unit/ladder.test.ts",
      "test/unit/status.test.ts",
    ]);
  });

  test("uses sample parity mode and targeted unit tests for core module edits", () => {
    const plan = planVerification(["src/core/download.ts"], {
      hasResultsFile: true,
    });

    expect(plan.mode).toBe("sample");
    expect(plan.needsBuild).toBe(true);
    expect(plan.allUnitTests).toBe(false);
    expect(plan.unitFiles).toEqual(["test/unit/download.test.ts"]);
  });

  test("escalates to full mode when spec, build.ts, engineSupports, or results.json is missing", () => {
    expect(
      planVerification(["spec/compute.json"], { hasResultsFile: true }).mode,
    ).toBe("full");
    expect(
      planVerification(["scripts/build.ts"], { hasResultsFile: true }).mode,
    ).toBe("full");
    expect(
      planVerification(["src/core/registry.ts"], {
        hasResultsFile: true,
        registryDiff: "+export function engineSupports() {}",
      }).mode,
    ).toBe("full");
    expect(
      planVerification(["src/commands/compute/plink_connection.ts"], {
        hasResultsFile: false,
      }).mode,
    ).toBe("full");
  });
});

describe("verify-lib parity case selection", () => {
  const fixtureCases: ParityCaseWithFile[] = [
    {
      file: "core.json",
      case: { id: "version-flag", key: "--version", argv: ["--version"] },
    },
    {
      file: "compute-instance-action.json",
      case: {
        id: "compute-instance-action-stop",
        key: "compute instance action",
        argv: ["compute", "instance", "action"],
      },
    },
    {
      file: "compute-instance-action.json",
      case: {
        id: "compute-instance-action-scheduled",
        key: "compute instance action",
        argv: ["compute", "instance", "action"],
      },
    },
    {
      file: "generated-get-compute.json",
      case: {
        id: "generated-get-compute-one",
        key: "compute image get",
        argv: ["compute", "image", "get"],
      },
    },
    {
      file: "generated-get-compute.json",
      case: {
        id: "generated-get-compute-two",
        key: "compute instance get",
        argv: ["compute", "instance", "get"],
      },
    },
    {
      file: "generated-bodyless-adm.json",
      case: {
        id: "generated-bodyless-adm-one",
        key: "adm audit delete",
        argv: ["adm", "audit", "delete"],
      },
    },
    {
      file: "generated-bodyless-adm.json",
      case: {
        id: "generated-bodyless-adm-two",
        key: "adm kb delete",
        argv: ["adm", "kb", "delete"],
      },
    },
  ];

  test("computeSpawnSample samples 1 generated case per kind per service including bodyless and wrapper", () => {
    const sample = computeSpawnSample(fixtureCases.map((e) => e.case));
    expect([...sample]).toEqual([
      "version-flag",
      "compute-instance-action-stop",
      "compute-instance-action-scheduled",
      "generated-get-compute-one",
      "generated-bodyless-adm-one",
    ]);
  });

  test("selectParityCases in scoped mode includes service hand-written cases, service generated sample, key closure, and unverified keys", () => {
    const prevResults = {
      "--version": { pass: true },
      "compute instance action": { pass: true },
      "compute image get": { pass: true },
      "compute instance get": { pass: true },
      "adm audit delete": { pass: true },
      "adm kb delete": { pass: false },
    };

    const selected = selectParityCases(fixtureCases, {
      mode: "scoped",
      services: ["compute"],
      prevResults,
    });

    // Includes both cases for "compute instance action", the first generated-get for compute,
    // and "adm kb delete" because it had pass: false in prevResults.
    expect(selected.map((c) => c.id)).toEqual([
      "compute-instance-action-stop",
      "compute-instance-action-scheduled",
      "generated-get-compute-one",
      "generated-bodyless-adm-two",
    ]);
  });

  test("selectParityCases expands a single golden ID to all cases sharing its key", () => {
    const prevResults = Object.fromEntries(
      fixtureCases.map((e) => [e.case.key, { pass: true }]),
    );
    const selected = selectParityCases(fixtureCases, {
      mode: "scoped",
      ids: ["compute-instance-action-stop"],
      prevResults,
    });

    expect(selected.map((c) => c.id)).toEqual([
      "compute-instance-action-stop",
      "compute-instance-action-scheduled",
    ]);
  });
});

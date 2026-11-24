import { describe, expect, test } from "bun:test";
import {
  blameLine,
  bucket,
  needsOf,
  groupByBucket,
  leafKeys,
  operationConst,
  renderPlan,
  scaffoldNames,
  unlockPlan,
  type Triage,
} from "../../scripts/triage-lib.ts";

describe("triage-lib", () => {
  test("leafKeys walks nested command trees", () => {
    const keys = leafKeys({
      name: "oci",
      commands: {
        iam: {
          name: "iam",
          commands: {
            group: {
              name: "group",
              commands: {
                "add-user": { name: "add-user" },
              },
            },
          },
        },
        "raw-request": { name: "raw-request" },
      },
    });
    expect(keys).toEqual(["iam group add-user", "raw-request"]);
  });

  test("unlockPlan greedily orders capabilities by unlocked commands", () => {
    const rows: Triage[] = [
      {
        key: "a one",
        sdkCalls: [{ client: "x", method: "x", line: 1 }],
        needs: { "call cli_util.render_response": "x" },
      },
      {
        key: "a two",
        sdkCalls: [{ client: "x", method: "x", line: 1 }],
        needs: {
          "call cli_util.render_response": "x",
          "call oci.wait_until": "y",
        },
      },
      {
        key: "b one",
        needs: { "call foo": "z" },
      },
    ];
    const plan = unlockPlan(rows);
    expect(plan[0]?.capability).toBe(
      "Tier C: build_client + client.<method>(...) + render_response",
    );
    expect(plan[0]?.unlocked).toEqual(["a one"]);
    expect(renderPlan(rows)).toContain("3 missing Leaf commands");
  });

  test("bucket, groupByBucket, and blameLine", () => {
    const t: Triage = {
      key: "iam group add-user",
      kind: "custom",
      tier: "C",
      reason: "call keywords",
      source: { file: "id.py", line: 100, lines: 20 },
      blame: { source: "client.add_user_to_group(x=1)", line: 5 },
    };
    expect(bucket(t)).toBe("sdk call: client.<method>(...) (Tier C)");
    expect(blameLine(t)).toBe(104);
    expect(groupByBucket([t])[0]?.[1]).toHaveLength(1);
  });

  test("scaffoldNames and operationConst", () => {
    expect(scaffoldNames("iam group add-user")).toEqual({
      service: "iam",
      path: "group add-user",
      file: "src/commands/iam/group_add_user.ts",
      fn: "runIamGroupAddUser",
      caseId: "iam-group-add-user",
      caseFile: "test/parity/cases/iam-group-add-user.json",
    });
    expect(scaffoldNames("raw-request").file).toBe(
      "src/commands/raw-request/index.ts",
    );
    expect(
      needsOf({ key: "profile list", needs: { "call sys.exit": "x" } }),
    ).toEqual(["call sys.exit"]);
    expect(operationConst("list_compartments")).toBe(
      "listCompartmentsOperation",
    );
  });
});

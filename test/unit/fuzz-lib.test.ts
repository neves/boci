import { describe, expect, test } from "bun:test";
import {
  buildInvocation,
  describeDiff,
  invocationSeed,
  randomValue,
  rng,
  type ServiceSpec,
} from "../../scripts/fuzz-lib.ts";

const spec: ServiceSpec = {
  commands: {
    "widget list": {
      kind: "generated",
      operation: {
        http: "GET",
        path: "/widgets",
        responseType: "list[Widget]",
        paginated: true,
      },
      params: [
        {
          name: "compartment_id",
          opts: ["--compartment-id", "-c"],
          type: "text",
          required: true,
        },
        { name: "limit", opts: ["--limit"], type: "integer" },
        {
          name: "sort_order",
          opts: ["--sort-order"],
          type: "choice",
          choices: ["ASC", "DESC"],
        },
        { name: "all_pages", opts: ["--all"], type: "boolean", isFlag: true },
        { name: "from_json", opts: ["--from-json"], type: "text" },
      ],
    },
    "widget delete": {
      kind: "generated",
      operation: {
        http: "DELETE",
        path: "/widgets/{id}",
        pathParams: { id: "widget_id" },
      },
      params: [{ name: "widget_id", opts: ["--widget-id"], type: "text" }],
    },
    local: { kind: "custom", tier: "C" },
  },
  models: {
    test: {
      Widget: {
        attributes: [
          ["id", "str", "id"],
          ["size", "int", "size"],
          ["shape", "Shape", "shape"],
        ],
      },
      Shape: { attributes: [["kind", "str", "kind"]] },
      Circle: {
        attributes: [
          ["kind", "str", "kind"],
          ["radius", "float", "radius"],
        ],
        discriminator: "Shape",
      },
    },
  },
};

describe("fuzz-lib", () => {
  test("the same seed builds the same invocation", () => {
    const seed = invocationSeed(7, "svc widget list", 0);
    expect(buildInvocation("svc", "widget list", spec, seed)).toEqual(
      buildInvocation("svc", "widget list", spec, seed)!,
    );
  });

  test("invocations always carry required and path options and the endpoint", () => {
    for (let i = 0; i < 50; i++) {
      const list = buildInvocation("svc", "widget list", spec, i)!;
      expect(list.argv.slice(0, 3)).toEqual(["svc", "widget", "list"]);
      expect(list.argv.slice(-2)).toEqual(["--endpoint", "{endpoint}"]);
      expect(list.argv).not.toContain("--from-json");
      const del = buildInvocation("svc", "widget delete", spec, i)!;
      expect(del.argv).toContain("--widget-id");
      expect(del.stdin === "y\n" || del.stdin === "n\n").toBe(true);
    }
  });

  test("--all gets a reply per page, linked by opc-next-page", () => {
    for (let i = 0; i < 200; i++) {
      const inv = buildInvocation("svc", "widget list", spec, i)!;
      if (!inv.argv.includes("--all") || !Array.isArray(inv.replies)) continue;
      const replies = inv.replies;
      if (replies[0]?.status !== 200) continue;
      expect(replies.at(-1)?.headers?.["opc-next-page"]).toBeUndefined();
      replies
        .slice(0, -1)
        .forEach((r) => expect(r.headers?.["opc-next-page"]).toBeDefined());
      return;
    }
    throw new Error("no --all invocation in 200 seeds");
  });

  test("commands without a modelled request aren't fuzzed", () => {
    expect(buildInvocation("svc", "local", spec, 1)).toBeUndefined();
  });

  test("response bodies follow the model, with JSON field names", () => {
    const models = new Map(Object.entries(spec.models!.test!));
    const r = rng(3);
    for (let i = 0; i < 20; i++) {
      const list = randomValue("list[Widget]", models, r) as unknown[];
      expect(Array.isArray(list)).toBe(true);
      for (const w of list as Record<string, unknown>[])
        for (const k of Object.keys(w))
          expect(["id", "size", "shape", "fuzzUnknownField"]).toContain(k);
    }
  });

  test("describeDiff names each differing field with its first differing line", () => {
    expect(
      describeDiff(
        { stdout: "a\nb\n", exitCode: 0, stderr: "" },
        { stdout: "a\nc\n", exitCode: 0, stderr: "" },
      ),
    ).toEqual({ stdout: { oci: "line 2: b", boci: "line 2: c" } });
  });
});

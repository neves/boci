import { describe, expect, test } from "bun:test";
import { applyQuery } from "../../src/query.ts";

describe("OCI JMESPath queries", () => {
  test("evaluates standard projections and functions", () => {
    expect(
      applyQuery(
        { data: { items: [{ name: "a" }, { name: "b" }] } },
        "data.items[].name",
      ),
    ).toEqual(["a", "b"]);
    expect(applyQuery({ data: [1, 2, 3] }, "length(data)")).toBe(3);
  });

  test("supports OCI custom functions", () => {
    expect(
      applyQuery(
        { data: { items: [{ displayName: "one" }, { displayName: "two" }] } },
        "query(data.items[], 'displayName')",
      ),
    ).toEqual(["one", "two"]);
    expect(
      applyQuery(
        { data: [{ id: "a" }, { id: "b" }] },
        "sort_by(data, &id)[].id",
      ),
    ).toEqual(["a", "b"]);
  });
});

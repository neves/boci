import { describe, expect, test } from "bun:test";
import { applyQuery, compileQuery } from "../../src/lib/query.ts";
import {
  ArityError,
  EmptyExpressionError,
  IncompleteExpressionError,
  JMESPathTypeError,
  LexerError,
  ParseError,
  UnknownFunctionError,
  VariadictArityError,
} from "../../src/utils/jmespath.ts";

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

  test("evaluates slices, filters, pipes, boolean ops, and multi-select", () => {
    const doc = {
      items: [
        { id: 3, name: "c", active: true },
        { id: 1, name: "a", active: false },
        { id: 2, name: "b", active: true },
      ],
      meta: { "lifecycle-state": "ACTIVE", zero: 0 },
    };
    expect(applyQuery(doc, "items[0:2].name")).toEqual(["c", "a"]);
    expect(applyQuery(doc, "items[::-1].name")).toEqual(["b", "a", "c"]);
    expect(applyQuery(doc, "items[?active == `true`].name")).toEqual([
      "c",
      "b",
    ]);
    expect(applyQuery(doc, "items[?id > `1`] | [0].name")).toBe("c");
    expect(applyQuery(doc, 'meta."lifecycle-state"')).toBe("ACTIVE");
    expect(applyQuery(doc, "!(meta.zero)")).toBe(false);
    expect(applyQuery(doc, "!(meta.missing)")).toBe(true);
    expect(applyQuery(doc, "!meta.zero")).toBeNull();
    expect(applyQuery(doc, "meta.missing || `null`")).toBeNull();
    expect(
      applyQuery(doc, "{first: items[0].name, count: length(items)}"),
    ).toEqual({ first: "c", count: 3 });
    expect(applyQuery(doc, "[items[0].id, items[1].id]")).toEqual([3, 1]);
  });

  test("evaluates standard functions", () => {
    const doc = { nums: [3, 1, 2], strs: ["b", "a"], obj: { x: 1, y: 2 } };
    expect(applyQuery(doc, "abs(`-5`)")).toBe(5);
    expect(applyQuery(doc, "avg(nums)")).toBe(2);
    expect(applyQuery(doc, "sum(nums)")).toBe(6);
    expect(applyQuery(doc, "min(nums)")).toBe(1);
    expect(applyQuery(doc, "max(nums)")).toBe(3);
    expect(applyQuery(doc, "sort(nums)")).toEqual([1, 2, 3]);
    expect(applyQuery(doc, "reverse(strs)")).toEqual(["a", "b"]);
    expect(applyQuery(doc, "join(',', strs)")).toBe("b,a");
    expect(applyQuery(doc, "keys(obj)")).toEqual(["x", "y"]);
    expect(applyQuery(doc, "values(obj)")).toEqual([1, 2]);
    expect(applyQuery(doc, "contains(strs, 'a')")).toBe(true);
    expect(applyQuery(doc, "starts_with('hello', 'he')")).toBe(true);
    expect(applyQuery(doc, "ends_with('hello', 'lo')")).toBe(true);
    expect(applyQuery(doc, "not_null(`null`, `42`)")).toBe(42);
    expect(applyQuery(doc, "to_string(`42`)")).toBe("42");
    expect(applyQuery(doc, "to_number('42')")).toBe(42);
    expect(applyQuery(doc, "to_array('x')")).toEqual(["x"]);
    expect(applyQuery(doc, "type(obj)")).toBe("object");
    expect(applyQuery(doc, "ceil(`1.2`)")).toBe(2);
    expect(applyQuery(doc, "floor(`1.8`)")).toBe(1);
    expect(applyQuery(doc, 'merge(`{"a":1}`, `{"b":2}`)')).toEqual({
      a: 1,
      b: 2,
    });
    expect(
      applyQuery({ items: [{ k: 2 }, { k: 1 }] }, "min_by(items, &k).k"),
    ).toBe(1);
    expect(
      applyQuery({ items: [{ k: 2 }, { k: 1 }] }, "max_by(items, &k).k"),
    ).toBe(2);
    expect(
      applyQuery({ items: [{ k: 2 }, { k: 1 }] }, "map(&k, items)"),
    ).toEqual([2, 1]);
  });

  test("raises Python-compatible JMESPath error types and messages", () => {
    expect(() => compileQuery("")).toThrow(EmptyExpressionError);
    expect(() => compileQuery("not a [ query")).toThrow(ParseError);
    try {
      compileQuery("not a [ query");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).pythonName).toBe("ParseError");
      expect((e as ParseError).message).toBe(
        'Unexpected token: a: Parse error at column 4, token "a" (UNQUOTED_IDENTIFIER), for expression:\n"not a [ query"\n     ^',
      );
    }

    expect(() => compileQuery("data[")).toThrow(IncompleteExpressionError);
    expect(() => compileQuery("data.display-name")).toThrow(LexerError);
    expect(() => applyQuery({}, "length()")).toThrow(ArityError);
    expect(() => applyQuery({}, "not_null()")).toThrow(VariadictArityError);
    expect(() => applyQuery({}, "bogus_fn(data)")).toThrow(
      UnknownFunctionError,
    );
    try {
      applyQuery({ data: null }, "length(data)");
    } catch (e) {
      expect(e).toBeInstanceOf(JMESPathTypeError);
      expect((e as JMESPathTypeError).message).toBe(
        `In function length(), invalid type for value: None, expected one of: ['string', 'array', 'object'], received: "null"`,
      );
    }
  });
});

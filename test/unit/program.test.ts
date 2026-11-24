import { describe, expect, test } from "bun:test";
import type { TypedParam } from "../../src/core/convert.ts";
import {
  ProgramFile,
  ProgramRaise,
  ProgramUnsupported,
  ProgramUsageError,
  runProgram,
  type Expr,
  type Statement,
} from "../../src/core/program.ts";

const params = [
  { name: "a" },
  { name: "b" },
  { name: "ids", multiple: true },
] as TypedParam[];
const kw = (key: string) => ["item", ["var", "kwargs"], key];
const parse = (_: string, v: unknown) =>
  typeof v === "string" ? JSON.parse(v) : v;
const invoke: Statement = ["invoke", [], ["var", "kwargs"]];

describe("runProgram", () => {
  test("folds options into a dumped dict and drops the sources", () => {
    const program: Statement[] = [
      ["let", "d", ["dict"]],
      [
        "if",
        ["cmp", "isnot", kw("a"), null],
        [["set", ["var", "d"], "x", kw("a")]],
        [],
      ],
      ["do", ["call", "pop", ["var", "kwargs"], "a"]],
      [
        "if",
        ["cmp", ">", ["fn", "len", ["var", "d"]], 0],
        [["set", ["var", "kwargs"], "t", ["fn", "dumps", ["var", "d"]]]],
        [],
      ],
      invoke,
    ];
    const { kwargs, names } = runProgram(program, { a: 1 }, params, parse);
    expect(kwargs).toEqual({ t: '{"x":1}' });
    expect(names).toEqual(["b", "ids", "t"]);
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({});
  });

  test("unset options are None or [] to the wrapper, and absent after it", () => {
    const program: Statement[] = [
      ["set", ["var", "kwargs"], "c", ["or", kw("b"), "fallback"]],
      ["set", ["var", "kwargs"], "renamed", kw("ids")],
      invoke,
    ];
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({
      c: "fallback",
    });
  });

  test("an empty JSON string is truthy until parsed", () => {
    const program: Statement[] = [
      [
        "if",
        kw("a"),
        [["set", ["var", "kwargs"], "p", ["fn", "parse", "a", kw("a")]]],
        [],
      ],
      invoke,
    ];
    expect(runProgram(program, { a: "{}" }, params, parse).kwargs).toEqual({
      a: "{}",
      p: {},
    });
  });

  test("raises other exceptions with the text Python's str() gives them", () => {
    const raised = (cls: string, message: Expr) => {
      try {
        runProgram([["raise", "src", cls, message]], {}, params, parse);
      } catch (e) {
        return e instanceof ProgramRaise ? [e.cls, e.message] : e;
      }
    };
    expect(raised("ValueError", "type doesn't match")).toEqual([
      "ValueError",
      "type doesn't match",
    ]);
    expect(raised("KeyError", "protocol is missing.")).toEqual([
      "KeyError",
      "'protocol is missing.'",
    ]);
  });

  test("formats strings with positional fields, like str.format", () => {
    const program: Statement[] = [
      [
        "set",
        ["var", "kwargs"],
        "m",
        ["call", "format", "--{} and {}{{}}", "x", 1],
      ],
      invoke,
    ];
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({
      m: "--x and 1{}",
    });
    expect(() =>
      runProgram(
        [["do", ["call", "format", "{} {0}", "x"]]],
        {},
        params,
        parse,
      ),
    ).toThrow(ProgramUnsupported);
  });

  test("raises usage errors, and stops on paths it does not model", () => {
    expect(() => runProgram([["usage", "nope"]], {}, params, parse)).toThrow(
      ProgramUsageError,
    );
    expect(() =>
      runProgram([["raise", "raise ValueError()"]], {}, params, parse),
    ).toThrow(ProgramUnsupported);
    expect(() =>
      runProgram(
        [["do", ["call", "pop", ["var", "kwargs"], "missing"]]],
        {},
        params,
        parse,
      ),
    ).toThrow(ProgramUnsupported);
  });

  test("no invoke: no request", () => {
    expect(runProgram([], {}, params, parse).kwargs).toBeUndefined();
  });

  test("dict() builds a dict from key/value pairs", () => {
    const pair: Expr = [
      "list",
      ["var", "k"],
      ["item", ["var", "kwargs"], ["var", "k"]],
    ];
    const program: Statement[] = [
      ["let", "common", ["fn", "dict", ["map", ["list", "a", "b"], "k", pair]]],
      ["invoke", [], ["var", "common"]],
    ];
    expect(runProgram(program, { a: 1, b: 2 }, params, parse).kwargs).toEqual({
      a: 1,
      b: 2,
    });
    expect(
      runProgram([["invoke", [], ["fn", "dict"]]], {}, params, parse).kwargs,
    ).toEqual({});
  });

  test("reports which generated command a variant selector invoked", () => {
    const program: Statement[] = [
      [
        "if",
        ["cmp", "==", kw("a"), "x"],
        [["invoke", [], ["var", "kwargs"], 2]],
        [invoke],
      ],
    ];
    expect(runProgram(program, { a: "x" }, params, parse).target).toBe(2);
    expect(runProgram(program, { a: "y" }, params, parse).target).toBe(0);
  });

  test("reads click.File options: text with universal newlines, once", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const file = new ProgramFile("r", enc("a\r\nb\rc"));
    expect(file.read()).toBe("a\nb\nc");
    expect(file.read()).toBe("");
    expect(new ProgramFile("r", enc("k1\nk2")).lines()).toEqual(["k1\n", "k2"]);
    expect(new ProgramFile("rb", enc("x\r\n")).read()).toEqual(enc("x\r\n"));
    expect(() => new ProgramFile("wb").read()).toThrow(ProgramUnsupported);
  });

  test("preserves UTF-8 BOM on text reads and explicit byte decoding", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(new ProgramFile("r", bom).read()).toBe("\uFEFFa");
    const decoded = runProgram(
      [["set", ["var", "kwargs"], "a", ["call", "decode", kw("a")]], invoke],
      { a: bom },
      params,
      parse,
    );
    expect(decoded.kwargs?.a).toBe("\uFEFFa");
  });

  test("keeps malformed UTF-8 strict on text reads and explicit byte decoding", () => {
    const malformed = new Uint8Array([0xff]);
    expect(() => new ProgramFile("r", malformed).read()).toThrow(
      "UnicodeDecodeError",
    );
    expect(() =>
      runProgram(
        [["set", ["var", "kwargs"], "a", ["call", "decode", kw("a")]], invoke],
        { a: malformed },
        params,
        parse,
      ),
    ).toThrow("UnicodeDecodeError");
  });

  test("for loops, comprehensions over file lines, b64encode", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const values = {
      a: new ProgramFile("r", enc("x\ny\n")),
      b: new ProgramFile("rb", enc("hi")),
    };
    const program: Statement[] = [
      ["let", "out", ["dict"]],
      [
        "for",
        "k",
        ["call", "keys", ["dict", ["one", 1], ["two", 2]]],
        [["set", ["var", "out"], ["var", "k"], ["var", "k"]]],
      ],
      [
        "set",
        ["var", "out"],
        "lines",
        ["map", kw("a"), "line", ["call", "rstrip", ["var", "line"], "\n"]],
      ],
      [
        "set",
        ["var", "out"],
        "b64",
        [
          "call",
          "decode",
          ["fn", "b64encode", ["call", "read", kw("b")]],
          "utf-8",
        ],
      ],
      ["invoke", [["a", ["fn", "dumps", ["var", "out"]]]], null],
    ];
    expect(runProgram(program, values, params, parse).kwargs).toEqual({
      a: JSON.stringify({
        one: "one",
        two: "two",
        lines: ["x", "y"],
        b64: "aGk=",
      }),
    });
  });
});

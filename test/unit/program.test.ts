import { describe, expect, test } from "bun:test";
import type { TypedParam } from "../../src/core/convert.ts";
import {
  ProgramUnsupported,
  ProgramUsageError,
  runProgram,
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
});

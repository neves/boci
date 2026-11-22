import { expect, test } from "bun:test";
import {
  BadParameter,
  type TypedParam,
  convert,
} from "../../src/core/convert.ts";

const index = await Bun.file(`${import.meta.dir}/../../spec/index.json`).json();
const cases = (await Bun.file(
  `${import.meta.dir}/../fixtures/datetime.json`,
).json()) as {
  value: string;
  rounding: string | null;
  out?: string;
  error?: string;
}[];

const param = (rounding: string | null) =>
  ({
    kind: "option",
    name: "t",
    opts: ["--t"],
    secondaryOpts: [],
    multiple: false,
    count: false,
    nargs: 1,
    isFlag: false,
    type: "datetime",
    typeClass: "oci_cli.custom_types.cli_datetime.CliDatetime",
    datetimeRounding: rounding,
  }) as TypedParam;

// Generated from oci's own CliDatetime by tools/extract/datetime_fixtures.py.
test("CliDatetime conversion matches oci", () => {
  for (const c of cases) {
    let got: { out?: unknown; error?: string };
    try {
      got = { out: convert(param(c.rounding), c.value, index.datetime) };
    } catch (e) {
      if (!(e instanceof BadParameter)) throw e;
      got = { error: e.message };
    }
    expect({ value: c.value, rounding: c.rounding, ...got }).toEqual(
      c as never,
    );
  }
});

import { describe, expect, test } from "bun:test";
import {
  HelpFormatter,
  makeDefaultShortHelp,
  wrapText,
} from "../../src/help/formatter.ts";

type Cases = {
  wrap: { text: string; width: number; out: string }[];
  shortHelp: { text: string; limit: number; out: string }[];
  writeText: { text: string; width: number; out: string }[];
  writeDl: { rows: [string, string][]; width: number; out: string }[];
};
const cases = (await Bun.file(
  `${import.meta.dir}/../fixtures/help-format.json`,
).json()) as Cases;

// Generated from Click itself by tools/extract/help_fixtures.py.
describe("matches Click byte for byte", () => {
  test("wrap_text with preserve_paragraphs", () => {
    for (const c of cases.wrap)
      expect(wrapText(c.text, c.width, "  ", "    ", true)).toBe(c.out);
  });
  test("make_default_short_help", () => {
    for (const c of cases.shortHelp)
      expect(makeDefaultShortHelp(c.text, c.limit)).toBe(c.out);
  });
  test("OciHelpFormatter.write_text", () => {
    for (const c of cases.writeText) {
      const f = new HelpFormatter(c.width);
      f.indent();
      f.writeText(c.text);
      expect(f.getvalue()).toBe(c.out);
    }
  });
  test("OciHelpFormatter.write_dl", () => {
    for (const c of cases.writeDl) {
      const f = new HelpFormatter(c.width);
      f.indent();
      f.writeDl(c.rows);
      expect(f.getvalue()).toBe(c.out);
    }
  });
});

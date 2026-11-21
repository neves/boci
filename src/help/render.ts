// Click's Command.format_help for one command, from its extracted HelpDoc.
import type { HelpDoc } from "../spec.ts";
import { HelpFormatter, helpWidth, makeDefaultShortHelp } from "./formatter.ts";
import { expandTabs } from "./textwrap.ts";

/** ctx.get_help(): the formatted page without trailing newlines. */
export function commandHelp(
  commandPath: string,
  doc: HelpDoc,
  width = helpWidth(),
): string {
  const f = new HelpFormatter(width);
  f.writeUsage(commandPath, doc.usage);
  if (doc.text) {
    f.writeParagraph();
    f.indentation(() => f.writeText(doc.text));
  }
  if (doc.records.length) f.section("Options", () => f.writeDl(doc.records));
  if (doc.epilog) {
    const epilog = doc.epilog;
    f.writeParagraph();
    f.indentation(() => f.writeText(epilog));
  }
  return f.getvalue().replace(/\n+$/, "");
}

export type CommandEntry = {
  name: string;
  hidden: boolean;
  help?: string;
  shortHelp?: string;
};

/** Click's Group.format_help: command help plus the "Commands" section. */
export function groupHelp(
  commandPath: string,
  doc: HelpDoc,
  children: CommandEntry[],
  width = helpWidth(),
): string {
  const f = new HelpFormatter(width);
  f.writeUsage(commandPath, doc.usage);
  if (doc.text) {
    f.writeParagraph();
    f.indentation(() => f.writeText(doc.text));
  }
  if (doc.records.length) f.section("Options", () => f.writeDl(doc.records));
  const visible = children
    .filter((c) => !c.hidden)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (visible.length) {
    const limit =
      f.width - 6 - Math.max(...visible.map((c) => [...c.name].length));
    const rows: [string, string][] = visible.map((c) => [
      c.name,
      shortHelpStr(c, limit),
    ]);
    f.section("Commands", () => f.writeDl(rows));
  }
  if (doc.epilog) {
    const epilog = doc.epilog;
    f.writeParagraph();
    f.indentation(() => f.writeText(epilog));
  }
  return f.getvalue().replace(/\n+$/, "");
}

/** click.Command.get_short_help_str */
function shortHelpStr(c: CommandEntry, limit: number): string {
  const text = c.shortHelp
    ? cleandoc(c.shortHelp)
    : c.help
      ? makeDefaultShortHelp(c.help, limit)
      : "";
  return text.trim();
}

/** inspect.cleandoc */
export function cleandoc(doc: string): string {
  const lines = expandTabs(doc).split("\n");
  let margin = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const content = line.replace(/^ +/, "");
    if (content) margin = Math.min(margin, line.length - content.length);
  }
  const out = [(lines[0] ?? "").replace(/^ +/, "")];
  for (const line of lines.slice(1))
    out.push(Number.isFinite(margin) ? line.slice(margin) : line);
  while (out.length && !out[0]?.trim()) out.shift();
  while (out.length && !out[out.length - 1]?.trim()) out.pop();
  return out.join("\n");
}

// Click's Command.format_help for one command, from its extracted HelpDoc.
import type { HelpDoc } from "../spec.ts";
import { HelpFormatter, makeDefaultShortHelp, wrapText } from "./formatter.ts";
import { expandTabs } from "./textwrap.ts";

/** ctx.get_help(): the formatted page without trailing newlines. */
export function commandHelp(
  commandPath: string,
  doc: HelpDoc,
  width: number,
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
  width: number,
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

export type ServiceInfo = { title: string; category: string };

/**
 * oci's root help (cli_root.echo_help): Click's root group help, with OCI_HELP replaced by
 * the wrapped OCI_USER_HELP, followed by every service grouped by category. Bug-compatible
 * with oci's string surgery on the Click output.
 */
export function rootHelp(
  doc: HelpDoc,
  coreCommands: CommandEntry[],
  services: Record<string, ServiceInfo>,
  ociHelp: string,
  ociUserHelp: string,
  width: number,
): string {
  const clickHelp = groupHelp("oci", doc, coreCommands, width);
  const at = clickHelp.indexOf("Commands:\n");
  const head = clickHelp.slice(0, at);
  const tail = clickHelp.slice(at + "Commands:\n".length);
  // click.wrap_text's own default width is 78, independent of the terminal.
  const userHelp = wrapText(ociUserHelp, 78, "  ", "  ", true).replace(
    /^\s+/u,
    "",
  );
  let out = `${head.replace(ociHelp, userHelp)}Commands:\n\n`;

  type Row = string[];
  let commandList: Row[] = [];
  for (const line of tail.split("\n")) {
    const first = line.trim().split(/\s+/u)[0] ?? "";
    if (line.length > 0 && first in services) continue;
    commandList.push(pySplit1(line.trim()));
  }
  const groups = new Map<string, Row[]>();
  let current = "";
  // Python's sorted() is stable; services arrive in service_mapping (alphabetical) order.
  const byCategory = Object.entries(services).sort(([, a], [, b]) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0,
  );
  for (const [key, info] of byCategory) {
    if (current !== info.category) {
      if (commandList.length) {
        groups.set(current, commandList);
        commandList = [];
      }
      current = info.category;
    }
    commandList.push([key, info.title]);
  }
  groups.set(current, commandList);

  for (const [name, rows] of groups) {
    const f = new HelpFormatter(width);
    f.write(name);
    f.write("\n\n");
    f.indent();
    f.indentation(() =>
      f.writeDl(
        rows.map((r) => [r[0] ?? "", r[1] ?? ""] as [string, string]),
        30,
        2,
        false,
      ),
    );
    out += `${f.getvalue()}\n`;
  }
  return out.replace(/\n$/, "");
}

/** Python str.split(None, 1) */
function pySplit1(s: string): string[] {
  const t = s.replace(/^\s+/u, "");
  if (!t) return [];
  const m = /^(\S+)\s+([\s\S]*)$/u.exec(t);
  return m ? [m[1] as string, m[2] as string] : [t];
}

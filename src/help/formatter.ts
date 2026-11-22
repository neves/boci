// Port of click.formatting (Click 8.4) plus oci's OciHelpFormatter tweak, which keeps
// list items (-, *, +, 1.) on their own lines. Help output must match byte for byte.
import type { Invocation } from "../io.ts";
import { TextWrapper, expandTabs, splitlines } from "./textwrap.ts";

const len = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

export function wrapText(
  text: string,
  width = 78,
  initialIndent = "",
  subsequentIndent = "",
  preserveParagraphs = false,
): string {
  const t = expandTabs(text);
  const wrapper = new TextWrapper(width, initialIndent, subsequentIndent);
  if (!preserveParagraphs) return wrapper.fill(t);

  const paragraphs: [number, boolean, string][] = [];
  let buf: string[] = [];
  let indent: number | null = null;
  const flush = () => {
    if (!buf.length) return;
    if ((buf[0] as string).trim() === "\b")
      paragraphs.push([indent ?? 0, true, buf.slice(1).join("\n")]);
    else paragraphs.push([indent ?? 0, false, buf.join(" ")]);
    buf = [];
  };
  for (let line of splitlines(t)) {
    if (!line) {
      flush();
      indent = null;
    } else {
      if (indent === null) {
        const orig = len(line);
        line = line.replace(/^\s+/u, "");
        indent = orig - len(line);
      }
      buf.push(line);
    }
  }
  flush();

  const out: string[] = [];
  for (const [ind, raw, body] of paragraphs) {
    const extra = " ".repeat(ind);
    const w = new TextWrapper(
      width,
      initialIndent + extra,
      subsequentIndent + extra,
    );
    out.push(raw ? w.indentOnly(body) : w.fill(body));
  }
  return out.join("\n\n");
}

const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** oci_cli.click_help_formatter._split_at_list_boundaries */
export function splitAtListBoundaries(text: string): string[] {
  if (text.includes("\b") || !text.includes("\n")) return [text];
  const lines = text.split("\n");
  const sections: string[] = [];
  let current = [lines[0] as string];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1] as string;
    const next = lines[i] as string;
    const inNewlineSequence =
      (i > 1 && prev === "") || (i < lines.length - 1 && next === "");
    if (!inNewlineSequence && (LIST_ITEM.test(prev) || LIST_ITEM.test(next))) {
      sections.push(current.join("\n"));
      current = [next];
    } else current.push(next);
  }
  sections.push(current.join("\n"));
  return sections;
}

/** Click's terminal-derived width: max(min(columns, 80) - 2, 50). */
export function helpWidth(
  term: Pick<Invocation, "env" | "isTTY" | "columns">,
): number {
  // shutil.get_terminal_size: $COLUMNS if a positive int, else the terminal, else 80.
  let columns = Number.parseInt(term.env.COLUMNS ?? "", 10);
  if (!(columns > 0)) columns = term.isTTY(1) ? (term.columns() ?? 80) : 80;
  return Math.max(Math.min(columns, 80) - 2, 50);
}

export class HelpFormatter {
  currentIndent = 0;
  buffer: string[] = [];
  constructor(
    public width: number,
    public indentIncrement = 2,
  ) {}

  write(s: string) {
    this.buffer.push(s);
  }
  indent() {
    this.currentIndent += this.indentIncrement;
  }
  dedent() {
    this.currentIndent -= this.indentIncrement;
  }

  writeUsage(prog: string, args = "", prefix = "Usage: ") {
    const usagePrefix = `${prefix.padStart(this.currentIndent)}${prog} `;
    const textWidth = this.width - this.currentIndent;
    if (!args) {
      this.write(usagePrefix.replace(/ +$/, ""));
      this.write("\n");
      return;
    }
    if (textWidth >= len(usagePrefix) + 20) {
      this.write(
        wrapText(args, textWidth, usagePrefix, " ".repeat(len(usagePrefix))),
      );
    } else {
      this.write(usagePrefix);
      this.write("\n");
      const ind = " ".repeat(Math.max(this.currentIndent, len(prefix)) + 4);
      this.write(wrapText(args, textWidth, ind, ind));
    }
    this.write("\n");
  }

  writeHeading(heading: string) {
    this.write(`${"".padStart(this.currentIndent)}${heading}:\n`);
  }

  writeParagraph() {
    if (this.buffer.length) this.write("\n");
  }

  /** OciHelpFormatter.write_text: each list-boundary section rewrapped separately. */
  writeText(text: string) {
    for (const section of splitAtListBoundaries(text)) {
      const ind = " ".repeat(this.currentIndent);
      this.write(wrapText(section, this.width, ind, ind, true));
      this.write("\n");
    }
  }

  /**
   * OciHelpFormatter.write_dl → click HelpFormatter.write_dl.
   * `listBoundaries: false` is plain click.HelpFormatter (oci's root help uses one).
   */
  writeDl(
    rows: [string, string][],
    colMax = 30,
    colSpacing = 2,
    listBoundaries = true,
  ) {
    let expanded: [string, string][] = [];
    let boundary = false;
    for (const [first, second] of listBoundaries ? rows : []) {
      const sections = splitAtListBoundaries(second);
      expanded.push([first, sections[0] as string]);
      if (sections.length > 1) {
        boundary = true;
        for (const s of sections.slice(1)) expanded.push(["", s]);
      }
    }
    if (!boundary) expanded = rows;

    const firstWidth = Math.max(0, ...expanded.map(([a]) => len(a)));
    const firstCol = Math.min(firstWidth, colMax) + colSpacing;
    for (const [first, second] of expanded) {
      this.write(`${"".padStart(this.currentIndent)}${first}`);
      if (!second) {
        this.write("\n");
        continue;
      }
      if (len(first) <= firstCol - colSpacing)
        this.write(" ".repeat(firstCol - len(first)));
      else {
        this.write("\n");
        this.write(" ".repeat(firstCol + this.currentIndent));
      }
      const textWidth = Math.max(this.width - firstCol - 2, 10);
      const lines = splitlines(wrapText(second, textWidth, "", "", true));
      if (lines.length) {
        this.write(`${lines[0]}\n`);
        for (const line of lines.slice(1))
          this.write(`${"".padStart(firstCol + this.currentIndent)}${line}\n`);
      } else this.write("\n");
    }
  }

  section(name: string, body: () => void) {
    this.writeParagraph();
    this.writeHeading(name);
    this.indent();
    try {
      body();
    } finally {
      this.dedent();
    }
  }

  indentation(body: () => void) {
    this.indent();
    try {
      body();
    } finally {
      this.dedent();
    }
  }

  getvalue(): string {
    return this.buffer.join("");
  }
}

/** click.utils.make_default_short_help */
export function makeDefaultShortHelp(help: string, maxLength = 45): string {
  const end = help.indexOf("\n\n");
  const para = end === -1 ? help : help.slice(0, end);
  let words = para.split(/\s+/u).filter(Boolean);
  if (!words.length) return "";
  if (words[0] === "\b") words = words.slice(1);
  let total = 0;
  const last = words.length - 1;
  let i = 0;
  let truncated = false;
  for (; i < words.length; i++) {
    const word = words[i] as string;
    total += len(word) + (i > 0 ? 1 : 0);
    if (total > maxLength) {
      truncated = true;
      break;
    }
    if (word.endsWith(".")) return words.slice(0, i + 1).join(" ");
    if (total === maxLength && i !== last) {
      truncated = true;
      break;
    }
  }
  if (!truncated) return words.join(" ");
  total += 3;
  while (i > 0) {
    total -= len(words[i] as string) + (i > 0 ? 1 : 0);
    if (total <= maxLength) break;
    i--;
  }
  return `${words.slice(0, i).join(" ")}...`;
}

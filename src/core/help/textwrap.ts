// Port of CPython's textwrap.TextWrapper as Click uses it (click._textwrap.TextWrapper:
// replace_whitespace=False, break_on_hyphens=True, break_long_words=True,
// drop_whitespace=True, no max_lines). Help output must match byte for byte.

// textwrap._whitespace = '\t\n\x0b\x0c\r '
const WS = "[\\t\\n\\x0b\\x0c\\r ]";
const NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
// Python's \w (unicode) ≈ letters, marks, numbers, underscore.
const WORD_PUNCT = "[\\p{L}\\p{M}\\p{N}_!\"'&.,?]";
// [^\d\W]: word characters that are not decimal digits.
const LETTER = "[\\p{L}\\p{M}\\p{Nl}\\p{No}_]";
const W = "[\\p{L}\\p{M}\\p{N}_]";

const WORDSEP = new RegExp(
  `(${WS}+` +
    `|(?<=${WORD_PUNCT})-{2,}(?=${W})` +
    `|${NWS}+?(?:` +
    `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})` +
    `|(?=${WS}|$)` +
    `|(?<=${WORD_PUNCT})(?=-{2,}${W})` +
    "))",
  "u",
);

export function expandTabs(text: string, tabsize = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const n = tabsize - (col % tabsize);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col = ch === "\n" || ch === "\r" ? 0 : col + 1;
    }
  }
  return out;
}

/** Python len() counts code points, not UTF-16 units. */
const len = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

function split(text: string): string[] {
  return text.split(WORDSEP).filter((c) => c !== undefined && c !== "");
}

const isBlank = (s: string) => s.trim() === "" && /^[\t\n\v\f\r ]*$/.test(s);

export class TextWrapper {
  constructor(
    public width: number,
    public initialIndent = "",
    public subsequentIndent = "",
  ) {}

  private wrapChunks(chunks: string[]): string[] {
    const lines: string[] = [];
    if (this.width <= 0)
      throw new Error(`invalid width ${this.width} (must be > 0)`);
    chunks.reverse();
    while (chunks.length) {
      const cur: string[] = [];
      let curLen = 0;
      const indent = lines.length ? this.subsequentIndent : this.initialIndent;
      const width = this.width - len(indent);
      if (isBlank(chunks[chunks.length - 1] as string) && lines.length)
        chunks.pop();
      while (chunks.length) {
        const n = len(chunks[chunks.length - 1] as string);
        if (curLen + n <= width) {
          cur.push(chunks.pop() as string);
          curLen += n;
        } else break;
      }
      if (chunks.length && len(chunks[chunks.length - 1] as string) > width) {
        // _handle_long_word with break_long_words=True
        const spaceLeft = Math.max(width - curLen, 1);
        const last = [...(chunks[chunks.length - 1] as string)];
        cur.push(last.slice(0, spaceLeft).join(""));
        chunks[chunks.length - 1] = last.slice(spaceLeft).join("");
      }
      if (cur.length && isBlank(cur[cur.length - 1] as string)) {
        cur.pop();
      }
      if (cur.length) lines.push(indent + cur.join(""));
    }
    return lines;
  }

  wrap(text: string): string[] {
    return this.wrapChunks(split(expandTabs(text)));
  }

  fill(text: string): string {
    return this.wrap(text).join("\n");
  }

  indentOnly(text: string): string {
    return splitlines(text)
      .map(
        (line, i) => `${i ? this.subsequentIndent : this.initialIndent}${line}`,
      )
      .join("\n");
  }
}

// Built from a string: literal U+2028/U+2029 would end a regex literal.
const LINE_BREAKS = new RegExp(
  // eslint-disable-next-line no-control-regex
  "\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]",
);

/** Python str.splitlines() (no keepends). */
export function splitlines(text: string): string[] {
  const parts = text.split(LINE_BREAKS);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

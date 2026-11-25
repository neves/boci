// Pure TypeScript port of Python's terminaltables.AsciiTable + visible_width.
// Matches terminaltables 3.1.10 on Python 3.12 (East Asian Width 'F' and 'W').

const ANSI_COLOR_RE = /\x1b\[[\d;]+m/g;

/** Unicode code point ranges with East Asian Width 'F' (Fullwidth) or 'W' (Wide) in Python 3.12. */
const EAST_ASIAN_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2ffb],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa88],
  [0x1fa90, 0x1fabd],
  [0x1fabf, 0x1fac5],
  [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isEastAsianWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = EAST_ASIAN_WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = EAST_ASIAN_WIDE_RANGES[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Visible column width matching `terminaltables.width_and_alignment.visible_width`. */
export function visibleWidth(str: string): number {
  const clean = str.includes("\x1b") ? str.replace(ANSI_COLOR_RE, "") : str;
  let width = 0;
  for (const ch of clean) {
    width += isEastAsianWide(ch.codePointAt(0)!) ? 2 : 1;
  }
  return width;
}

/** Split a cell into lines matching `terminaltables.width_and_alignment.align_and_pad_cell`. */
function splitCellLines(cell: string): string[] {
  if (cell.length === 0) return [""];
  // Python str.splitlines() splits on universal newlines; trailing \n adds an extra blank line.
  const parts = cell.split(
    /\r\n|\n|\r|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/,
  );
  if (cell.endsWith("\n")) return parts;
  // If cell ended with another line-break char (like \r), str.splitlines() drops the trailing empty part.
  if (
    parts.length > 1 &&
    parts[parts.length - 1] === "" &&
    /[\r\v\f\x1c-\x1e\x85\u2028\u2029]$/.test(cell)
  ) {
    parts.pop();
  }
  return parts.length ? parts : [""];
}

/** Render a grid of strings with `terminaltables.AsciiTable` borders and padding. */
export function formatAsciiTable(
  tableData: readonly (readonly string[])[],
): string {
  if (tableData.length === 0) return "++\n++\n";

  const colCount = tableData.reduce((max, row) => Math.max(max, row.length), 0);
  const innerWidths = new Array<number>(colCount).fill(0);
  const splitRows: string[][][] = [];
  const rowHeights: number[] = [];

  for (const row of tableData) {
    const cells: string[][] = [];
    let height = 1;
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? "";
      const lines = splitCellLines(cell);
      cells.push(lines);
      if (cell.length > 0) {
        let newlineCount = 0;
        for (let k = 0; k < cell.length; k++) {
          if (cell.charCodeAt(k) === 10) newlineCount++;
        }
        height = Math.max(height, newlineCount + 1, lines.length);
        for (const line of lines) {
          const w = visibleWidth(line);
          if (w > innerWidths[i]!) innerWidths[i] = w;
        }
      }
    }
    splitRows.push(cells);
    rowHeights.push(height);
  }

  const border =
    colCount === 0
      ? "++"
      : `+${innerWidths.map((w) => "-".repeat(w + 2)).join("+")}+`;

  const out: string[] = [border];
  for (let r = 0; r < splitRows.length; r++) {
    if (colCount === 0) {
      out.push("||");
    } else {
      const cells = splitRows[r]!;
      const height = rowHeights[r]!;
      for (let lineIdx = 0; lineIdx < height; lineIdx++) {
        let rowStr = "|";
        for (let c = 0; c < colCount; c++) {
          const text = cells[c]![lineIdx] ?? "";
          const padRight =
            Math.max(0, innerWidths[c]! - visibleWidth(text)) + 1;
          rowStr += ` ${text}${" ".repeat(padRight)}|`;
        }
        out.push(rowStr);
      }
    }
    if (r === 0 && splitRows.length > 1) {
      out.push(border);
    }
  }
  out.push(border);
  return `${out.join("\n")}\n`;
}

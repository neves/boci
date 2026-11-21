// Port of CPython difflib.get_close_matches (SequenceMatcher without junk, autojunk on),
// as Click uses it for "Did you mean ...?" suggestions.

class SequenceMatcher {
  a = "";
  b = "";
  private b2j = new Map<string, number[]>();
  private fullbcount: Map<string, number> | null = null;
  private blocks: [number, number, number][] | null = null;

  setSeq1(a: string) {
    this.a = a;
    this.blocks = null;
  }

  setSeq2(b: string) {
    this.b = b;
    this.blocks = null;
    this.fullbcount = null;
    this.b2j = new Map();
    [...b].forEach((ch, i) => {
      const list = this.b2j.get(ch);
      if (list) list.push(i);
      else this.b2j.set(ch, [i]);
    });
    const n = [...b].length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [ch, idxs] of [...this.b2j])
        if (idxs.length > ntest) this.b2j.delete(ch);
    }
  }

  private findLongestMatch(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): [number, number, number] {
    const a = [...this.a];
    const b = [...this.b];
    let [besti, bestj, bestsize] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    // No junk: extend by equal elements (covers "popular" ones dropped from b2j).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    )
      bestsize++;
    return [besti, bestj, bestsize];
  }

  private matchingBlocks(): [number, number, number][] {
    if (this.blocks) return this.blocks;
    const la = [...this.a].length;
    const lb = [...this.b].length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const found: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [
        number,
        number,
        number,
        number,
      ];
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        found.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let [i1, j1, k1] = [0, 0, 0];
    const out: [number, number, number][] = [];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    this.blocks = out;
    return out;
  }

  private total() {
    return [...this.a].length + [...this.b].length;
  }

  ratio() {
    const matches = this.matchingBlocks().reduce((s, [, , k]) => s + k, 0);
    return ratio(matches, this.total());
  }

  realQuickRatio() {
    return ratio(
      Math.min([...this.a].length, [...this.b].length),
      this.total(),
    );
  }

  quickRatio() {
    if (!this.fullbcount) {
      this.fullbcount = new Map();
      for (const ch of this.b)
        this.fullbcount.set(ch, (this.fullbcount.get(ch) ?? 0) + 1);
    }
    const avail = new Map<string, number>();
    let matches = 0;
    for (const ch of this.a) {
      const numb = avail.has(ch)
        ? (avail.get(ch) as number)
        : (this.fullbcount.get(ch) ?? 0);
      avail.set(ch, numb - 1);
      if (numb > 0) matches++;
    }
    return ratio(matches, this.total());
  }
}

const ratio = (matches: number, length: number) =>
  length ? (2 * matches) / length : 1;

export function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  const s = new SequenceMatcher();
  s.setSeq2(word);
  const result: [number, string][] = [];
  for (const x of possibilities) {
    s.setSeq1(x);
    if (
      s.realQuickRatio() >= cutoff &&
      s.quickRatio() >= cutoff &&
      s.ratio() >= cutoff
    )
      result.push([s.ratio(), x]);
  }
  // heapq.nlargest on (score, x) tuples: score desc, then x desc.
  result.sort(
    (p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0),
  );
  return result.slice(0, n).map(([, x]) => x);
}

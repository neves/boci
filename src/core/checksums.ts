import { basename } from "node:path";

export type Checksums = Record<string, string>;

/** Parse a `sha256sum` manifest into a map of asset basename to lowercase hex digest. */
export function parseSha256Sums(content: string): Checksums {
  const sums: Checksums = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid SHA256SUMS line: ${line}`);
    }
    const digest = match[1]!.toLowerCase();
    const asset = basename(match[2]!.trim().replace(/\\/g, "/"));
    sums[asset] = digest;
  }
  return sums;
}

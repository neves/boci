import { readFileSync } from "node:fs";
import type { Invocation } from "../lib/io.ts";

export type StdinReader = {
  readLine(): Promise<string | null>;
  consumeAll(): Promise<string>;
  isExhausted(): boolean;
};

export function createStdinReader(io: Invocation): StdinReader {
  if (io.readLine) {
    const readLineFn = io.readLine.bind(io);
    let exhausted = false;
    return {
      async readLine() {
        if (exhausted) return null;
        const line = await readLineFn();
        if (line === null) exhausted = true;
        return line;
      },
      async consumeAll() {
        if (exhausted) return "";
        if (io.isTTY(0)) {
          const line = await readLineFn();
          if (line === null) {
            exhausted = true;
            return "";
          }
          return `${line}\n`;
        }
        exhausted = true;
        try {
          return readFileSync(0, "utf8");
        } catch {
          return "";
        }
      },
      isExhausted: () => exhausted,
    };
  }
  const raw = io.stdin ?? "";
  let exhausted = raw.length === 0;
  const lines = exhausted ? [] : raw.split(/\r?\n/);
  if (!exhausted && raw.endsWith("\n")) lines.pop();
  let idx = 0;
  return {
    async readLine() {
      if (exhausted || idx >= lines.length) {
        exhausted = true;
        return null;
      }
      return lines[idx++] as string;
    },
    async consumeAll() {
      if (exhausted) return "";
      exhausted = true;
      return raw ?? "";
    },
    isExhausted: () => exhausted,
  };
}

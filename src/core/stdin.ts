import { readFileSync } from "node:fs";
import { Exit, type Invocation } from "../lib/io.ts";

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

/** One hidden-input read (getpass): stderr warning without a terminal; end of input aborts. */
export async function readHiddenLine(
  io: Invocation,
  stdin: StdinReader,
  prompt: string,
  wrapExceptions = false,
): Promise<string> {
  if (io.promptSecret) {
    const line = await io.promptSecret(prompt);
    if (line === null) {
      io.out("\n");
      io.err(wrapExceptions ? "Abort: \n" : "Aborted!\n");
      throw new Exit(1);
    }
    return line;
  }
  io.err(`Warning: Password input may be echoed.\n${prompt}`);
  const line = await stdin.readLine();
  if (line === null) {
    io.out("\n");
    io.err(wrapExceptions ? "Abort: \n" : "Aborted!\n");
    throw new Exit(1);
  }
  io.err("\n");
  return line;
}

/**
 * `click.prompt(text, hide_input=True, confirmation_prompt=True)` with no default: empty
 * input asks again, a mismatched confirmation starts over. `prompt` includes its ": ".
 */
export async function promptHiddenConfirmed(
  io: Invocation,
  stdin: StdinReader,
  prompt: string,
  wrapExceptions = false,
): Promise<string> {
  while (true) {
    let value = "";
    while (!value)
      value = await readHiddenLine(io, stdin, prompt, wrapExceptions);
    let again = "";
    while (!again)
      again = await readHiddenLine(
        io,
        stdin,
        "Repeat for confirmation: ",
        wrapExceptions,
      );
    if (value === again) return value;
    io.out("Error: The two entered values do not match.\n");
  }
}

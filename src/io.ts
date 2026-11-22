import { fstatSync, readSync, statSync } from "node:fs";

export type Env = Record<string, string | undefined>;

/**
 * Everything one boci invocation may observe or affect outside its own memory. `run()` reads
 * the environment, terminal and stdio only through this, so the same process can run many
 * invocations (the Parity harness runs cases in-process, concurrently). src/main.ts is the
 * production adapter.
 */
export type Invocation = {
  argv: string[];
  env: Env;
  /** Relative paths resolve against this. */
  cwd: string;
  out(text: string): void;
  /** Write raw bytes to stdout without UTF-8 decoding (falls back to `out` if omitted). */
  outBytes?(bytes: Uint8Array): void;
  err(text: string): void;
  /** Only decides colouring and help width, never behaviour. */
  isTTY(fd: 0 | 1 | 2): boolean;
  /** The terminal's width, asked only when stdout is a terminal. */
  columns(): number | undefined;
  /**
   * Hand the process stdio to a child (BOCI_FALLBACK). Production inherits it after flushing
   * what boci printed; an adapter without real stdio captures the child's output instead.
   */
  inheritStdio?: { flush(): Promise<void> };
  /** stdin for a child when stdio isn't inherited. */
  stdin?: string;
  /** Stream raw bytes from stdin (e.g. `os object put --file -`). Falls back to UTF-8 `stdin`. */
  stdinBytes?(): AsyncIterable<Uint8Array>;
  /** Read a secret (e.g. private key passphrase), suppressing echo when stdin is a TTY. Returns null on EOF. */
  promptSecret?(prompt: string): Promise<string | null>;
  /** Read one line from stdin (null on EOF), flushing queued stdout/stderr first. */
  readLine?(): Promise<string | null>;
};

/**
 * Process stdio without process.stdout/stderr: their first use lazily loads Node's stream
 * stack (~7 ms of start-up). Writes are queued in order and flushed with Bun.write.
 */
export function processStdio() {
  type Chunk = { fd: 1 | 2; data: string | Uint8Array };
  const queue: Chunk[] = [];
  const flush = async (): Promise<void> => {
    while (queue.length) {
      const first = queue.shift() as Chunk;
      const target = first.fd === 1 ? Bun.stdout : Bun.stderr;
      if (typeof first.data !== "string") {
        await Bun.write(target, first.data);
        continue;
      }
      let text = first.data;
      while (
        queue.length &&
        (queue[0] as Chunk).fd === first.fd &&
        typeof (queue[0] as Chunk).data === "string"
      )
        text += (queue.shift() as Chunk).data as string;
      await Bun.write(target, text);
    }
  };
  return {
    out: (text: string) => {
      queue.push({ fd: 1, data: text });
    },
    outBytes: (bytes: Uint8Array) => {
      queue.push({ fd: 1, data: bytes });
    },
    err: (text: string) => {
      queue.push({ fd: 2, data: text });
    },
    /** Write everything queued so far, in order (consecutive chunks per stream are merged). */
    flush,
    isTTY,
    columns: () => process.stdout.columns,
    async promptSecret(prompt: string): Promise<string | null> {
      if (isTTY(0)) {
        queue.push({ fd: 2, data: prompt });
        await flush();
        Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
        let line: string | null = null;
        try {
          line = readLineOrEofSync(0);
        } finally {
          Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
          if (line !== null) await Bun.write(Bun.stderr, "\n");
        }
        return line;
      }
      queue.push({
        fd: 2,
        data: `Warning: Password input may be echoed.\n${prompt}`,
      });
      await flush();
      const line = readLineOrEofSync(0);
      if (line !== null) queue.push({ fd: 2, data: "\n" });
      return line;
    },
    async readLine(): Promise<string | null> {
      await flush();
      return readLineOrEofSync(0);
    },
    async *stdinBytes(): AsyncIterable<Uint8Array> {
      for await (const chunk of Bun.stdin.stream()) {
        yield chunk;
      }
    },
  };
}

function readLineOrEofSync(fd: number): string | null {
  const bytes: number[] = [];
  const buf = new Uint8Array(1);
  let sawAny = false;
  while (true) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    sawAny = true;
    const b = buf[0] as number;
    if (b === 0x0a) break;
    bytes.push(b);
  }
  if (!sawAny) return null;
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes.pop();
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * isatty without node:tty (whose import costs ~13 ms): a character device that isn't
 * /dev/null.
 */
function isTTY(fd: 0 | 1 | 2): boolean {
  try {
    const st = fstatSync(fd);
    return st.isCharacterDevice() && st.rdev !== statSync("/dev/null").rdev;
  } catch {
    return false;
  }
}

/** Thrown to end an invocation with this exit code; `run()` turns it into its return value. */
export class Exit {
  constructor(public code: number) {}
}

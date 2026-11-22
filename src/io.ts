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
  err(text: string): void;
  /** Only decides colouring and help width, never behaviour. */
  isTTY(fd: 1 | 2): boolean;
  /** The terminal's width, asked only when stdout is a terminal. */
  columns(): number | undefined;
  /**
   * Hand the process stdio to a child (BOCI_FALLBACK). Production inherits it after flushing
   * what boci printed; an adapter without real stdio captures the child's output instead.
   */
  inheritStdio?: { flush(): Promise<void> };
  /** stdin for a child when stdio isn't inherited. */
  stdin?: string;
  /** Read a secret (e.g. private key passphrase), suppressing echo when stdin is a TTY. */
  promptSecret?(prompt: string): Promise<string>;
};

/**
 * Process stdio without process.stdout/stderr: their first use lazily loads Node's stream
 * stack (~7 ms of start-up). Writes are queued in order and flushed with Bun.write.
 */
export function processStdio() {
  type Chunk = { fd: 1 | 2; text: string };
  const queue: Chunk[] = [];
  const flush = async (): Promise<void> => {
    while (queue.length) {
      const fd = (queue[0] as Chunk).fd;
      let text = "";
      while (queue.length && (queue[0] as Chunk).fd === fd)
        text += (queue.shift() as Chunk).text;
      await Bun.write(fd === 1 ? Bun.stdout : Bun.stderr, text);
    }
  };
  return {
    out: (text: string) => {
      queue.push({ fd: 1, text });
    },
    err: (text: string) => {
      queue.push({ fd: 2, text });
    },
    /** Write everything queued so far, in order (consecutive chunks per stream are merged). */
    flush,
    isTTY,
    columns: () => process.stdout.columns,
    async promptSecret(prompt: string): Promise<string> {
      if (isTTY(0)) {
        queue.push({ fd: 2, text: prompt });
        await flush();
        Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
        try {
          return readLineSync(0);
        } finally {
          Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
          await Bun.write(Bun.stderr, "\n");
        }
      }
      queue.push({
        fd: 2,
        text: `Warning: Password input may be echoed.\n${prompt}\n`,
      });
      await flush();
      return readLineSync(0);
    },
  };
}

function readLineSync(fd: number): string {
  const bytes: number[] = [];
  const buf = new Uint8Array(1);
  while (true) {
    let n: number;
    try {
      n = readSync(fd, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const b = buf[0] as number;
    if (b === 0x0a) break;
    bytes.push(b);
  }
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

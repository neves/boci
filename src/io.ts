import { fstatSync, statSync } from "node:fs";

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
};

/**
 * Process stdio without process.stdout/stderr: their first use lazily loads Node's stream
 * stack (~7 ms of start-up). Writes are queued in order and flushed with Bun.write.
 */
export function processStdio() {
  type Chunk = { fd: 1 | 2; text: string };
  const queue: Chunk[] = [];
  return {
    out: (text: string) => {
      queue.push({ fd: 1, text });
    },
    err: (text: string) => {
      queue.push({ fd: 2, text });
    },
    /** Write everything queued so far, in order (consecutive chunks per stream are merged). */
    async flush(): Promise<void> {
      while (queue.length) {
        const fd = (queue[0] as Chunk).fd;
        let text = "";
        while (queue.length && (queue[0] as Chunk).fd === fd)
          text += (queue.shift() as Chunk).text;
        await Bun.write(fd === 1 ? Bun.stdout : Bun.stderr, text);
      }
    },
    isTTY,
    columns: () => process.stdout.columns,
  };
}

/**
 * isatty without node:tty (whose import costs ~13 ms): a character device that isn't
 * /dev/null.
 */
function isTTY(fd: 1 | 2): boolean {
  try {
    const st = fstatSync(fd);
    return st.isCharacterDevice() && st.rdev !== statSync("/dev/null").rdev;
  } catch {
    return false;
  }
}

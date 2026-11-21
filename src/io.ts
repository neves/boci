import { fstatSync, statSync } from "node:fs";

// Output without process.stdout/stderr: their first use lazily loads Node's stream stack
// (~7 ms of start-up). Writes are queued in order and flushed with Bun.write.

type Chunk = { fd: 1 | 2; text: string };
const queue: Chunk[] = [];

export const out = (text: string) => {
  queue.push({ fd: 1, text });
};
export const err = (text: string) => {
  queue.push({ fd: 2, text });
};

/** Write everything queued so far, in order (consecutive chunks per stream are merged). */
export async function flush(): Promise<void> {
  while (queue.length) {
    const fd = (queue[0] as Chunk).fd;
    let text = "";
    while (queue.length && (queue[0] as Chunk).fd === fd)
      text += (queue.shift() as Chunk).text;
    await Bun.write(fd === 1 ? Bun.stdout : Bun.stderr, text);
  }
}

/**
 * isatty without node:tty (whose import costs ~13 ms): a character device that isn't
 * /dev/null. Only decides colouring and help width, never behaviour.
 */
export function isTTY(fd: 1 | 2): boolean {
  try {
    const st = fstatSync(fd);
    return st.isCharacterDevice() && st.rdev !== statSync("/dev/null").rdev;
  } catch {
    return false;
  }
}

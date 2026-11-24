import { writeSync } from "node:fs";

/** Write a complete byte chunk, even when the underlying descriptor writes partially. */
export function writeAllBytes(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    const written = writeSync(fd, chunk, offset, chunk.length - offset);
    if (written <= 0) throw new Error("Unable to write download chunk");
    offset += written;
  }
}

// A generated download command (an operation returning a stream): the body goes to the
// `--file` option, a lazy `click.File('wb')`, as the generated callback writes it.
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { Invocation } from "../lib/io.ts";
import { Exit } from "../lib/io.ts";
import { writeAllBytes } from "./byte-writer.ts";

/**
 * Write a successful response's body to `path` (`-` is stdout). Like the generated code,
 * print click's hidden progress bar label when the file isn't stdout and the response
 * has a non-zero Content-Length; the lazy file is created only by the first chunk, so an
 * empty body leaves no file.
 */
export async function writeDownload(
  io: Invocation,
  response: Response,
  path: string,
): Promise<void> {
  const toStdout = path === "-";
  const length = response.headers.get("content-length");
  if (!toStdout && length !== null && Number(length) > 0)
    io.out("Downloading file\n");
  const decoder = new TextDecoder();
  let fd: number | undefined;
  try {
    for await (const chunk of response.body ?? []) {
      if (chunk.length === 0) continue;
      if (toStdout) {
        if (io.outBytes) await io.outBytes(chunk);
        else io.out(decoder.decode(chunk, { stream: true }));
        continue;
      }
      if (fd === undefined) {
        try {
          fd = openSync(resolve(io.cwd, path), "w");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            io.err("FileError: No such file or directory\n");
            throw new Exit(1);
          }
          throw error;
        }
      }
      writeAllBytes(fd, chunk);
    }
    if (toStdout && !io.outBytes) {
      const tail = decoder.decode();
      if (tail) io.out(tail);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

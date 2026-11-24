import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Invocation } from "../lib/io.ts";
import { checkFileAccessibility } from "../lib/accessibility.ts";
import { BadParameter, pyRepr } from "./convert.ts";
import { ProgramFile } from "./program.ts";

const NAMESPACE_HOST_LABEL_PATTERN = /^[/A-Za-z0-9_.-]+$/;
const NAMESPACE_VALIDATION_ERROR =
  "must contain only letters, digits, underscores, hyphens, forward slashes and periods";

export type OutputFileHandle = {
  rawPath: string;
  isStdout: boolean;
  fd?: number;
};

const ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: "No such file or directory",
  EISDIR: "Is a directory",
  EACCES: "Permission denied",
  ENOTDIR: "Not a directory",
  EROFS: "Read-only file system",
  EMFILE: "Too many open files",
  ENAMETOOLONG: "File name too long",
};

function osErrorReason(err: unknown): string {
  const e = err as NodeJS.ErrnoException | null;
  if (e?.code && ERRNO_MESSAGES[e.code])
    return ERRNO_MESSAGES[e.code] as string;
  const msg = e?.message ?? String(err);
  const stripped = msg.replace(/^[A-Z]+:\s*/, "").replace(/,\s*open\s+.*$/, "");
  return stripped || msg;
}

/** `validate_namespace_name` in objectstorage_cli_extended.py. */
export function validateOsNamespace(value: unknown): void {
  if (typeof value !== "string") return;
  if (
    !value ||
    value !== value.trim() ||
    !NAMESPACE_HOST_LABEL_PATTERN.test(value)
  ) {
    throw new BadParameter(NAMESPACE_VALIDATION_ERROR);
  }
}

/** Eager `click.File(mode='wb', lazy=False)`: opens the file during option conversion. */
export function openClickFileForWrite(
  io: Invocation,
  rawPath: string,
): OutputFileHandle {
  if (rawPath === "-") return { rawPath, isStdout: true };
  const resolved = resolve(io.cwd, rawPath);
  try {
    if (existsSync(resolved)) {
      if (statSync(resolved).isDirectory()) {
        throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
      }
      checkFileAccessibility(resolved, "w");
    }
    const fd = openSync(resolved, "w");
    return { rawPath, isStdout: false, fd };
  } catch (e) {
    if (e instanceof BadParameter) throw e;
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
  }
}

/** Eager `click.File(mode='r')`: checks the file can be opened during option conversion. */
export function validateClickFileForRead(
  io: Invocation,
  rawPath: string,
): void {
  if (rawPath === "-") return;
  const resolved = resolve(io.cwd, rawPath);
  let fd: number | undefined;
  try {
    if (existsSync(resolved)) {
      if (statSync(resolved).isDirectory()) {
        throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
      }
    }
    checkFileAccessibility(resolved, "r");
    fd = openSync(resolved, "r");
    if (fstatSync(fd).isDirectory()) {
      throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
    }
  } catch (e) {
    if (e instanceof BadParameter) throw e;
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

async function readStdinBytes(io: Invocation): Promise<Uint8Array> {
  if (!io.stdinBytes) return new TextEncoder().encode(io.stdin ?? "");
  const chunks: Uint8Array[] = [];
  for await (const chunk of io.stdinBytes()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * A `click.File(mode)` option for a programmed Tier B wrapper: read modes open (and here
 * read) the file during option conversion, `-` being stdin; write modes stay lazy.
 */
export async function openClickFileForProgram(
  io: Invocation,
  rawPath: string,
  mode: string,
): Promise<ProgramFile> {
  if (/[wa]/.test(mode)) return new ProgramFile(mode, undefined, rawPath);
  if (rawPath === "-")
    return new ProgramFile(mode, await readStdinBytes(io), rawPath);
  const resolved = resolve(io.cwd, rawPath);
  let fd: number | undefined;
  try {
    if (existsSync(resolved)) {
      if (statSync(resolved).isDirectory()) {
        throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
      }
    }
    checkFileAccessibility(resolved, "r");
    fd = openSync(resolved, "r");
    if (fstatSync(fd).isDirectory()) {
      throw new BadParameter(`${pyRepr(rawPath)}: Is a directory`);
    }
    return new ProgramFile(mode, readFileSync(fd), rawPath);
  } catch (e) {
    if (e instanceof BadParameter) throw e;
    throw new BadParameter(`${pyRepr(rawPath)}: ${osErrorReason(e)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

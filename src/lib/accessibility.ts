import { accessSync, constants, existsSync } from "node:fs";
import { getPosixMode } from "./posixMode.ts";

/** Verify access using native checks and the Windows POSIX mode sidecar. */
export function checkFileAccessibility(
  path: string,
  mode: "r" | "w",
  checkWriteAccess = true,
): void {
  if (mode === "r") accessSync(path, constants.R_OK);
  else if (checkWriteAccess && existsSync(path))
    accessSync(path, constants.W_OK);
  if (process.platform === "win32" && existsSync(path)) {
    const bit = mode === "r" ? 0o400 : 0o200;
    if ((getPosixMode(path) & bit) === 0)
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  }
}

/** Verify a directory is readable, including POSIX mode sidecars on Windows. */
export function checkDirectoryReadable(path: string): void {
  accessSync(path, constants.R_OK);
  if (process.platform === "win32" && (getPosixMode(path) & 0o400) === 0) {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  }
}

export function checkDirectoryWritable(path: string): void {
  if (existsSync(path)) accessSync(path, constants.W_OK);
  if (
    process.platform === "win32" &&
    existsSync(path) &&
    (getPosixMode(path) & 0o200) === 0
  ) {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  }
}

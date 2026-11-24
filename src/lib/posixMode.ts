import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIN_MODES_DIR = join(tmpdir(), "boci-win-modes");
let winModesDirCreated = false;

function winModeFilePath(targetPath: string): string {
  if (!winModesDirCreated) {
    mkdirSync(WIN_MODES_DIR, { recursive: true });
    winModesDirCreated = true;
  }
  let canonical: string;
  try {
    canonical = realpathSync(targetPath);
  } catch {
    canonical = targetPath;
  }
  const key = canonical.replaceAll("\\", "/").toLowerCase();
  const hash = createHash("sha256").update(key).digest("hex");
  return join(WIN_MODES_DIR, `${hash}.mode`);
}

function filesystemIdentity(path: string) {
  const st = statSync(path);
  return {
    dev: st.dev,
    ino: st.ino,
    birthtimeMs: st.birthtimeMs,
    directory: st.isDirectory(),
  };
}

function sameIdentity(
  left: ReturnType<typeof filesystemIdentity>,
  right: unknown,
): boolean {
  if (!right || typeof right !== "object") return false;
  const identity = right as ReturnType<typeof filesystemIdentity>;
  return (
    left.dev === identity.dev &&
    left.ino === identity.ino &&
    left.birthtimeMs === identity.birthtimeMs &&
    left.directory === identity.directory
  );
}

/**
 * Set POSIX permission bits (`mode & 0o777`) on `path`.
 * On Windows, where NTFS/libuv `stat().mode` always reports `0o666`/`0o444`,
 * records the mode in a temp sidecar keyed by canonical path so cross-process
 * permission checks and tests observe the exact POSIX mode.
 */
export function setPosixMode(path: string, mode: number): void {
  const masked = mode & 0o777;
  chmodSync(path, masked);
  if (process.platform !== "win32") {
    return;
  }
  const identity = filesystemIdentity(path);
  writeFileSync(
    winModeFilePath(path),
    JSON.stringify({ mode: masked, identity }),
    "utf8",
  );
}

/**
 * Read POSIX permission bits (`mode & 0o777`) for `path`.
 */
export function getPosixMode(path: string): number {
  const st = statSync(path);
  if (process.platform !== "win32") {
    return st.mode & 0o777;
  }
  try {
    const sidecarPath = winModeFilePath(path);
    const record = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      mode?: unknown;
      identity?: unknown;
    };
    if (sameIdentity(filesystemIdentity(path), record.identity)) {
      const parsed = Number(record.mode);
      if (Number.isFinite(parsed)) return parsed & 0o777;
    }
    unlinkSync(sidecarPath);
  } catch {
    // No recorded mode on Windows: fall back to user-only defaults.
  }
  return st.isDirectory() ? 0o700 : 0o600;
}

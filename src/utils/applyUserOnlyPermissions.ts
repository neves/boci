import { statSync } from "node:fs";
import { setPosixMode } from "./posixMode.ts";

/** Restrict `path` permissions to the current user (`0o600` for files, `0o700` for directories). */
export function applyUserOnlyPermissions(path: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(
      `Failed attempting to set permissions on path that does not exist: ${path}`,
    );
  }
  setPosixMode(path, st.isFile() ? 0o600 : 0o700);
}

import { mkdirSync } from "node:fs";
import { applyUserOnlyPermissions } from "./applyUserOnlyPermissions.ts";

/** Create `dirname` recursively and restrict its permissions to the current user (`0o700`). */
export function ensureDirectory(dirname: string): void {
  mkdirSync(dirname, { recursive: true });
  applyUserOnlyPermissions(dirname);
}

import { chmodSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandUser } from "./config.ts";
import type { Invocation } from "./io.ts";

/**
 * cli_util.apply_user_only_access_permissions (Unix): 0o600 for files, 0o700 for directories.
 */
export function applyUserOnlyAccessPermissions(path: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(
      `Failed attempting to set permissions on path that does not exist: ${path}`,
    );
  }
  chmodSync(path, st.isFile() ? 0o600 : 0o700);
}

/**
 * `oci setup repair-file-permissions --file <path>` (cli_setup.repair_file_permissions).
 */
export function runSetupRepairFilePermissions(
  io: Invocation,
  opts: {
    values: Record<string, unknown>;
    usageError: (message: string) => never;
  },
): void {
  const rawFile = String(opts.values.file ?? "");
  const expanded = expandUser(rawFile, io.env);
  const resolved = resolve(io.cwd, expanded);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    opts.usageError(`Could not find file: ${expanded}`);
  }
  if (!st.isFile()) {
    opts.usageError("This command is only supported for files.");
  }
  applyUserOnlyAccessPermissions(resolved);
}

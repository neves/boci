import { readFileSync, statSync } from "node:fs";

/** Read a config file, treating missing, unreadable, and non-file targets as absent. */
export function readConfigFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(String(error.code))
    ) {
      return null;
    }
    throw error;
  }
}

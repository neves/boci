import { homedir } from "node:os";

/** Expand a leading `~` or `~/` in `path` using `env.HOME` (falling back to `os.homedir()`). */
export function expandHomeDir(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/");
  const user = path.slice(1, slash === -1 ? undefined : slash);
  if (user) return path; // ~otheruser: left alone (not resolved without pwd lookup)
  const home = env.HOME ?? homedir();
  return (
    home.replace(/[\\/]+$/, "") + (slash === -1 ? "" : path.slice(slash)) || "/"
  );
}

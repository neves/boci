import { existsSync } from "node:fs";

/** Best-effort detached browser launch for `url` using `env.BROWSER` or platform opener. */
export function openUrlInBrowser(
  url: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const spawnDetached = (cmd: string[]): boolean => {
    try {
      const proc = Bun.spawn(cmd, {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
      return true;
    } catch {
      return false;
    }
  };

  if (env.BROWSER !== undefined) {
    for (const rawEntry of env.BROWSER.split(":")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const parts = entry.split(/\s+/);
      const bin = parts[0];
      if (!bin) continue;
      const resolvedBin =
        bin.includes("/") || existsSync(bin)
          ? existsSync(bin)
            ? bin
            : null
          : Bun.which(bin, { PATH: env.PATH ?? "" });
      if (!resolvedBin) continue;
      const hasPlaceholder = parts.some((p) => p.includes("%s"));
      const args = hasPlaceholder
        ? parts.slice(1).map((p) => p.replaceAll("%s", url))
        : [...parts.slice(1), url];
      if (spawnDetached([resolvedBin, ...args])) return true;
    }
    return false;
  }

  if (process.platform === "darwin") {
    const openBin = Bun.which("open", { PATH: env.PATH ?? "" });
    return openBin ? spawnDetached([openBin, url]) : false;
  }
  if (process.platform === "win32") {
    return spawnDetached(["cmd", "/c", "start", "", url]);
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return false;
  }
  const xdgOpen = Bun.which("xdg-open", { PATH: env.PATH ?? "" });
  return xdgOpen ? spawnDetached([xdgOpen, url]) : false;
}

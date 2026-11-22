/** Check whether `hostname` matches a comma-separated `NO_PROXY` / `no_proxy` list. */
export function isNoProxyHost(hostname: string, noProxy?: string): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const withoutPort = entry.includes(":")
      ? (entry.split(":")[0] ?? entry)
      : entry;
    const bare = withoutPort.startsWith(".")
      ? withoutPort.slice(1)
      : withoutPort;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

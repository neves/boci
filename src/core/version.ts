import pkg from "../../package.json" with { type: "json" };

/** Strip optional leading `v`/`V` and surrounding whitespace, falling back when empty. */
export function resolveBociVersion(
  raw: string | undefined,
  fallback: string = pkg.version,
): string {
  const normalized = raw?.trim().replace(/^v/i, "");
  return normalized ? normalized : fallback;
}

/** The Reference CLI version boci matches; `--version` prints it (drop-in for scripts). */
export const REFERENCE_VERSION = "3.96.3";

/** boci's own package/release version (used by `boci update`). */
export const BOCI_VERSION: string = resolveBociVersion(
  process.env.BOCI_VERSION,
  pkg.version,
);

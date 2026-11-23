import pkg from "../../package.json" with { type: "json" };

/** The Reference CLI version boci matches; `--version` prints it (drop-in for scripts). */
export const REFERENCE_VERSION = "3.96.3";

/** boci's own package/release version (used by `boci update`). */
export const BOCI_VERSION: string = pkg.version;

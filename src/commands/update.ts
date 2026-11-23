import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Exit, type Invocation } from "../lib/io.ts";
import { helpWidth } from "../core/help/formatter.ts";
import { commandHelp } from "../core/help/render.ts";
import type { HelpDoc } from "../core/spec.ts";
import { BOCI_VERSION } from "../core/version.ts";

const REPO = "neves/boci";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export type UpdateDeps = {
  currentVersion?: string;
  execPath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: () => boolean;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  existsSync?: (path: string) => boolean;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseInfo = {
  tag_name: string;
  assets: ReleaseAsset[];
};

const UPDATE_HELP_DOC: HelpDoc = {
  usage: "[OPTIONS]",
  text: "Check for a newer boci release, verify its SHA256 checksum, and replace the running binary.",
  records: [
    ["--check", "Check for updates without installing."],
    ["-h, --help", "Show this message and exit."],
  ],
  parse: { interspersed: false, ignoreUnknown: false, allowExtra: false },
};

/** Compare two semver strings (with optional leading `v`). Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

function detectMusl(checkExists: (p: string) => boolean): boolean {
  if (checkExists("/etc/alpine-release")) return true;
  try {
    const res = Bun.spawnSync(["ldd", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${res.stdout.toString()}${res.stderr.toString()}`;
    return /musl/i.test(out);
  } catch {
    return false;
  }
}

export function resolveAssetName(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string | null {
  if (platform === "linux") {
    if (arch === "x64") return musl ? "boci-linux-x64-musl" : "boci-linux-x64";
    if (arch === "arm64")
      return musl ? "boci-linux-arm64-musl" : "boci-linux-arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "boci-darwin-x64";
    if (arch === "arm64") return "boci-darwin-arm64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "boci-windows-x64.exe";
    return null;
  }
  return null;
}

export type PackageManagerInfo = {
  manager: string;
  upgradeCommand: string;
};

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function detectPackageManager(
  execPath: string,
  scriptPath: string | undefined,
  platform: NodeJS.Platform,
  checkExists: (p: string) => boolean,
): PackageManagerInfo | null {
  const realExec = safeRealpath(execPath).replace(/\\/g, "/");
  const realScript = scriptPath
    ? safeRealpath(scriptPath).replace(/\\/g, "/")
    : "";
  const lowerExec = realExec.toLowerCase();
  const lowerScript = realScript.toLowerCase();

  if (
    lowerScript.includes("/node_modules/") ||
    lowerExec.includes("/node_modules/")
  ) {
    return { manager: "npm", upgradeCommand: "npm update -g boci-cli" };
  }
  if (
    realExec.includes("/Cellar/boci/") ||
    realExec.includes("/homebrew/Cellar/") ||
    realExec.includes("/linuxbrew/.linuxbrew/Cellar/")
  ) {
    return { manager: "Homebrew", upgradeCommand: "brew upgrade boci" };
  }
  if (lowerExec.includes("/scoop/apps/boci/")) {
    return { manager: "Scoop", upgradeCommand: "scoop update boci" };
  }
  if (
    realExec.includes("/mise/installs/") ||
    realExec.includes("/.mise/installs/")
  ) {
    return {
      manager: "mise",
      upgradeCommand: "mise upgrade github:neves/boci",
    };
  }
  if (realExec.startsWith("/nix/store/")) {
    return { manager: "Nix", upgradeCommand: "nix profile upgrade boci" };
  }
  if (
    platform === "linux" &&
    realExec === "/usr/bin/boci" &&
    (checkExists("/etc/arch-release") || checkExists("/var/lib/pacman"))
  ) {
    return { manager: "AUR", upgradeCommand: "yay -Syu boci-bin" };
  }
  return null;
}

export function parseSha256Sums(
  text: string,
  assetName: string,
): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2]!.trim() === assetName) return m[1]!.toLowerCase();
  }
  return null;
}

export function replaceBinary(
  execPath: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
): void {
  const dir = dirname(execPath);
  const tmpPath = join(dir, `.boci.update.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, bytes);
  try {
    if (platform === "win32") {
      const oldPath = `${execPath}.old`;
      try {
        rmSync(oldPath, { force: true });
      } catch {
        // Best-effort cleanup of previous .old binary.
      }
      let movedOld = false;
      try {
        renameSync(execPath, oldPath);
        movedOld = true;
        renameSync(tmpPath, execPath);
      } catch (e) {
        if (movedOld) {
          try {
            renameSync(oldPath, execPath);
          } catch {
            // Best-effort rollback.
          }
        }
        throw e;
      }
      try {
        rmSync(oldPath, { force: true });
      } catch {
        // On Windows the running process may still hold a lock on .old until exit.
      }
    } else {
      chmodSync(tmpPath, 0o755);
      renameSync(tmpPath, execPath);
    }
  } catch (e) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw e;
  }
}

export async function runUpdate(
  io: Invocation,
  args: string[],
  helpRequested: boolean,
  deps: UpdateDeps = {},
): Promise<never> {
  if (helpRequested) {
    io.out(`${commandHelp("oci update", UPDATE_HELP_DOC, helpWidth(io))}\n`);
    throw new Exit(0);
  }
  const checkOnly = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    io.err(
      `Usage: oci update [OPTIONS]\n\nError: No such option/argument: ${unknown[0]}\n`,
    );
    throw new Exit(2);
  }

  const currentVersion = (deps.currentVersion ?? BOCI_VERSION).replace(
    /^v/i,
    "",
  );
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const checkExists = deps.existsSync ?? existsSync;
  const execPath = deps.execPath ?? process.execPath;
  const scriptPath = deps.scriptPath ?? process.argv[1];
  const fetchFn = deps.fetch ?? globalThis.fetch;

  if (!checkOnly) {
    const pm = detectPackageManager(
      execPath,
      scriptPath,
      platform,
      checkExists,
    );
    if (pm) {
      io.err(
        `boci is managed by ${pm.manager}. Run \`${pm.upgradeCommand}\` to update.\n`,
      );
      throw new Exit(1);
    }
  }

  let release: ReleaseInfo;
  try {
    const res = await fetchFn(LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `boci/${currentVersion}`,
      },
    });
    if (!res.ok) {
      io.err(`Failed to check latest release: HTTP ${res.status}\n`);
      throw new Exit(1);
    }
    release = (await res.json()) as ReleaseInfo;
  } catch (e) {
    if (e instanceof Exit) throw e;
    io.err(
      `Failed to check latest release: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    throw new Exit(1);
  }

  const latestVersion = release.tag_name.replace(/^v/i, "");
  if (compareSemver(currentVersion, latestVersion) >= 0) {
    io.out(`boci is already up to date (v${currentVersion}).\n`);
    throw new Exit(0);
  }

  if (checkOnly) {
    io.out(`Update available: v${currentVersion} -> v${latestVersion}\n`);
    throw new Exit(0);
  }

  const musl =
    platform === "linux" ? (deps.isMusl?.() ?? detectMusl(checkExists)) : false;
  const assetName = resolveAssetName(platform, arch, musl);
  if (!assetName) {
    io.err(`Unsupported platform/architecture: ${platform}/${arch}\n`);
    throw new Exit(1);
  }

  const binaryAsset = release.assets.find((a) => a.name === assetName);
  if (!binaryAsset) {
    io.err(`Release v${latestVersion} does not contain asset ${assetName}.\n`);
    throw new Exit(1);
  }
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!sumsAsset) {
    io.err(`Release v${latestVersion} does not contain SHA256SUMS.\n`);
    throw new Exit(1);
  }

  let expectedDigest: string | null = null;
  try {
    const sumsRes = await fetchFn(sumsAsset.browser_download_url, {
      headers: { "User-Agent": `boci/${currentVersion}` },
    });
    if (!sumsRes.ok) {
      io.err(`Failed to download SHA256SUMS: HTTP ${sumsRes.status}\n`);
      throw new Exit(1);
    }
    expectedDigest = parseSha256Sums(await sumsRes.text(), assetName);
  } catch (e) {
    if (e instanceof Exit) throw e;
    io.err(
      `Failed to download SHA256SUMS: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    throw new Exit(1);
  }
  if (!expectedDigest) {
    io.err(`SHA256SUMS does not list a checksum for ${assetName}.\n`);
    throw new Exit(1);
  }

  let binaryBytes: Uint8Array;
  try {
    const binRes = await fetchFn(binaryAsset.browser_download_url, {
      headers: { "User-Agent": `boci/${currentVersion}` },
    });
    if (!binRes.ok) {
      io.err(`Failed to download ${assetName}: HTTP ${binRes.status}\n`);
      throw new Exit(1);
    }
    binaryBytes = new Uint8Array(await binRes.arrayBuffer());
  } catch (e) {
    if (e instanceof Exit) throw e;
    io.err(
      `Failed to download ${assetName}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    throw new Exit(1);
  }

  const actualDigest = new Bun.CryptoHasher("sha256")
    .update(binaryBytes)
    .digest("hex")
    .toLowerCase();
  if (actualDigest !== expectedDigest) {
    io.err(
      `Checksum mismatch for ${assetName}: expected ${expectedDigest}, got ${actualDigest}. Aborting update.\n`,
    );
    throw new Exit(1);
  }

  try {
    replaceBinary(execPath, binaryBytes, platform);
  } catch (e) {
    io.err(
      `Failed to replace binary at ${execPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    throw new Exit(1);
  }

  io.out(`Updated boci from v${currentVersion} to v${latestVersion}.\n`);
  throw new Exit(0);
}

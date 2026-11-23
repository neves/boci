import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Checksums, parseSha256Sums } from "../src/core/checksums.ts";

export { type Checksums, parseSha256Sums };

const REPO_URL = "https://github.com/neves/boci";

export function requireSum(sums: Checksums, asset: string): string {
  const digest = sums[asset];
  if (!digest) {
    throw new Error(`Missing checksum for ${asset} in SHA256SUMS`);
  }
  return digest;
}

export function normalizeVersion(rawVersion: string): string {
  const version = rawVersion.trim().replace(/^v/, "");
  if (!version || /\s/.test(version)) {
    throw new Error(`Invalid version: "${rawVersion}"`);
  }
  return version;
}

export function updateFlakeNix(
  content: string,
  version: string,
  sums: Checksums,
): string {
  const versionPattern = /(version\s*=\s*")[^"]*(";)/;
  if (!versionPattern.test(content)) {
    throw new Error("Could not find version field in flake.nix");
  }
  let updated = content.replace(versionPattern, `$1${version}$2`);

  const assets = [
    "boci-linux-x64",
    "boci-linux-arm64",
    "boci-darwin-x64",
    "boci-darwin-arm64",
  ];
  for (const asset of assets) {
    const sha = requireSum(sums, asset);
    const assetPattern = new RegExp(
      `(asset\\s*=\\s*"${asset}";\\s*sha256\\s*=\\s*")[^"]*(";)`,
    );
    if (!assetPattern.test(updated)) {
      throw new Error(`Could not find sha256 entry for ${asset} in flake.nix`);
    }
    updated = updated.replace(assetPattern, `$1${sha}$2`);
  }
  return updated;
}

export function updateAurPkgbuild(
  content: string,
  version: string,
  sums: Checksums,
): string {
  const x64 = requireSum(sums, "boci-linux-x64");
  const arm64 = requireSum(sums, "boci-linux-arm64");

  const checks: Array<[RegExp, string, string]> = [
    [/^pkgver=.*$/m, `pkgver=${version}`, "pkgver"],
    [/^pkgrel=.*$/m, "pkgrel=1", "pkgrel"],
    [
      /^sha256sums_x86_64=\(.*\)$/m,
      `sha256sums_x86_64=('${x64}')`,
      "sha256sums_x86_64",
    ],
    [
      /^sha256sums_aarch64=\(.*\)$/m,
      `sha256sums_aarch64=('${arm64}')`,
      "sha256sums_aarch64",
    ],
  ];

  let updated = content;
  for (const [pattern, replacement, label] of checks) {
    if (!pattern.test(updated)) {
      throw new Error(`Could not find ${label} in PKGBUILD`);
    }
    updated = updated.replace(pattern, replacement);
  }
  return updated;
}

export function renderAurSrcinfo(version: string, sums: Checksums): string {
  const x64 = requireSum(sums, "boci-linux-x64");
  const arm64 = requireSum(sums, "boci-linux-arm64");

  return [
    "pkgbase = boci-bin",
    "\tpkgdesc = Fast Bun drop-in replacement for the OCI CLI",
    `\tpkgver = ${version}`,
    "\tpkgrel = 1",
    `\turl = ${REPO_URL}`,
    "\tarch = x86_64",
    "\tarch = aarch64",
    "\tlicense = MIT",
    "\tprovides = boci",
    "\tconflicts = boci",
    `\tsource_x86_64 = boci-linux-x64-${version}::${REPO_URL}/releases/download/v${version}/boci-linux-x64`,
    `\tsha256sums_x86_64 = ${x64}`,
    `\tsource_aarch64 = boci-linux-arm64-${version}::${REPO_URL}/releases/download/v${version}/boci-linux-arm64`,
    `\tsha256sums_aarch64 = ${arm64}`,
    "",
    "pkgname = boci-bin",
    "",
  ].join("\n");
}

function renderHomebrewArchBlock(
  archMethod: "on_arm" | "on_intel",
  asset: string,
  version: string,
  sha256: string,
): string {
  return `    ${archMethod} do
      url "${REPO_URL}/releases/download/v${version}/${asset}"
      sha256 "${sha256}"

      def install
        bin.install "${asset}" => "boci"
      end
    end`;
}

export function renderHomebrewFormula(
  version: string,
  sums: Checksums,
): string {
  const groups: Array<{
    osMethod: "on_macos" | "on_linux";
    targets: Array<{ archMethod: "on_arm" | "on_intel"; asset: string }>;
  }> = [
    {
      osMethod: "on_macos",
      targets: [
        { archMethod: "on_arm", asset: "boci-darwin-arm64" },
        { archMethod: "on_intel", asset: "boci-darwin-x64" },
      ],
    },
    {
      osMethod: "on_linux",
      targets: [
        { archMethod: "on_arm", asset: "boci-linux-arm64" },
        { archMethod: "on_intel", asset: "boci-linux-x64" },
      ],
    },
  ];

  const osBlocks = groups
    .map(({ osMethod, targets }) => {
      const archBlocks = targets
        .map(({ archMethod, asset }) =>
          renderHomebrewArchBlock(
            archMethod,
            asset,
            version,
            requireSum(sums, asset),
          ),
        )
        .join("\n\n");
      return `  ${osMethod} do\n${archBlocks}\n  end`;
    })
    .join("\n\n");

  return `class Boci < Formula
  desc "Fast Bun drop-in replacement for the OCI CLI"
  homepage "${REPO_URL}"
  version "${version}"
  license "MIT"

${osBlocks}

  test do
    system bin/"boci", "--version"
  end
end
`;
}

export function renderScoopManifest(version: string, sums: Checksums): string {
  const winX64 = requireSum(sums, "boci-windows-x64.exe");

  const manifest = {
    version,
    description: "Fast Bun drop-in replacement for the OCI CLI",
    homepage: REPO_URL,
    license: "MIT",
    architecture: {
      "64bit": {
        url: `${REPO_URL}/releases/download/v${version}/boci-windows-x64.exe#/boci.exe`,
        hash: winX64,
      },
    },
    bin: "boci.exe",
    checkver: "github",
    autoupdate: {
      architecture: {
        "64bit": {
          url: `${REPO_URL}/releases/download/v$version/boci-windows-x64.exe#/boci.exe`,
        },
      },
    },
  };

  return JSON.stringify(manifest, null, 2) + "\n";
}

interface CliArgs {
  version: string;
  sumsPath: string;
  flakePath?: string;
  aurDir?: string;
  homebrewOut?: string;
  scoopOut?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let version = "";
  let sumsPath = "";
  let flakePath: string | undefined;
  let aurDir: string | undefined;
  let homebrewOut: string | undefined;
  let scoopOut: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--version" && next) {
      version = next;
      i++;
    } else if (arg === "--sums" && next) {
      sumsPath = next;
      i++;
    } else if (arg === "--flake" && next) {
      flakePath = next;
      i++;
    } else if (arg === "--aur-dir" && next) {
      aurDir = next;
      i++;
    } else if (arg === "--homebrew-out" && next) {
      homebrewOut = next;
      i++;
    } else if (arg === "--scoop-out" && next) {
      scoopOut = next;
      i++;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!version) throw new Error("--version is required");
  if (!sumsPath) throw new Error("--sums is required");

  return {
    version: normalizeVersion(version),
    sumsPath,
    flakePath,
    aurDir,
    homebrewOut,
    scoopOut,
  };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const sums = parseSha256Sums(readFileSync(args.sumsPath, "utf8"));

  if (args.flakePath) {
    const current = readFileSync(args.flakePath, "utf8");
    writeFileSync(
      args.flakePath,
      updateFlakeNix(current, args.version, sums),
      "utf8",
    );
  }

  if (args.aurDir) {
    const pkgbuildPath = join(args.aurDir, "PKGBUILD");
    const currentPkgbuild = readFileSync(pkgbuildPath, "utf8");
    writeFileSync(
      pkgbuildPath,
      updateAurPkgbuild(currentPkgbuild, args.version, sums),
      "utf8",
    );
    writeFileSync(
      join(args.aurDir, ".SRCINFO"),
      renderAurSrcinfo(args.version, sums),
      "utf8",
    );
  }

  if (args.homebrewOut) {
    mkdirSync(dirname(args.homebrewOut), { recursive: true });
    writeFileSync(
      args.homebrewOut,
      renderHomebrewFormula(args.version, sums),
      "utf8",
    );
  }

  if (args.scoopOut) {
    mkdirSync(dirname(args.scoopOut), { recursive: true });
    writeFileSync(
      args.scoopOut,
      renderScoopManifest(args.version, sums),
      "utf8",
    );
  }
}

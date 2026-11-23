import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const SAMPLE_SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  boci-linux-x64",
  "2222222222222222222222222222222222222222222222222222222222222222  boci-linux-arm64",
  "3333333333333333333333333333333333333333333333333333333333333333  boci-linux-x64-musl",
  "4444444444444444444444444444444444444444444444444444444444444444  boci-linux-arm64-musl",
  "5555555555555555555555555555555555555555555555555555555555555555  boci-darwin-x64",
  "6666666666666666666666666666666666666666666666666666666666666666  boci-darwin-arm64",
  "7777777777777777777777777777777777777777777777777777777777777777  boci-windows-x64.exe",
].join("\n");

describe("update-package-managers CLI", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "boci-pkg-mgr-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("updates flake.nix, aur/PKGBUILD, aur/.SRCINFO, Homebrew formula, and Scoop manifest from SHA256SUMS", async () => {
    const dir = makeTempDir();
    const sumsPath = join(dir, "SHA256SUMS");
    writeFileSync(sumsPath, SAMPLE_SUMS + "\n");

    const flakePath = join(dir, "flake.nix");
    writeFileSync(flakePath, readFileSync(join(ROOT, "flake.nix"), "utf8"));

    const aurDir = join(dir, "aur");
    mkdirSync(aurDir, { recursive: true });
    writeFileSync(
      join(aurDir, "PKGBUILD"),
      readFileSync(join(ROOT, "aur/PKGBUILD"), "utf8").replace(
        "pkgrel=3",
        "pkgrel=1",
      ),
    );
    writeFileSync(
      join(aurDir, ".SRCINFO"),
      readFileSync(join(ROOT, "aur/.SRCINFO"), "utf8"),
    );

    const homebrewOut = join(dir, "Formula/boci.rb");
    const scoopOut = join(dir, "bucket/boci.json");

    const proc = Bun.spawn(
      [
        "bun",
        join(ROOT, "scripts/update-package-managers.ts"),
        "--version",
        "v0.2.0",
        "--sums",
        sumsPath,
        "--flake",
        flakePath,
        "--aur-dir",
        aurDir,
        "--homebrew-out",
        homebrewOut,
        "--scoop-out",
        scoopOut,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    // Nix flake.nix
    const flake = readFileSync(flakePath, "utf8");
    expect(flake).toContain('version = "0.2.0";');
    expect(flake).toContain(
      'asset = "boci-linux-x64";\n          sha256 = "1111111111111111111111111111111111111111111111111111111111111111";',
    );
    expect(flake).toContain(
      'asset = "boci-linux-arm64";\n          sha256 = "2222222222222222222222222222222222222222222222222222222222222222";',
    );
    expect(flake).toContain(
      'asset = "boci-darwin-x64";\n          sha256 = "5555555555555555555555555555555555555555555555555555555555555555";',
    );
    expect(flake).toContain(
      'asset = "boci-darwin-arm64";\n          sha256 = "6666666666666666666666666666666666666666666666666666666666666666";',
    );

    // AUR PKGBUILD
    const pkgbuild = readFileSync(join(aurDir, "PKGBUILD"), "utf8");
    expect(pkgbuild).toContain("pkgver=0.2.0");
    expect(pkgbuild).toContain("pkgrel=1");
    expect(pkgbuild).toContain(
      "sha256sums_x86_64=('1111111111111111111111111111111111111111111111111111111111111111')",
    );
    expect(pkgbuild).toContain(
      "sha256sums_aarch64=('2222222222222222222222222222222222222222222222222222222222222222')",
    );

    // AUR .SRCINFO
    const srcinfo = readFileSync(join(aurDir, ".SRCINFO"), "utf8");
    expect(srcinfo).toContain("\tpkgver = 0.2.0");
    expect(srcinfo).toContain("\tpkgrel = 1");
    expect(srcinfo).toContain(
      "\tsource_x86_64 = boci-linux-x64-0.2.0::https://github.com/neves/boci/releases/download/v0.2.0/boci-linux-x64",
    );
    expect(srcinfo).toContain(
      "\tsha256sums_x86_64 = 1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(srcinfo).toContain(
      "\tsource_aarch64 = boci-linux-arm64-0.2.0::https://github.com/neves/boci/releases/download/v0.2.0/boci-linux-arm64",
    );
    expect(srcinfo).toContain(
      "\tsha256sums_aarch64 = 2222222222222222222222222222222222222222222222222222222222222222",
    );

    // Homebrew Formula
    const formula = readFileSync(homebrewOut, "utf8");
    expect(formula).toContain('version "0.2.0"');
    expect(formula).toContain(
      'url "https://github.com/neves/boci/releases/download/v0.2.0/boci-darwin-arm64"',
    );
    expect(formula).toContain(
      'sha256 "6666666666666666666666666666666666666666666666666666666666666666"',
    );
    expect(formula).toContain(
      'url "https://github.com/neves/boci/releases/download/v0.2.0/boci-darwin-x64"',
    );
    expect(formula).toContain(
      'sha256 "5555555555555555555555555555555555555555555555555555555555555555"',
    );
    expect(formula).toContain(
      'url "https://github.com/neves/boci/releases/download/v0.2.0/boci-linux-arm64"',
    );
    expect(formula).toContain(
      'sha256 "2222222222222222222222222222222222222222222222222222222222222222"',
    );
    expect(formula).toContain(
      'url "https://github.com/neves/boci/releases/download/v0.2.0/boci-linux-x64"',
    );
    expect(formula).toContain(
      'sha256 "1111111111111111111111111111111111111111111111111111111111111111"',
    );

    // Scoop manifest
    const scoop = JSON.parse(readFileSync(scoopOut, "utf8"));
    expect(scoop.version).toBe("0.2.0");
    expect(scoop.bin).toBe("boci.exe");
    expect(scoop.architecture["64bit"].url).toBe(
      "https://github.com/neves/boci/releases/download/v0.2.0/boci-windows-x64.exe#/boci.exe",
    );
    expect(scoop.architecture["64bit"].hash).toBe(
      "7777777777777777777777777777777777777777777777777777777777777777",
    );
  });

  test("fails loudly when SHA256SUMS is missing a required binary", async () => {
    const dir = makeTempDir();
    const sumsPath = join(dir, "SHA256SUMS");
    writeFileSync(
      sumsPath,
      "1111111111111111111111111111111111111111111111111111111111111111  boci-linux-x64\n",
    );

    const proc = Bun.spawn(
      [
        "bun",
        join(ROOT, "scripts/update-package-managers.ts"),
        "--version",
        "0.2.0",
        "--sums",
        sumsPath,
        "--homebrew-out",
        join(dir, "boci.rb"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("boci-darwin-arm64");
  });
});

describe("release workflow package manager automation", () => {
  test("updates repo manifests, Homebrew, Scoop, and AUR after build-and-release and fails loudly on missing secrets", async () => {
    const text = readFileSync(
      join(ROOT, ".github/workflows/release.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(text) as {
      jobs?: Record<
        string,
        {
          needs?: string | string[];
          if?: string;
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }>;
        }
      >;
    };

    const jobs = workflow.jobs ?? {};
    const pkgJobs = Object.entries(jobs).filter(
      ([name]) => name !== "build-and-release" && name !== "publish-npm",
    );
    expect(pkgJobs.length).toBeGreaterThanOrEqual(4);

    for (const [, job] of pkgJobs) {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      expect(needs).toContain("build-and-release");
      // Must never silently skip on missing secrets at job level
      expect(job.if ?? "").not.toContain("secrets.");
    }

    // Check that required credentials are explicitly checked and fail loudly
    expect(text).toContain("HOMEBREW_TAP_TOKEN");
    expect(text).toContain("SCOOP_BUCKET_TOKEN");
    expect(text).toContain("AUR_SSH_PRIVATE_KEY");
    expect(text).toContain("scripts/update-package-managers.ts");
    expect(text).toContain("SHA256SUMS");
  });
});

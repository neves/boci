import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { Exit, type Invocation } from "../../src/lib/io.ts";
import { runUpdate } from "../../src/commands/update.ts";

function captureInvocation(
  argv: string[],
  env: Record<string, string | undefined> = {},
): { io: Invocation; out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  const io: Invocation = {
    argv,
    env: { OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True", ...env },
    cwd: process.cwd(),
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
    isTTY: () => false,
    columns: () => undefined,
  };
  return { io, out: () => stdout, err: () => stderr };
}

describe("boci update CLI & help", () => {
  test("root --help lists boci Extensions section at the end with update", async () => {
    const cap = captureInvocation(["--help"]);
    const code = await run(cap.io);
    expect(code).toBe(0);
    const out = cap.out();
    const idx = out.indexOf("\nboci Extensions\n\n");
    expect(idx).toBeGreaterThan(0);
    const tail = out.slice(idx);
    expect(tail).toContain("update");
    expect(tail).toContain("Update boci to the latest release.");
    // Must be trailing (after Storage)
    expect(idx).toBeGreaterThan(out.indexOf("\nStorage\n"));
  });

  test("boci update --help prints usage and exits 0", async () => {
    const cap = captureInvocation(["update", "--help"]);
    const code = await run(cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain("Usage: oci update [OPTIONS]");
    expect(cap.out()).toContain("--check");
  });
});

async function runUpdateCatchingExit(
  args: string[],
  deps: Parameters<typeof runUpdate>[3],
) {
  const cap = captureInvocation(["update", ...args]);
  let code = 0;
  try {
    await runUpdate(cap.io, args, false, deps);
  } catch (e) {
    if (e instanceof Exit) code = e.code;
    else throw e;
  }
  return { code, out: cap.out(), err: cap.err() };
}

describe("boci update version checks", () => {
  test("reports already up to date when latest matches currentVersion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boci-update-"));
    try {
      const bin = join(dir, "boci");
      writeFileSync(bin, "old-bin");
      const fetched: string[] = [];
      const res = await runUpdateCatchingExit([], {
        currentVersion: "0.0.1",
        execPath: bin,
        scriptPath: bin,
        platform: "linux",
        arch: "x64",
        isMusl: () => false,
        existsSync: () => false,
        fetch: (async (url: string | URL | Request) => {
          fetched.push(String(url));
          return Response.json({
            tag_name: "v0.0.1",
            assets: [],
          });
        }) as typeof fetch,
      });
      expect(res.code).toBe(0);
      expect(res.out).toContain("boci is already up to date (v0.0.1).");
      expect(fetched).toHaveLength(1);
      expect(readFileSync(bin, "utf8")).toBe("old-bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--check reports available update without downloading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boci-update-"));
    try {
      const bin = join(dir, "boci");
      writeFileSync(bin, "old-bin");
      const fetched: string[] = [];
      const res = await runUpdateCatchingExit(["--check"], {
        currentVersion: "0.0.1",
        execPath: bin,
        scriptPath: bin,
        platform: "linux",
        arch: "x64",
        isMusl: () => false,
        existsSync: () => false,
        fetch: (async (url: string | URL | Request) => {
          fetched.push(String(url));
          return Response.json({
            tag_name: "v0.2.0",
            assets: [],
          });
        }) as typeof fetch,
      });
      expect(res.code).toBe(0);
      expect(res.out).toContain("Update available: v0.0.1 -> v0.2.0");
      expect(fetched).toHaveLength(1);
      expect(readFileSync(bin, "utf8")).toBe("old-bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

describe("boci update download, verify, and replace", () => {
  test("downloads, verifies SHA256SUMS, and atomically replaces binary on POSIX", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boci-update-"));
    try {
      const bin = join(dir, "boci");
      writeFileSync(bin, "old-bin");
      const newBytes = new TextEncoder().encode("#!/bin/sh\necho new-boci\n");
      const digest = sha256Hex(newBytes);

      const res = await runUpdateCatchingExit([], {
        currentVersion: "0.0.1",
        execPath: bin,
        scriptPath: bin,
        platform: "linux",
        arch: "x64",
        isMusl: () => false,
        existsSync: () => false,
        fetch: (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.endsWith("/releases/latest")) {
            return Response.json({
              tag_name: "v0.2.0",
              assets: [
                {
                  name: "boci-linux-x64",
                  browser_download_url: "https://dl.example/boci-linux-x64",
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url: "https://dl.example/SHA256SUMS",
                },
              ],
            });
          }
          if (u === "https://dl.example/SHA256SUMS") {
            return new Response(
              `${"a".repeat(64)}  boci-darwin-arm64\n${digest}  boci-linux-x64\n`,
            );
          }
          if (u === "https://dl.example/boci-linux-x64") {
            return new Response(newBytes);
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });

      expect(res.code).toBe(0);
      expect(res.out).toContain("v0.2.0");
      expect(readFileSync(bin)).toEqual(Buffer.from(newBytes));
      expect(statSync(bin).mode & 0o111).toBeGreaterThan(0);
      expect(readdirSync(dir)).toEqual(["boci"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aborts without modifying binary when SHA256SUMS mismatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boci-update-"));
    try {
      const bin = join(dir, "boci");
      writeFileSync(bin, "old-bin");
      const newBytes = new TextEncoder().encode("tampered-binary");

      const res = await runUpdateCatchingExit([], {
        currentVersion: "0.0.1",
        execPath: bin,
        scriptPath: bin,
        platform: "linux",
        arch: "x64",
        isMusl: () => false,
        existsSync: () => false,
        fetch: (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.endsWith("/releases/latest")) {
            return Response.json({
              tag_name: "v0.2.0",
              assets: [
                {
                  name: "boci-linux-x64",
                  browser_download_url: "https://dl.example/boci-linux-x64",
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url: "https://dl.example/SHA256SUMS",
                },
              ],
            });
          }
          if (u === "https://dl.example/SHA256SUMS") {
            return new Response(`${"0".repeat(64)}  boci-linux-x64\n`);
          }
          if (u === "https://dl.example/boci-linux-x64") {
            return new Response(newBytes);
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });

      expect(res.code).toBe(1);
      expect(res.err.toLowerCase()).toContain("checksum mismatch");
      expect(readFileSync(bin, "utf8")).toBe("old-bin");
      expect(readdirSync(dir)).toEqual(["boci"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces binary on Windows (.exe + stale .old cleanup)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boci-update-win-"));
    try {
      const bin = join(dir, "boci.exe");
      const staleOld = `${bin}.old`;
      writeFileSync(bin, "old-win-exe");
      writeFileSync(staleOld, "very-old-win-exe");
      const newBytes = new TextEncoder().encode("new-win-exe");
      const digest = sha256Hex(newBytes);

      const res = await runUpdateCatchingExit([], {
        currentVersion: "0.0.1",
        execPath: bin,
        scriptPath: bin,
        platform: "win32",
        arch: "x64",
        existsSync: () => false,
        fetch: (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.endsWith("/releases/latest")) {
            return Response.json({
              tag_name: "v0.2.0",
              assets: [
                {
                  name: "boci-windows-x64.exe",
                  browser_download_url:
                    "https://dl.example/boci-windows-x64.exe",
                },
                {
                  name: "SHA256SUMS",
                  browser_download_url: "https://dl.example/SHA256SUMS",
                },
              ],
            });
          }
          if (u === "https://dl.example/SHA256SUMS") {
            return new Response(`${digest}  boci-windows-x64.exe\n`);
          }
          if (u === "https://dl.example/boci-windows-x64.exe") {
            return new Response(newBytes);
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });

      expect(res.code).toBe(0);
      expect(res.out).toContain("v0.2.0");
      expect(readFileSync(bin)).toEqual(Buffer.from(newBytes));
      expect(readdirSync(dir)).toEqual(["boci.exe"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("boci update package-manager detection", () => {
  const cases: {
    name: string;
    execPath: string;
    scriptPath?: string;
    platform: NodeJS.Platform;
    existsSync?: (p: string) => boolean;
    hint: string;
  }[] = [
    {
      name: "Homebrew",
      execPath: "/opt/homebrew/Cellar/boci/0.0.1/bin/boci",
      platform: "darwin",
      hint: "brew upgrade boci",
    },
    {
      name: "Scoop",
      execPath: "C:\\Users\\user\\scoop\\apps\\boci\\0.0.1\\boci.exe",
      platform: "win32",
      hint: "scoop update boci",
    },
    {
      name: "mise",
      execPath:
        "/home/user/.local/share/mise/installs/github-neves-boci/0.0.1/boci",
      platform: "linux",
      hint: "mise upgrade",
    },
    {
      name: "Nix",
      execPath: "/nix/store/abc123-boci-0.0.1/bin/boci",
      platform: "linux",
      hint: "nix profile upgrade",
    },
    {
      name: "AUR",
      execPath: "/usr/bin/boci",
      platform: "linux",
      existsSync: (p) => p === "/etc/arch-release",
      hint: "boci-bin",
    },
    {
      name: "npm",
      execPath: "/usr/local/bin/bun",
      scriptPath: "/usr/local/lib/node_modules/boci-cli/src/main.ts",
      platform: "linux",
      hint: "npm update -g boci-cli",
    },
  ];

  for (const c of cases) {
    test(`warns with upgrade command when installed via ${c.name}`, async () => {
      let fetchCalled = false;
      const res = await runUpdateCatchingExit([], {
        currentVersion: "0.0.1",
        execPath: c.execPath,
        scriptPath: c.scriptPath ?? c.execPath,
        platform: c.platform,
        arch: "x64",
        existsSync: c.existsSync ?? (() => false),
        fetch: async () => {
          fetchCalled = true;
          return new Response("unexpected", { status: 500 });
        },
      });
      expect(res.code).toBe(1);
      expect(res.err).toContain(c.hint);
      expect(fetchCalled).toBe(false);
    });
  }
});

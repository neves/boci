import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const RELEASE_BINARIES = [
  "boci-linux-x64",
  "boci-linux-arm64",
  "boci-linux-x64-musl",
  "boci-linux-arm64-musl",
  "boci-darwin-x64",
  "boci-darwin-arm64",
  "boci-windows-x64.exe",
];

function currentLinuxOrDarwinAsset(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  let asset = `boci-${os}-${arch}`;
  if (os === "linux" && existsSync("/etc/alpine-release")) {
    asset += "-musl";
  }
  return asset;
}

describe("release workflow SHA256SUMS", () => {
  test("generates SHA256SUMS for all release binaries and uploads it", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain("sha256sum");
    expect(workflow).toContain("dist/SHA256SUMS");
    for (const bin of RELEASE_BINARIES) {
      expect(workflow).toContain(`dist/${bin}`);
    }
  });
});

describe("site/install.sh checksum verification", () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of tempDirs.splice(0))
      rmSync(d, { recursive: true, force: true });
  });

  function startMockReleaseServer(
    routes: Record<string, { status?: number; body: string | Uint8Array }>,
  ) {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const hit = routes[path];
        if (!hit) return new Response("Not Found", { status: 404 });
        return new Response(hit.body, { status: hit.status ?? 200 });
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "boci-install-test-"));
    tempDirs.push(dir);
    return dir;
  }

  async function runInstallSh(installDir: string, baseUrl: string) {
    const proc = Bun.spawn(["sh", join(ROOT, "site/install.sh")], {
      env: {
        ...process.env,
        BOCI_INSTALL_DIR: installDir,
        BOCI_RELEASE_BASE_URL: baseUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stderr };
  }

  test("installs binary when SHA256SUMS matches", async () => {
    const asset = currentLinuxOrDarwinAsset();
    const payload = "#!/usr/bin/env sh\necho boci-test\n";
    const digest = createHash("sha256").update(payload).digest("hex");
    const sums = `${digest}  ${asset}\n${"0".repeat(64)}  other-binary\n`;

    const baseUrl = startMockReleaseServer({
      [`/${asset}`]: { body: payload },
      "/SHA256SUMS": { body: sums },
    });
    const installDir = makeTempDir();

    const proc = await runInstallSh(installDir, baseUrl);

    expect(proc.exitCode).toBe(0);
    const installedPath = join(installDir, "boci");
    expect(existsSync(installedPath)).toBe(true);
    expect(readFileSync(installedPath, "utf8")).toBe(payload);
    expect(statSync(installedPath).mode & 0o111).not.toBe(0);
  });

  test("aborts without installing when SHA256SUMS mismatches", async () => {
    const asset = currentLinuxOrDarwinAsset();
    const payload = "#!/usr/bin/env sh\necho tampered\n";
    const wrongDigest = "a".repeat(64);
    const sums = `${wrongDigest}  ${asset}\n`;

    const baseUrl = startMockReleaseServer({
      [`/${asset}`]: { body: payload },
      "/SHA256SUMS": { body: sums },
    });
    const installDir = makeTempDir();

    const proc = await runInstallSh(installDir, baseUrl);

    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toLowerCase()).toContain("checksum");
    expect(existsSync(join(installDir, "boci"))).toBe(false);
  });

  test("aborts without installing when asset is missing from SHA256SUMS", async () => {
    const asset = currentLinuxOrDarwinAsset();
    const payload = "#!/usr/bin/env sh\necho boci-test\n";
    const sums = `${"b".repeat(64)}  unrelated-asset\n`;

    const baseUrl = startMockReleaseServer({
      [`/${asset}`]: { body: payload },
      "/SHA256SUMS": { body: sums },
    });
    const installDir = makeTempDir();

    const proc = await runInstallSh(installDir, baseUrl);

    expect(proc.exitCode).not.toBe(0);
    expect(existsSync(join(installDir, "boci"))).toBe(false);
  });

  test("aborts without installing when SHA256SUMS download fails", async () => {
    const asset = currentLinuxOrDarwinAsset();
    const payload = "#!/usr/bin/env sh\necho boci-test\n";

    const baseUrl = startMockReleaseServer({
      [`/${asset}`]: { body: payload },
    });
    const installDir = makeTempDir();

    const proc = await runInstallSh(installDir, baseUrl);

    expect(proc.exitCode).not.toBe(0);
    expect(existsSync(join(installDir, "boci"))).toBe(false);
  });
});

describe("site/install.ps1 checksum verification", () => {
  test("downloads SHA256SUMS, verifies SHA256 hash, and throws on mismatch before installing", () => {
    const ps1 = readFileSync(join(ROOT, "site/install.ps1"), "utf8");
    expect(ps1).toContain("SHA256SUMS");
    expect(ps1).toContain("Get-FileHash");
    expect(ps1).toContain("SHA256");
    expect(ps1).toContain("throw");
    // Verify it downloads to a temporary path and moves to $OutFile only after verification
    const verifyIdx = ps1.indexOf("Get-FileHash");
    const moveIdx = ps1.indexOf("Move-Item");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(moveIdx).toBeGreaterThan(verifyIdx);
  });
});

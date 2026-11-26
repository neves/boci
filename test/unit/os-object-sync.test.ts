import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import {
  parseIsoTimeTruncatedToSeconds,
  requiresSync,
} from "../../src/commands/os.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object sync", () => {
  test("writes binary single-part bodies and reports directory and failed GET outcomes", async () => {
    await using sb = await createSandbox();
    const destDir = join(sb.home, "dest");
    mkdirSync(join(destDir, "directory.bin"), { recursive: true });
    const fixture = new Uint8Array([0x00, 0xff, 0x80, 0x42]);
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({
            objects: [
              {
                name: "binary.bin",
                size: fixture.length,
                timeModified: "2026-10-21T07:28:00Z",
              },
              {
                name: "directory.bin",
                size: 1,
                timeModified: "2026-10-21T07:28:00Z",
              },
              {
                name: "failed.bin",
                size: 1,
                timeModified: "2026-10-21T07:28:00Z",
              },
            ],
          });
        }
        if (req.method === "GET" && url.pathname.endsWith("/o/binary.bin"))
          return new Response(fixture);
        if (req.method === "GET" && url.pathname.endsWith("/o/failed.bin"))
          return new Response("missing", { status: 404 });
        if (req.method === "GET" && url.pathname.endsWith("/o/directory.bin"))
          return new Response(new Uint8Array([1]));
        return new Response("unexpected", { status: 404 });
      },
    });
    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "sync",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--dest-dir",
        destDir,
      ],
      env: sb.env,
      cwd: sb.home,
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
      isTTY: () => false,
      columns: () => 80,
    });
    expect(code).toBe(1);
    expect(
      new Uint8Array(await Bun.file(join(destDir, "binary.bin")).arrayBuffer()),
    ).toEqual(fixture);
    expect(JSON.parse(stdout.trim())["download-failures"]).toMatchObject({
      "failed.bin": expect.any(String),
    });
    expect(statSync(join(destDir, "directory.bin")).isDirectory()).toBe(true);
    expect(stderr).toContain("failed.bin");
  });

  test("parseIsoTimeTruncatedToSeconds drops sub-second precision", () => {
    expect(parseIsoTimeTruncatedToSeconds("2026-10-21T07:28:00.999Z")).toBe(
      Date.parse("2026-10-21T07:28:00.000Z"),
    );
    expect(parseIsoTimeTruncatedToSeconds("2026-10-21T07:28:00+00:00")).toBe(
      Date.parse("2026-10-21T07:28:00.000Z"),
    );
    expect(Number.isNaN(parseIsoTimeTruncatedToSeconds("not-a-date"))).toBe(
      true,
    );
  });

  test("requiresSync checks size and mtime direction accurately including equality boundary", async () => {
    await using sb = await createSandbox();
    const file = join(sb.home, "sample.txt");
    writeFileSync(file, "12345");
    const exactSec = 1700000000;
    utimesSync(file, exactSec, exactSec);
    const exactMs = exactSec * 1000;

    // Equal size and equal mtime -> skipped in both directions
    expect(requiresSync(file, 5, exactMs, true)).toBe(false);
    expect(requiresSync(file, 5, exactMs, false)).toBe(false);

    // Local newer than remote -> upload yes, download no
    expect(requiresSync(file, 5, exactMs - 1000, true)).toBe(true);
    expect(requiresSync(file, 5, exactMs - 1000, false)).toBe(false);

    // Local older than remote -> upload no, download yes
    expect(requiresSync(file, 5, exactMs + 1000, true)).toBe(false);
    expect(requiresSync(file, 5, exactMs + 1000, false)).toBe(true);

    // Size mismatch always requires sync in both directions
    expect(requiresSync(file, 6, exactMs + 1000, true)).toBe(true);
    expect(requiresSync(file, 6, exactMs - 1000, false)).toBe(true);
  });

  test("src-dir uploads empty folders when missing, skips when existing, and handles symlinks", async () => {
    await using sb = await createSandbox();
    const srcDir = join(sb.home, "src");
    mkdirSync(join(srcDir, "empty-new"), { recursive: true });
    mkdirSync(join(srcDir, "empty-existing"), { recursive: true });
    mkdirSync(join(srcDir, "real"), { recursive: true });
    writeFileSync(join(srcDir, "real", "a.txt"), "hello");

    const externalFile = join(sb.home, "outside.txt");
    writeFileSync(externalFile, "from symlink");
    symlinkSync(externalFile, join(srcDir, "linked.txt"));

    const uploaded: {
      name: string;
      body: string;
      ifNoneMatch: string | null;
    }[] = [];

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket") {
          return Response.json({ name: "mybucket", namespace: "myns" });
        }
        if (req.method === "HEAD" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          if (name === "empty-existing/") {
            return new Response("", {
              status: 200,
              headers: {
                etag: "etag-empty-existing",
                "content-length": "0",
                "last-modified": "Wed, 01 Jan 2020 00:00:00 GMT",
              },
            });
          }
          return Response.json(
            { code: "ObjectNotFound", message: "Not found" },
            { status: 404 },
          );
        }
        if (req.method === "PUT" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          const body = await req.text();
          uploaded.push({
            name,
            body,
            ifNoneMatch: req.headers.get("if-none-match"),
          });
          return new Response("", {
            status: 200,
            headers: {
              etag: `etag-${name}`,
              "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
            },
          });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    // Run WITH --no-follow-symlinks: linked.txt skipped, empty-new/ uploaded, empty-existing/ skipped
    let stdout = "";
    const code1 = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "sync",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--no-follow-symlinks",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (s) => {
        stdout += s;
      },
      err: () => {},
      isTTY: () => false,
      columns: () => 80,
    });

    expect(code1).toBe(0);
    const out1 = JSON.parse(stdout.trim()) as {
      "uploaded-objects": Record<string, unknown>;
      "skipped-objects": string[];
      "upload-failures": Record<string, unknown>;
    };
    expect(Object.keys(out1["uploaded-objects"]).sort()).toEqual([
      "empty-new/",
      "real/a.txt",
    ]);
    expect(out1["skipped-objects"]).toEqual(["empty-existing/"]);
    expect(out1["upload-failures"]).toEqual({});
    const emptyUpload = uploaded.find((u) => u.name === "empty-new/");
    expect(emptyUpload).toEqual({
      name: "empty-new/",
      body: "",
      ifNoneMatch: "*",
    });

    // Run WITHOUT --no-follow-symlinks: linked.txt IS uploaded
    uploaded.length = 0;
    stdout = "";
    const code2 = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "sync",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
      ],
      env: sb.env,
      cwd: sb.home,
      out: (s) => {
        stdout += s;
      },
      err: () => {},
      isTTY: () => false,
      columns: () => 80,
    });

    expect(code2).toBe(0);
    expect(uploaded.map((u) => u.name).sort()).toEqual([
      "empty-new/",
      "linked.txt",
      "real/a.txt",
    ]);
    expect(uploaded.find((u) => u.name === "linked.txt")?.body).toBe(
      "from symlink",
    );
  });

  test("dest-dir sets downloaded file mtime from timeModified (truncated to seconds) so second sync skips", async () => {
    await using sb = await createSandbox();
    const destDir = join(sb.home, "dest");
    const remoteTime = "2024-06-15T12:34:56.789Z";
    const expectedSec = Math.floor(Date.parse(remoteTime) / 1000);
    let getCount = 0;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({
            objects: [
              {
                name: "report.txt",
                size: 11,
                timeModified: remoteTime,
              },
            ],
          });
        }
        if (
          req.method === "GET" &&
          url.pathname === "/n/myns/b/mybucket/o/report.txt"
        ) {
          getCount += 1;
          return new Response("hello world", { status: 200 });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    const argv = [
      "--endpoint",
      `http://127.0.0.1:${server.port}`,
      "--no-retry",
      "os",
      "object",
      "sync",
      "-ns",
      "myns",
      "-bn",
      "mybucket",
      "--dest-dir",
      destDir,
    ];

    expect(
      await run({
        argv,
        env: sb.env,
        cwd: sb.home,
        out: () => {},
        err: () => {},
        isTTY: () => false,
        columns: () => 80,
      }),
    ).toBe(0);
    expect(getCount).toBe(1);
    const localPath = join(destDir, "report.txt");
    expect(readFileSync(localPath, "utf8")).toBe("hello world");
    expect(Math.trunc(statSync(localPath).mtimeMs / 1000)).toBe(expectedSec);

    // Second sync should skip because size & truncated mtime match!
    let stdout2 = "";
    expect(
      await run({
        argv,
        env: sb.env,
        cwd: sb.home,
        out: (s) => {
          stdout2 += s;
        },
        err: () => {},
        isTTY: () => false,
        columns: () => 80,
      }),
    ).toBe(0);
    expect(getCount).toBe(1);
    const out2 = JSON.parse(stdout2.trim()) as {
      "downloaded-objects": string[];
      "skipped-objects": string[];
    };
    expect(out2["downloaded-objects"]).toEqual([]);
    expect(out2["skipped-objects"]).toEqual(["report.txt"]);
  });

  test("dest-dir --delete respects --no-follow-symlinks and cleans up empty subdirectories", async () => {
    await using sb = await createSandbox();
    const destDir = join(sb.home, "dest");
    mkdirSync(join(destDir, "orphan-dir"), { recursive: true });
    mkdirSync(join(destDir, "sym-dir"), { recursive: true });
    writeFileSync(join(destDir, "orphan-dir", "old.txt"), "old");

    const targetFile = join(sb.home, "target.txt");
    writeFileSync(targetFile, "keep me");
    symlinkSync(targetFile, join(destDir, "sym-dir", "link.txt"));

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({ objects: [] });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    let stdout = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "sync",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--dest-dir",
        destDir,
        "--delete",
        "--no-follow-symlinks",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (s) => {
        stdout += s;
      },
      err: () => {},
      isTTY: () => false,
      columns: () => 80,
    });

    expect(code).toBe(0);
    // orphan-dir/old.txt and orphan-dir/ were deleted
    expect(existsSync(join(destDir, "orphan-dir"))).toBe(false);
    // symlink and its parent dir were preserved because of --no-follow-symlinks
    expect(existsSync(join(destDir, "sym-dir", "link.txt"))).toBe(true);
    expect(existsSync(targetFile)).toBe(true);
    expect(stdout).toContain(`Deleting : ${destDir}/orphan-dir/old.txt`);
    expect(stdout).toContain(`Deleting : ${destDir}/orphan-dir/`);
  });

  test("respects --parallel-operations-count concurrency limit during uploads", async () => {
    await using sb = await createSandbox();
    const srcDir = join(sb.home, "src");
    mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(srcDir, `f${i}.txt`), `body-${i}`);
    }

    let activePuts = 0;
    let maxConcurrentPuts = 0;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket") {
          return Response.json({ name: "mybucket", namespace: "myns" });
        }
        if (req.method === "HEAD") {
          return Response.json(
            { code: "ObjectNotFound", message: "Not found" },
            { status: 404 },
          );
        }
        if (req.method === "PUT") {
          activePuts += 1;
          maxConcurrentPuts = Math.max(maxConcurrentPuts, activePuts);
          await Bun.sleep(20);
          activePuts -= 1;
          return new Response("", {
            status: 200,
            headers: {
              etag: "etag-ok",
              "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
            },
          });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    let stdout = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "sync",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--parallel-operations-count",
        "2",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (s) => {
        stdout += s;
      },
      err: () => {},
      isTTY: () => false,
      columns: () => 80,
    });

    expect(code).toBe(0);
    expect(maxConcurrentPuts).toBe(2);
    const parsed = JSON.parse(stdout.trim()) as {
      "uploaded-objects": Record<string, unknown>;
    };
    expect(Object.keys(parsed["uploaded-objects"]).length).toBe(6);
  });
});

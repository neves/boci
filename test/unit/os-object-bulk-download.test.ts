import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { buildBulkDownloadFilter, pyDirname } from "../../src/commands/os.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object bulk-download", () => {
  test("pyDirname matches Python posixpath.dirname", () => {
    expect(pyDirname("dest/sub/")).toBe("dest/sub");
    expect(pyDirname("dest/sub/file.txt")).toBe("dest/sub");
    expect(pyDirname("dest/")).toBe("dest");
    expect(pyDirname("file.txt")).toBe("");
    expect(pyDirname("/file.txt")).toBe("/");
    expect(pyDirname("/a/b/")).toBe("/a/b");
    expect(pyDirname("///")).toBe("///");
  });

  test("buildBulkDownloadFilter matches prefix-relative and root-relative patterns", () => {
    const incWithSlashPrefix = buildBulkDownloadFilter(
      "/dl",
      ["keep.txt"],
      [],
      "level1/",
    );
    expect(incWithSlashPrefix("/dl/level1/keep.txt")).toBe(true);
    expect(incWithSlashPrefix("/dl/keep.txt")).toBe(true);
    expect(incWithSlashPrefix("/dl/level1/other.txt")).toBe(false);

    const incNoSlashPrefix = buildBulkDownloadFilter(
      "/dl",
      ["*.txt"],
      [],
      "pre",
    );
    expect(incNoSlashPrefix("/dl/pre-a.txt")).toBe(true);
    expect(incNoSlashPrefix("/dl/pre-a.log")).toBe(false);

    const excWithSlashPrefix = buildBulkDownloadFilter(
      "/dl",
      [],
      ["skip.log"],
      "logs/",
    );
    expect(excWithSlashPrefix("/dl/logs/skip.log")).toBe(false);
    expect(excWithSlashPrefix("/dl/logs/keep.log")).toBe(true);
  });

  test("downloads multiple objects in parallel across pages and respects concurrency limit", async () => {
    const objectsPage1 = [
      { name: "p1/a.txt", size: 2 },
      { name: "p1/b.txt", size: 2 },
      { name: "p1/c.txt", size: 2 },
    ];
    const objectsPage2 = [
      { name: "p2/d.txt", size: 2 },
      { name: "p2/e.txt", size: 2 },
      { name: "p2/f.txt", size: 2 },
    ];

    let activeGets = 0;
    let maxConcurrentGets = 0;
    const seenStarts: (string | null)[] = [];

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          const start = url.searchParams.get("start");
          seenStarts.push(start);
          if (!start) {
            return Response.json({
              objects: objectsPage1,
              nextStartWith: "p2/d.txt",
            });
          }
          return Response.json({ objects: objectsPage2 });
        }
        if (req.method === "GET" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          activeGets += 1;
          maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
          await Bun.sleep(25);
          activeGets -= 1;
          return new Response(`body:${name}`, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    await using sb = await createSandbox();
    const dlDir = join(sb.home, "dl");
    let stdout = "";
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-download",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--download-dir",
        dlDir,
        "--overwrite",
        "--parallel-operations-count",
        "3",
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

    expect(code).toBe(0);
    expect(seenStarts).toEqual([null, "p2/d.txt"]);
    expect(maxConcurrentGets).toBeGreaterThanOrEqual(2);
    expect(maxConcurrentGets).toBeLessThanOrEqual(3);
    const parsed = JSON.parse(stdout.trim()) as {
      "downloaded-objects": string[];
      "download-failures": Record<string, string>;
      "skipped-objects": string[];
    };
    expect(parsed["downloaded-objects"].sort()).toEqual([
      "p1/a.txt",
      "p1/b.txt",
      "p1/c.txt",
      "p2/d.txt",
      "p2/e.txt",
      "p2/f.txt",
    ]);
    expect(parsed["download-failures"]).toEqual({});
    expect(parsed["skipped-objects"]).toEqual([]);
    for (const name of parsed["downloaded-objects"]) {
      expect(readFileSync(join(dlDir, name), "utf8")).toBe(`body:${name}`);
    }
    expect(stderr).toContain("Downloaded p1/a.txt\n");
    expect(stderr).toContain("Downloaded p2/f.txt\n");
  });

  test("downloads large objects via multipart ranged GET, reassembling out-of-order parts with SSE-C headers", async () => {
    const partSize = 128 * 1024 * 1024;
    const totalSize = partSize * 2 + 100;
    const seenRanges: string[] = [];
    const seenSseAlgos: (string | null)[] = [];

    const partPayloads: Record<string, { delayMs: number; bytes: Uint8Array }> =
      {
        [`bytes=0-${partSize - 1}`]: {
          delayMs: 50,
          bytes: new Uint8Array([0x01, 0x02, 0x03]),
        },
        [`bytes=${partSize}-${partSize * 2 - 1}`]: {
          delayMs: 20,
          bytes: new Uint8Array([0x11, 0x12, 0x13]),
        },
        [`bytes=${partSize * 2}-${totalSize - 1}`]: {
          delayMs: 1,
          bytes: new Uint8Array([0xfe, 0xff]),
        },
      };

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({
            objects: [
              { name: "big.bin", size: totalSize },
              { name: "broken.bin", size: totalSize },
            ],
          });
        }
        if (req.method === "GET" && url.pathname.endsWith("/o/big.bin")) {
          const range = req.headers.get("range") ?? "";
          seenRanges.push(range);
          seenSseAlgos.push(req.headers.get("opc-sse-customer-algorithm"));
          const entry = partPayloads[range];
          if (!entry) return new Response("bad range", { status: 400 });
          await Bun.sleep(entry.delayMs);
          return new Response(entry.bytes, { status: 206 });
        }
        if (req.method === "GET" && url.pathname.endsWith("/o/broken.bin")) {
          return Response.json(
            { code: "InternalError", message: "part failed" },
            { status: 500 },
          );
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    await using sb = await createSandbox("", {
      files: {
        "aes.key": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\n",
      },
    });
    const dlDir = join(sb.home, "dl");
    let stdout = "";
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-download",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--download-dir",
        dlDir,
        "--encryption-key-file",
        join(sb.home, "aes.key"),
        "--overwrite",
        "--parallel-operations-count",
        "2",
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
    expect(seenRanges).toHaveLength(3);
    expect(seenSseAlgos).toEqual(["AES256", "AES256", "AES256"]);
    expect(
      new Uint8Array(await Bun.file(join(dlDir, "big.bin")).arrayBuffer()),
    ).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x11, 0x12, 0x13, 0xfe, 0xff]));
    expect(stderr).toContain("Downloading part for big.bin\n");
    expect(stderr).toContain("Downloaded big.bin\n");
    expect(stderr).toContain("Downloaded broken.bin\n");
    const parsed = JSON.parse(stdout.trim()) as {
      "downloaded-objects": string[];
      "download-failures": Record<string, string>;
      "skipped-objects": string[];
    };
    expect(parsed["downloaded-objects"]).toEqual(["big.bin"]);
    expect(parsed["download-failures"]["broken.bin"]).toContain(
      "Error downloading parts:",
    );
  });

  test("handles unknown-size HEAD 404, non-writable dest-dir, sequential prompts, and debug logging", async () => {
    await using sb = await createSandbox();

    // 1. Non-writable dest-dir
    const roDir = join(sb.home, "readonly-dl");
    mkdirSync(roDir);
    chmodSync(roDir, 0o500);
    let roErr = "";
    try {
      const roCode = await run({
        argv: [
          "--endpoint",
          "http://127.0.0.1:1",
          "--no-retry",
          "os",
          "object",
          "bulk-download",
          "-ns",
          "myns",
          "-bn",
          "mybucket",
          "--dest-dir",
          roDir,
        ],
        env: sb.env,
        cwd: sb.home,
        out: () => {},
        err: (s) => {
          roErr += s;
        },
        isTTY: () => false,
        columns: () => 80,
      });
      expect(roCode).toBe(1);
      expect(roErr).toBe(
        `UsageError: The specified --dest-dir ${roDir} (expanded to: ${roDir}) does not have write permissions\n`,
      );
    } finally {
      chmodSync(roDir, 0o700);
    }

    // 2. Sequential prompts (invalid -> n, y, a) + unknown-size HEAD 404 + --debug
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({
            objects: [
              { name: "f1.txt", size: 3 },
              { name: "f2.txt", size: 3 },
              { name: "f3.txt", size: 3 },
              { name: "f4.txt", size: 3 },
              { name: "ghost.txt" },
            ],
          });
        }
        if (req.method === "HEAD" && url.pathname.endsWith("/o/ghost.txt")) {
          return Response.json(
            { code: "ObjectNotFound", message: "missing" },
            { status: 404 },
          );
        }
        if (req.method === "GET" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          return new Response(`new:${name}`, { status: 200 });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    const dlDir = join(sb.home, "prompt-dl");
    mkdirSync(dlDir);
    for (const f of ["f1.txt", "f2.txt", "f3.txt", "f4.txt"]) {
      writeFileSync(join(dlDir, f), `old:${f}`);
    }

    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "--debug",
        "os",
        "object",
        "bulk-download",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--download-dir",
        dlDir,
        "--parallel-operations-count",
        "1",
      ],
      env: sb.env,
      cwd: sb.home,
      stdin: "z\nn\ny\na\n",
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
    expect(stderr).toContain(
      "Error: invalid choice: z. (choose from Y, N, A)\n",
    );
    expect(stderr).toContain(
      `Downloading f2.txt to ${join(dlDir, "f2.txt")}\n`,
    );
    expect(stderr).toContain("Failed to download ghost.txt\n");
    expect(stderr).toContain("Downloaded ghost.txt\n");
    expect(readFileSync(join(dlDir, "f1.txt"), "utf8")).toBe("old:f1.txt");
    expect(readFileSync(join(dlDir, "f2.txt"), "utf8")).toBe("new:f2.txt");
    expect(readFileSync(join(dlDir, "f3.txt"), "utf8")).toBe("new:f3.txt");
    expect(readFileSync(join(dlDir, "f4.txt"), "utf8")).toBe("new:f4.txt");

    const jsonStart = stdout.indexOf("{");
    const parsed = JSON.parse(stdout.slice(jsonStart)) as {
      "downloaded-objects": string[];
      "download-failures": Record<string, string>;
      "skipped-objects": string[];
    };
    expect(parsed["skipped-objects"]).toEqual(["f1.txt"]);
    expect(parsed["downloaded-objects"]).toEqual([
      "f2.txt",
      "f3.txt",
      "f4.txt",
    ]);
    expect(parsed["download-failures"]["ghost.txt"]).toBe(
      "Cannot download object as it does not exist",
    );
  });
});

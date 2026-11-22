import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object get binary & raw streaming", () => {
  test("writes arbitrary binary bytes verbatim to file and stdout", async () => {
    const payload = new Uint8Array([
      0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x10, 0x20, 0x00, 0xde, 0xad, 0xbe,
      0xef,
    ]);
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(payload.length) },
          });
        }
        return new Response(payload, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();

    // To file
    const outPath = join(sb.home, "binary.bin");
    let stderrFile = "";
    const fileCode = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "get",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "binary.bin",
        "--file",
        outPath,
      ],
      env: sb.env,
      cwd: sb.home,
      out: () => {},
      err: (t) => {
        stderrFile += t;
      },
      isTTY: () => false,
      columns: () => undefined,
    });
    expect(fileCode).toBe(0);
    expect(stderrFile).toBe("Downloading object\n");
    expect(new Uint8Array(await Bun.file(outPath).arrayBuffer())).toEqual(
      payload,
    );

    // To stdout via outBytes
    const stdoutChunks: Uint8Array[] = [];
    const stdoutCode = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "get",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "binary.bin",
        "--file",
        "-",
      ],
      env: sb.env,
      cwd: sb.home,
      out: () => {},
      outBytes: (b) => {
        stdoutChunks.push(b);
      },
      err: () => {},
      isTTY: () => false,
      columns: () => undefined,
    });
    expect(stdoutCode).toBe(0);
    const merged = new Uint8Array(
      stdoutChunks.reduce((n, c) => n + c.length, 0),
    );
    let offset = 0;
    for (const c of stdoutChunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    expect(merged).toEqual(payload);
  });

  test("preserves raw gzip bytes without decompressing when Content-Encoding is gzip", async () => {
    const compressed = Bun.gzipSync(new TextEncoder().encode("hello gzip\n"));
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-length": String(compressed.length),
              "content-encoding": "gzip",
            },
          });
        }
        return new Response(compressed, {
          status: 200,
          headers: {
            "content-type": "application/gzip",
            "content-encoding": "gzip",
          },
        });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const outPath = join(sb.home, "archive.gz");
    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "get",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "archive.gz",
        "--file",
        outPath,
      ],
      env: sb.env,
      cwd: sb.home,
      out: () => {},
      err: () => {},
      isTTY: () => false,
      columns: () => undefined,
    });
    expect(code).toBe(0);
    expect(new Uint8Array(await Bun.file(outPath).arrayBuffer())).toEqual(
      compressed,
    );
  });
});

describe("os object get multipart parallel download", () => {
  test("reassembles out-of-order parallel parts in exact byte order and respects concurrency limit", async () => {
    const partSize = 128 * 1024 * 1024;
    const totalSize = partSize * 3 + 100;
    const partPayloads: Record<string, { delayMs: number; bytes: Uint8Array }> =
      {
        [`bytes=0-${partSize - 1}`]: {
          delayMs: 80,
          bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
        },
        [`bytes=${partSize}-${partSize * 2 - 1}`]: {
          delayMs: 40,
          bytes: new Uint8Array([0x10, 0x11, 0x12, 0x13]),
        },
        [`bytes=${partSize * 2}-${partSize * 3 - 1}`]: {
          delayMs: 5,
          bytes: new Uint8Array([0x20, 0x21, 0x22, 0x23]),
        },
        [`bytes=${partSize * 3}-${totalSize - 1}`]: {
          delayMs: 1,
          bytes: new Uint8Array([0xfe, 0xff]),
        },
      };

    let activeGets = 0;
    let maxConcurrentGets = 0;
    const seenRanges: string[] = [];

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(totalSize) },
          });
        }
        const range = req.headers.get("range") ?? "";
        seenRanges.push(range);
        const entry = partPayloads[range];
        if (!entry) return new Response("bad range", { status: 400 });
        activeGets += 1;
        maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
        try {
          await Bun.sleep(entry.delayMs);
          return new Response(entry.bytes, {
            status: 206,
            headers: { "content-type": "application/octet-stream" },
          });
        } finally {
          activeGets -= 1;
        }
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const outPath = join(sb.home, "parallel.bin");

    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "get",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "parallel.bin",
        "--file",
        outPath,
        "--parallel-download-count",
        "2",
      ],
      env: sb.env,
      cwd: sb.home,
      out: () => {},
      err: () => {},
      isTTY: () => false,
      columns: () => undefined,
    });

    expect(code).toBe(0);
    expect(seenRanges).toHaveLength(4);
    expect(maxConcurrentGets).toBe(2);
    expect(new Uint8Array(await Bun.file(outPath).arrayBuffer())).toEqual(
      new Uint8Array([
        0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13, 0x20, 0x21, 0x22, 0x23,
        0xfe, 0xff,
      ]),
    );
  });

  test("prints progress label to stderr once multipart download reaches 0.01% of total bytes", async () => {
    const partSize = 128 * 1024 * 1024;
    const totalSize = partSize * 2;
    const chunkA = new Uint8Array(20_000).fill(0x41);
    const chunkB = new Uint8Array(20_000).fill(0x42);

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(totalSize) },
          });
        }
        const range = req.headers.get("range");
        return new Response(
          range === `bytes=0-${partSize - 1}` ? chunkA : chunkB,
          {
            status: 206,
            headers: { "content-type": "application/octet-stream" },
          },
        );
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const outPath = join(sb.home, "progress.bin");
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "get",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "progress.bin",
        "--file",
        outPath,
        "--parallel-download-count",
        "2",
      ],
      env: sb.env,
      cwd: sb.home,
      out: () => {},
      err: (t) => {
        stderr += t;
      },
      isTTY: () => false,
      columns: () => undefined,
    });

    expect(code).toBe(0);
    expect(stderr).toBe("Downloading object\n");
    const written = new Uint8Array(await Bun.file(outPath).arrayBuffer());
    expect(written.length).toBe(40_000);
    expect(written[0]).toBe(0x41);
    expect(written[20_000]).toBe(0x42);
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
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

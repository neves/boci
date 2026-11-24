import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import {
  computeMultipartMd5,
  fnmatchToRegex,
  formatBulkProgressLabel,
} from "../../src/commands/os.ts";
import { setPosixMode } from "../../src/lib/posixMode.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object bulk-upload", () => {
  test("fnmatchToRegex matches Python fnmatch semantics", () => {
    expect(fnmatchToRegex("/root/*.txt").test("/root/a.txt")).toBe(true);
    expect(fnmatchToRegex("/root/*.txt").test("/root/sub/deep/a.txt")).toBe(
      true,
    );
    expect(fnmatchToRegex("/root/*.txt").test("/root/a.log")).toBe(false);
    expect(fnmatchToRegex("/root/file?.txt").test("/root/file1.txt")).toBe(
      true,
    );
    expect(fnmatchToRegex("/root/file?.txt").test("/root/file12.txt")).toBe(
      false,
    );
    expect(fnmatchToRegex("/root/[ab].txt").test("/root/a.txt")).toBe(true);
    expect(fnmatchToRegex("/root/[!ab].txt").test("/root/c.txt")).toBe(true);
    expect(fnmatchToRegex("/root/[!ab].txt").test("/root/a.txt")).toBe(false);
    expect(fnmatchToRegex("/root/a[b").test("/root/a[b")).toBe(true);
  });

  test("formatBulkProgressLabel truncates long names like oci", () => {
    const fakeIo = {
      argv: [],
      env: {},
      cwd: "/",
      out: () => {},
      err: () => {},
      isTTY: () => false,
      columns: () => 80,
    };
    expect(formatBulkProgressLabel(fakeIo, "hello.txt", "Uploaded")).toBe(
      "Uploaded hello.txt",
    );
    expect(
      formatBulkProgressLabel(
        fakeIo,
        "very/deeply/nested/directory/structure/short.txt",
        "Uploaded",
      ),
    ).toBe("Uploaded short.txt");
    expect(
      formatBulkProgressLabel(
        fakeIo,
        "a/this-filename-alone-is-way-longer-than-thirty-one-characters.txt",
        "Uploaded",
      ),
    ).toBe("Uploaded item");
  });

  test("uploads multiple files in parallel, handles multipart files, and verifies multipart checksum", async () => {
    const mib = 1024 * 1024;
    const bigPayload = new Uint8Array(2 * mib + 128 * 1024);
    for (let i = 0; i < bigPayload.length; i++)
      bigPayload[i] = (i * 17 + 5) & 0xff;

    let activePuts = 0;
    let maxConcurrentPuts = 0;
    const singleUploads = new Map<string, string>();
    const multipartParts = new Map<number, Uint8Array>();
    let commitPayload: unknown;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket") {
          return Response.json({ name: "mybucket", namespace: "myns" });
        }
        if (req.method === "PUT" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          activePuts += 1;
          maxConcurrentPuts = Math.max(maxConcurrentPuts, activePuts);
          const body = await req.text();
          await Bun.sleep(20);
          activePuts -= 1;
          singleUploads.set(name, body);
          const md5 = new Bun.CryptoHasher("md5").update(body).digest("base64");
          return new Response(null, {
            status: 200,
            headers: { etag: `etag-${name}`, "opc-content-md5": md5 },
          });
        }
        if (req.method === "POST" && url.pathname === "/n/myns/b/mybucket/u") {
          return Response.json({ uploadId: "bulk-mp-1" });
        }
        if (req.method === "PUT" && url.pathname.includes("/u/")) {
          const partNum = Number(url.searchParams.get("uploadPartNum"));
          const bytes = new Uint8Array(await req.arrayBuffer());
          multipartParts.set(partNum, bytes);
          const md5 = new Bun.CryptoHasher("md5")
            .update(bytes)
            .digest("base64");
          return new Response(null, {
            status: 200,
            headers: {
              etag: `mp-etag-${partNum}`,
              "opc-content-md5": md5,
            },
          });
        }
        if (req.method === "POST" && url.pathname.includes("/u/")) {
          commitPayload = await req.json();
          const partMd5s = [1, 2, 3].map((n) =>
            new Bun.CryptoHasher("md5")
              .update(multipartParts.get(n) as Uint8Array)
              .digest("base64"),
          );
          return new Response(null, {
            status: 200,
            headers: {
              etag: "etag-big-mp",
              "opc-multipart-md5": computeMultipartMd5(partMd5s),
            },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await using sb = await createSandbox();
    const srcDir = join(sb.home, "upload-src");
    mkdirSync(join(srcDir, "sub"), { recursive: true });
    writeFileSync(join(srcDir, "f1.txt"), "one");
    writeFileSync(join(srcDir, "f2.txt"), "two");
    writeFileSync(join(srcDir, "f3.txt"), "three");
    writeFileSync(join(srcDir, "sub", "big.bin"), bigPayload);

    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-upload",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--part-size",
        "1",
        "--parallel-upload-count",
        "4",
        "--overwrite",
        "--verify-checksum",
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
    expect(maxConcurrentPuts).toBeGreaterThanOrEqual(2);
    expect(singleUploads.size).toBe(3);
    expect(multipartParts.size).toBe(3);
    expect(commitPayload).toEqual({
      partsToCommit: [
        { partNum: 1, etag: "mp-etag-1" },
        { partNum: 2, etag: "mp-etag-2" },
        { partNum: 3, etag: "mp-etag-3" },
      ],
      partsToExclude: [],
    });

    const parsed = JSON.parse(stdout.trim()) as {
      "uploaded-objects": Record<string, Record<string, string>>;
      "upload-failures": Record<string, unknown>;
      "skipped-objects": string[];
    };
    expect(Object.keys(parsed["uploaded-objects"]).sort()).toEqual([
      "f1.txt",
      "f2.txt",
      "f3.txt",
      "sub/big.bin",
    ]);
    expect(parsed["uploaded-objects"]["sub/big.bin"]?.etag).toBe("etag-big-mp");
    expect(
      parsed["uploaded-objects"]["sub/big.bin"]?.["verify-md5-checksum"],
    ).toStartWith("md5 checksum matches [Local: ");
    expect(parsed["upload-failures"]).toEqual({});
    expect(parsed["skipped-objects"]).toEqual([]);
    expect(stderr).toContain("Uploaded sub/big.bin\n");
  });

  test("respects --no-follow-symlinks and follows symlinks by default without looping", async () => {
    const uploaded: string[] = [];
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET") {
          return Response.json({ name: "mybucket", namespace: "myns" });
        }
        if (req.method === "PUT") {
          uploaded.push(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));
          return new Response(null, { status: 200, headers: { etag: "e1" } });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await using sb = await createSandbox();
    const externalDir = join(sb.home, "ext");
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "ext-file.txt"), "ext");
    writeFileSync(join(sb.home, "target.txt"), "target");

    const srcDir = join(sb.home, "sym-src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "real.txt"), "real");
    symlinkSync(join(sb.home, "target.txt"), join(srcDir, "link.txt"));
    symlinkSync(externalDir, join(srcDir, "linked-dir"));
    symlinkSync(srcDir, join(srcDir, "self-loop"));

    // 1. With --no-follow-symlinks: only real.txt is uploaded.
    let stdout = "";
    const codeNoFollow = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-upload",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--overwrite",
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
    expect(codeNoFollow).toBe(0);
    expect(uploaded).toEqual(["real.txt"]);

    // 2. Default (follow symlinks): uploads real.txt, link.txt, and linked-dir/ext-file.txt without infinite loop.
    uploaded.length = 0;
    stdout = "";
    const codeFollow = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-upload",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--overwrite",
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
    expect(codeFollow).toBe(0);
    expect([...uploaded].sort()).toEqual([
      "link.txt",
      "linked-dir/ext-file.txt",
      "real.txt",
    ]);
  });

  test("partial failure uploads remaining files and exits 1 with failure details", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET") {
          return Response.json({ name: "mybucket", namespace: "myns" });
        }
        if (url.pathname.endsWith("/bad.txt")) {
          return Response.json(
            { code: "NotAuthorized", message: "Forbidden object" },
            { status: 403, headers: { "opc-request-id": "req-bad" } },
          );
        }
        return new Response(null, {
          status: 200,
          headers: { etag: "etag-good" },
        });
      },
    });

    await using sb = await createSandbox();
    const srcDir = join(sb.home, "partial");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "good.txt"), "ok");
    writeFileSync(join(srcDir, "bad.txt"), "nope");

    let stdout = "";
    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-upload",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--src-dir",
        srcDir,
        "--overwrite",
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

    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.trim()) as {
      "uploaded-objects": Record<string, Record<string, string>>;
      "upload-failures": Record<string, string>;
      "skipped-objects": string[];
    };
    expect(parsed["uploaded-objects"]).toEqual({
      "good.txt": { etag: "etag-good" },
    });
    expect(parsed["upload-failures"]["bad.txt"]).toContain("NotAuthorized");
    expect(parsed["upload-failures"]["bad.txt"]).toContain("req-bad");
    expect(parsed["skipped-objects"]).toEqual([]);
  });

  test("rejects unreadable --src-dir with UsageError", async () => {
    if (process.getuid?.() === 0) return;
    await using sb = await createSandbox();
    const locked = join(sb.home, "locked");
    mkdirSync(locked, { mode: 0o000 });
    setPosixMode(locked, 0o000);
    try {
      let stderr = "";
      const code = await run({
        argv: [
          "--endpoint",
          "http://127.0.0.1:9",
          "--no-retry",
          "os",
          "object",
          "bulk-upload",
          "-ns",
          "myns",
          "-bn",
          "mybucket",
          "--src-dir",
          locked,
        ],
        env: sb.env,
        cwd: sb.home,
        out: () => {},
        err: (s) => {
          stderr += s;
        },
        isTTY: () => false,
        columns: () => 80,
      });
      expect(code).toBe(1);
      expect(stderr).toBe(
        `UsageError: The specified --src-dir ${locked} (expanded to: ${locked}) does not have read permissions\n`,
      );
    } finally {
      setPosixMode(locked, 0o700);
    }
  });
});

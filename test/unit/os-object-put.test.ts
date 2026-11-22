import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import {
  buildMultipartPutParts,
  computeCrc32cBase64,
  computeMultipartMd5,
  resolveMultipartPartSize,
} from "../../src/commands/os.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object put binary & checksums", () => {
  test("computes RFC 3720 CRC32C check vector and hello world vector", () => {
    // Standard CRC32C("123456789") = 0xe3069283 -> base64 "4waSgw=="
    expect(computeCrc32cBase64(new TextEncoder().encode("123456789"))).toBe(
      "4waSgw==",
    );
    // Matches oci-cli / crc32c on "hello world\n"
    expect(computeCrc32cBase64(new TextEncoder().encode("hello world\n"))).toBe(
      "8P9ykg==",
    );
  });

  test("uploads arbitrary binary bytes verbatim with exact content-length and checksums", async () => {
    const payload = new Uint8Array([
      0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x10, 0x20, 0x00, 0xde, 0xad, 0xbe,
      0xef,
    ]);
    const expectedMd5 = new Bun.CryptoHasher("md5")
      .update(payload)
      .digest("base64");
    const expectedSha256 = new Bun.CryptoHasher("sha256")
      .update(payload)
      .digest("base64");

    let receivedBytes: Uint8Array | undefined;
    let receivedHeaders: Record<string, string> = {};
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        receivedHeaders = Object.fromEntries(req.headers);
        receivedBytes = new Uint8Array(await req.arrayBuffer());
        return new Response(null, {
          status: 200,
          headers: {
            etag: "etag-bin",
            "opc-content-md5": expectedMd5,
            "opc-content-sha256": expectedSha256,
          },
        });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const filePath = join(sb.home, "payload.bin");
    writeFileSync(filePath, payload);

    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--file",
        filePath,
        "--opc-checksum-algorithm",
        "SHA256",
        "--verify-checksum",
        "--force",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (t) => {
        stdout += t;
      },
      err: (t) => {
        stderr += t;
      },
      isTTY: () => false,
      columns: () => undefined,
    });

    expect(code).toBe(0);
    expect(receivedBytes).toEqual(payload);
    expect(receivedHeaders["content-length"]).toBe(String(payload.length));
    expect(receivedHeaders["content-type"]).toBe("application/octet-stream");
    expect(receivedHeaders["opc-checksum-algorithm"]).toBe("SHA256");
    expect(receivedHeaders["opc-content-sha256"]).toBe(expectedSha256);
    expect(JSON.parse(stdout)).toEqual({
      etag: "etag-bin",
      "opc-content-md5": expectedMd5,
      "opc-content-sha256": expectedSha256,
    });
    expect(stderr).toContain(`md5 checksum matches [Local: ${expectedMd5}]`);
  });
});

describe("os object put multipart & stdin", () => {
  test("partitions multipart files and scales part size above 10,000 parts", () => {
    const mib = 1024 * 1024;
    expect(resolveMultipartPartSize(500 * mib)).toEqual({
      effectivePartSizeMib: undefined,
      partSizeBytes: 128 * mib,
    });
    expect(resolveMultipartPartSize(500 * mib, 10)).toEqual({
      effectivePartSizeMib: 10,
      partSizeBytes: 10 * mib,
    });
    // 10,001 MiB with 1 MiB parts exceeds 10,000 parts -> scales up to 2 MiB parts.
    expect(resolveMultipartPartSize(10_001 * mib, 1)).toEqual({
      effectivePartSizeMib: 2,
      partSizeBytes: 2 * mib,
    });

    expect(buildMultipartPutParts(2.5 * mib, mib)).toEqual([
      { partNum: 1, offset: 0, size: mib },
      { partNum: 2, offset: mib, size: mib },
      { partNum: 3, offset: 2 * mib, size: 0.5 * mib },
    ]);
  });

  test("uploads multi-part binary file in parallel, commits in order, and verifies multipart MD5", async () => {
    const mib = 1024 * 1024;
    const totalSize = 2 * mib + 512 * 1024;
    const payload = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) payload[i] = (i * 31 + 7) & 0xff;

    const uploadedParts = new Map<
      number,
      { bytes: Uint8Array; sha256?: string; md5: string; etag: string }
    >();
    let commitPayload: unknown;
    let activePartUploads = 0;
    let maxConcurrentUploads = 0;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/u")) {
          return Response.json({ uploadId: "mp-file-1" });
        }
        if (req.method === "PUT" && url.pathname.includes("/u/")) {
          const partNum = Number(url.searchParams.get("uploadPartNum"));
          activePartUploads += 1;
          maxConcurrentUploads = Math.max(
            maxConcurrentUploads,
            activePartUploads,
          );
          const bytes = new Uint8Array(await req.arrayBuffer());
          // Delay part 1 longer than part 2/3 to test out-of-order completion.
          if (partNum === 1) await Bun.sleep(30);
          else if (partNum === 2) await Bun.sleep(10);
          activePartUploads -= 1;
          const md5 = new Bun.CryptoHasher("md5")
            .update(bytes)
            .digest("base64");
          const etag = `etag-part-${partNum}`;
          uploadedParts.set(partNum, {
            bytes,
            sha256: req.headers.get("opc-content-sha256") ?? undefined,
            md5,
            etag,
          });
          return new Response(null, {
            status: 200,
            headers: { etag, "opc-content-md5": md5 },
          });
        }
        if (req.method === "POST" && url.pathname.includes("/u/")) {
          commitPayload = await req.json();
          const md5s = [1, 2, 3].map((n) => uploadedParts.get(n)!.md5);
          const multipartMd5 = computeMultipartMd5(md5s);
          return new Response(null, {
            status: 200,
            headers: {
              etag: "etag-final-mp",
              "opc-multipart-md5": multipartMd5,
            },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const filePath = join(sb.home, "big.bin");
    writeFileSync(filePath, payload);

    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--file",
        filePath,
        "--part-size",
        "1",
        "--parallel-upload-count",
        "2",
        "--opc-checksum-algorithm",
        "SHA256",
        "--verify-checksum",
        "--force",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (t) => {
        stdout += t;
      },
      err: (t) => {
        stderr += t;
      },
      isTTY: () => false,
      columns: () => undefined,
    });

    expect(code).toBe(0);
    expect(maxConcurrentUploads).toBeLessThanOrEqual(2);
    expect(uploadedParts.size).toBe(3);
    expect(uploadedParts.get(1)?.bytes).toEqual(payload.subarray(0, mib));
    expect(uploadedParts.get(2)?.bytes).toEqual(payload.subarray(mib, 2 * mib));
    expect(uploadedParts.get(3)?.bytes).toEqual(payload.subarray(2 * mib));
    for (let n = 1; n <= 3; n++) {
      const p = uploadedParts.get(n)!;
      const expectedSha256 = new Bun.CryptoHasher("sha256")
        .update(p.bytes)
        .digest("base64");
      expect(p.sha256).toBe(expectedSha256);
    }
    expect(commitPayload).toEqual({
      partsToCommit: [
        { partNum: 1, etag: "etag-part-1" },
        { partNum: 2, etag: "etag-part-2" },
        { partNum: 3, etag: "etag-part-3" },
      ],
      partsToExclude: [],
    });
    const expectedMultipartMd5 = computeMultipartMd5(
      [1, 2, 3].map((n) => uploadedParts.get(n)!.md5),
    );
    expect(JSON.parse(stdout)).toEqual({
      etag: "etag-final-mp",
      "opc-multipart-md5": expectedMultipartMd5,
    });
    expect(stderr).toContain("Upload ID: mp-file-1\n");
    expect(stderr).toContain("Split file into 3 parts for upload.\n");
    expect(stderr).toContain(
      `md5 checksum matches [Local: ${expectedMultipartMd5}]`,
    );
  });

  test("streams irregular binary chunks from stdin across multiple parts and commits in order", async () => {
    const mib = 1024 * 1024;
    const totalSize = 2 * mib + 123_456;
    const payload = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) payload[i] = (i * 17 + 3) & 0xff;

    const uploadedParts = new Map<
      number,
      { bytes: Uint8Array; contentMd5: string | null }
    >();
    let commitPayload: unknown;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/u")) {
          return Response.json({ uploadId: "mp-stdin-1" });
        }
        if (req.method === "PUT" && url.pathname.includes("/u/")) {
          const partNum = Number(url.searchParams.get("uploadPartNum"));
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (partNum === 1) await Bun.sleep(25);
          const md5 = new Bun.CryptoHasher("md5")
            .update(bytes)
            .digest("base64");
          uploadedParts.set(partNum, {
            bytes,
            contentMd5: req.headers.get("content-md5"),
          });
          return new Response(null, {
            status: 200,
            headers: {
              etag: `stdin-etag-${partNum}`,
              "opc-content-md5": md5,
            },
          });
        }
        if (req.method === "POST" && url.pathname.includes("/u/")) {
          commitPayload = await req.json();
          return new Response(null, {
            status: 200,
            headers: { etag: "etag-stdin-final" },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();

    // Yield payload in uneven chunk sizes (including small and large chunks).
    const chunkSizes = [7, 13_333, 600_000, 900_000, 250_000, 500_000];
    async function* binaryChunks(): AsyncIterable<Uint8Array> {
      let offset = 0;
      let idx = 0;
      while (offset < payload.length) {
        const size = chunkSizes[idx++ % chunkSizes.length] as number;
        const end = Math.min(offset + size, payload.length);
        yield payload.subarray(offset, end);
        offset = end;
      }
    }

    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: [
        "--endpoint",
        endpoint,
        "--no-retry",
        "os",
        "object",
        "put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "stream.bin",
        "--file",
        "-",
        "--part-size",
        "1",
        "--parallel-upload-count",
        "2",
        "--force",
      ],
      env: sb.env,
      cwd: sb.home,
      out: (t) => {
        stdout += t;
      },
      err: (t) => {
        stderr += t;
      },
      isTTY: () => false,
      columns: () => undefined,
      stdinBytes: binaryChunks,
    });

    expect(code).toBe(0);
    expect(uploadedParts.size).toBe(3);
    expect(uploadedParts.get(1)?.bytes).toEqual(payload.subarray(0, mib));
    expect(uploadedParts.get(2)?.bytes).toEqual(payload.subarray(mib, 2 * mib));
    expect(uploadedParts.get(3)?.bytes).toEqual(payload.subarray(2 * mib));
    for (let n = 1; n <= 3; n++) {
      const p = uploadedParts.get(n)!;
      expect(p.contentMd5).toBe(
        new Bun.CryptoHasher("md5").update(p.bytes).digest("base64"),
      );
    }
    expect(commitPayload).toEqual({
      partsToCommit: [
        { partNum: 1, etag: "stdin-etag-1" },
        { partNum: 2, etag: "stdin-etag-2" },
        { partNum: 3, etag: "stdin-etag-3" },
      ],
      partsToExclude: [],
    });
    expect(JSON.parse(stdout)).toEqual({ etag: "etag-stdin-final" });
    expect(stderr).toBe("Uploading object part\n");
  });

  test("spawns boci and streams raw non-UTF-8 binary stdin verbatim", async () => {
    const rawBinary = new Uint8Array([
      0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f, 0xde, 0xad, 0xbe, 0xef, 0x00,
    ]);
    let uploadedBytes: Uint8Array | undefined;
    let uploadedMd5: string | undefined;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/u")) {
          return Response.json({ uploadId: "mp-spawn-1" });
        }
        if (req.method === "PUT" && url.pathname.includes("/u/")) {
          uploadedBytes = new Uint8Array(await req.arrayBuffer());
          uploadedMd5 = req.headers.get("content-md5") ?? undefined;
          return new Response(null, {
            status: 200,
            headers: {
              etag: "spawn-etag-1",
              "opc-content-md5": uploadedMd5 ?? "",
            },
          });
        }
        if (req.method === "POST" && url.pathname.includes("/u/")) {
          return new Response(null, {
            status: 200,
            headers: { etag: "spawn-commit-etag" },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    await using sb = await createSandbox();
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "..", "src", "main.ts"),
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--name",
        "raw.bin",
        "--file",
        "-",
        "--force",
      ],
      {
        cwd: sb.home,
        env: sb.env,
        stdin: new Blob([rawBinary]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(uploadedBytes).toEqual(rawBinary);
    expect(uploadedMd5).toBe(
      new Bun.CryptoHasher("md5").update(rawBinary).digest("base64"),
    );
    expect(JSON.parse(stdout)).toEqual({ etag: "spawn-commit-etag" });
    expect(stderr).toBe("Uploading object part\n");
  });
});

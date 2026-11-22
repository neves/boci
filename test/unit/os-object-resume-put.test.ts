import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/core/cli.ts";
import { pyFloatRepr } from "../../src/commands/os.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object resume-put", () => {
  test("formats MiB floats like Python str(float)", () => {
    expect(pyFloatRepr(0)).toBe("0.0");
    expect(pyFloatRepr(1)).toBe("1.0");
    expect(pyFloatRepr(128)).toBe("128.0");
    expect(pyFloatRepr(0.5)).toBe("0.5");
    expect(pyFloatRepr(5 / (1024 * 1024))).toBe("4.76837158203125e-06");
    expect(pyFloatRepr(104 / (1024 * 1024))).toBe("9.918212890625e-05");
    expect(pyFloatRepr(105 / (1024 * 1024))).toBe("0.00010013580322265625");
  });

  test("skips already-uploaded parts across pages, uploads missing parts in parallel, and commits in order", async () => {
    const mib = 1024 * 1024;
    // 4 parts: 1 MiB, 1 MiB, 1 MiB, 512 KiB
    const totalSize = 3 * mib + 512 * 1024;
    const payload = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) payload[i] = (i * 29 + 11) & 0xff;

    const listPagesSeen: (string | null)[] = [];
    const uploadedParts = new Map<number, Uint8Array>();
    let activeUploads = 0;
    let maxConcurrentUploads = 0;
    let commitPayload: unknown;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname.includes("/u/")) {
          const page = url.searchParams.get("page");
          listPagesSeen.push(page);
          if (page === null) {
            return Response.json(
              [
                {
                  partNumber: 1,
                  etag: "existing-etag-1",
                  size: mib,
                  md5: "md5-part-1",
                },
              ],
              { headers: { "opc-next-page": "p2" } },
            );
          }
          return Response.json([
            {
              partNumber: 4,
              etag: "existing-etag-4",
              size: 512 * 1024,
              md5: "md5-part-4",
            },
          ]);
        }
        if (req.method === "PUT" && url.pathname.includes("/u/")) {
          const partNum = Number(url.searchParams.get("uploadPartNum"));
          activeUploads += 1;
          maxConcurrentUploads = Math.max(maxConcurrentUploads, activeUploads);
          const bytes = new Uint8Array(await req.arrayBuffer());
          // Delay part 2 longer than part 3 to verify out-of-order completion commits in order.
          if (partNum === 2) await Bun.sleep(25);
          activeUploads -= 1;
          uploadedParts.set(partNum, bytes);
          const md5 = new Bun.CryptoHasher("md5")
            .update(bytes)
            .digest("base64");
          return new Response(null, {
            status: 200,
            headers: {
              etag: `new-etag-${partNum}`,
              "opc-content-md5": md5,
            },
          });
        }
        if (req.method === "POST" && url.pathname.includes("/u/")) {
          commitPayload = await req.json();
          return new Response(null, {
            status: 200,
            headers: {
              etag: "etag-resumed-final",
              "opc-multipart-md5": "fake-multipart-md5-4",
            },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const filePath = join(sb.home, "resume.bin");
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
        "resume-put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--file",
        filePath,
        "--upload-id",
        "upload-multi-resume",
        "--part-size",
        "1",
        "--parallel-upload-count",
        "2",
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
    expect(listPagesSeen).toEqual([null, "p2"]);
    expect(maxConcurrentUploads).toBeLessThanOrEqual(2);
    expect([...uploadedParts.keys()].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(uploadedParts.get(2)).toEqual(payload.subarray(mib, 2 * mib));
    expect(uploadedParts.get(3)).toEqual(payload.subarray(2 * mib, 3 * mib));
    expect(commitPayload).toEqual({
      partsToCommit: [
        { partNum: 1, etag: "existing-etag-1" },
        { partNum: 2, etag: "new-etag-2" },
        { partNum: 3, etag: "new-etag-3" },
        { partNum: 4, etag: "existing-etag-4" },
      ],
      partsToExclude: [],
    });
    expect(JSON.parse(stdout)).toEqual({
      etag: "etag-resumed-final",
      "opc-multipart-md5": "fake-multipart-md5-4",
    });
    expect(stderr).toBe("Uploading object\n");
  });

  test("rejects mismatched part size on a multi-part file before uploading", async () => {
    const mib = 1024 * 1024;
    const payload = new Uint8Array(2 * mib);
    let sawPut = false;

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.method === "GET") {
          return Response.json([
            {
              partNumber: 1,
              etag: "existing-etag-1",
              size: 2 * mib,
              md5: "md5-1",
            },
          ]);
        }
        sawPut = true;
        return new Response("unexpected", { status: 500 });
      },
    });

    const endpoint = `http://127.0.0.1:${server.port}`;
    await using sb = await createSandbox();
    const filePath = join(sb.home, "mismatch.bin");
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
        "resume-put",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--file",
        filePath,
        "--upload-id",
        "upload-mismatch-size",
        "--part-size",
        "1",
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

    expect(code).toBe(1);
    expect(sawPut).toBe(false);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Uploading object\nValueError: Cannot resume upload with different part size. Parts were uploaded with a part size of 2.0 MiB\n",
    );
  });
});

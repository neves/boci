import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { computeCrc32cBase64 } from "../../src/os.ts";
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

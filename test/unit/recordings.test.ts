import { expect, test } from "bun:test";
import { join } from "node:path";
import { startFakeEndpoint } from "../harness/fake-endpoint.ts";
import type { Recording } from "../harness/record.ts";

const root = join(import.meta.dir, "..", "..");

test("curated recordings replay offline", async () => {
  const recordings = ["iam-region-list", "os-ns-get"];
  for (const id of recordings) {
    const recording = (await Bun.file(
      join(root, "test/recordings", `${id}.json`),
    ).json()) as Recording;
    expect(recording.exchanges.length).toBeGreaterThan(0);
    expect(recording.referenceVersion).toBe("3.96.3");
    expect(recording.exchanges[0]?.request.url).not.toContain("boci-parity");

    const exchange = recording.exchanges[0]!;
    const requestUrl = new URL(exchange.request.url);
    const responseBody =
      exchange.response.body.text ??
      (exchange.response.body.base64
        ? Buffer.from(exchange.response.body.base64, "base64").toString("utf8")
        : "");
    const headers = { ...exchange.response.headers };
    delete headers["Content-Encoding"];
    delete headers["content-encoding"];
    delete headers["Content-Length"];
    using fake = startFakeEndpoint({
      status: exchange.response.status,
      headers,
      body: responseBody,
    });
    const response = await fetch(`${fake.url}${requestUrl.pathname}`, {
      method: exchange.request.method,
    });
    expect(response.status).toBe(exchange.response.status);
    expect(await response.text()).toBe(responseBody);
    expect(recording.argv.length).toBeGreaterThan(0);
  }
});

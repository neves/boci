// Local HTTPS stand-in behind an HTTP CONNECT proxy for commands whose target URL is
// hardcoded to https:// (like `oci session refresh`, which ignores `--endpoint`).
// Both Python requests and Bun fetch tunnel HTTPS through `HTTPS_PROXY` and trust
// `REQUESTS_CA_BUNDLE`, so both CLIs hit the same fake TLS server offline.
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { CapturedRequest, Reply } from "./fake-endpoint.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
export const FAKE_HTTPS_CERT_PATH = join(FIXTURES, "fake_https_cert.pem");
const CERT_PEM = await Bun.file(FAKE_HTTPS_CERT_PATH).text();
const KEY_PEM =
  (await Bun.file(join(FIXTURES, "fake_oci_api_key.pem")).text())
    .replace(/OCI_API_KEY\s*$/, "")
    .trim() + "\n";

export type FakeHttpsProxy = {
  proxyUrl: string;
  caCertPath: string;
  requests: CapturedRequest[];
  [Symbol.dispose](): void;
};

function toResponse(reply: Reply): Response {
  const body = reply.body ?? {};
  const isString = typeof body === "string";
  const headers = new Headers(reply.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", isString ? "text/plain" : "application/json");
  }
  return new Response(isString ? body : JSON.stringify(body), {
    status: reply.status ?? 200,
    headers,
  });
}

/** Starts a local TLS fake endpoint and an HTTP CONNECT proxy that tunnels to it. */
export async function startFakeHttpsProxy(
  replies: Reply | Reply[] = {},
): Promise<FakeHttpsProxy> {
  const queue = Array.isArray(replies) ? replies : [replies];
  const requests: CapturedRequest[] = [];
  const tlsServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: CERT_PEM, key: KEY_PEM },
    async fetch(req) {
      const raw = req.url.slice(
        req.url.indexOf("/", req.url.indexOf("//") + 2),
      );
      const q = raw.indexOf("?");
      const path = q === -1 ? raw : raw.slice(0, q);
      const rawQuery = q === -1 ? "" : raw.slice(q + 1);
      requests.push({
        method: req.method,
        path,
        rawQuery,
        query: [...new URLSearchParams(rawQuery)],
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      const reply =
        queue[Math.min(requests.length - 1, queue.length - 1)] ?? {};
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      return toResponse(reply);
    },
  });

  const tlsPort = tlsServer.port;
  if (tlsPort === undefined) {
    tlsServer.stop(true);
    throw new Error("Fake TLS server failed to bind a port");
  }

  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      if (!head.startsWith("CONNECT ")) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const upstream = connect(tlsPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolve();
    });
  });

  const addr = proxy.address();
  if (!addr || typeof addr === "string") {
    proxy.close();
    tlsServer.stop(true);
    throw new Error("Fake HTTPS proxy failed to bind a port");
  }

  return {
    proxyUrl: `http://127.0.0.1:${addr.port}`,
    caCertPath: FAKE_HTTPS_CERT_PATH,
    requests,
    [Symbol.dispose]() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      proxy.close();
      tlsServer.stop(true);
    },
  };
}

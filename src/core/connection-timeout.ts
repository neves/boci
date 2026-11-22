// Bun's fetch has no connection-phase callback. Its built-in HTTP agents expose
// the actual request socket, including TLS handshakes and pooled connections.
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type { Invocation } from "../lib/io.ts";
import { fetchTransportFromEnv } from "../commands/session.ts";
import { REFERENCE_VERSION } from "./version.ts";

type Request = {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

function proxyAgents(io: Invocation, url: URL) {
  const env = io.env;
  const proxyEnv = {
    http_proxy:
      env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY,
    https_proxy:
      env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY,
    no_proxy: env.no_proxy ?? env.NO_PROXY,
  };
  const options = { keepAlive: true, proxyEnv };
  return {
    http: new http.Agent(options),
    https: new https.Agent({
      ...options,
      ...fetchTransportFromEnv(url.href, env, io.cwd).tls,
    }),
  };
}
const invocationAgents = new WeakMap<
  Invocation,
  ReturnType<typeof proxyAgents>
>();

export class ConnectionPhaseTimeout extends Error {
  constructor(
    readonly handshake: boolean,
    readonly method: string,
    readonly url: URL,
  ) {
    super("Connection timed out");
  }

  report(): string {
    // cli_util.get_request_endpoint_from_exception_string splits at the last "/n".
    const endpoint = this.url.href.split("?")[0]!;
    const cut = endpoint.lastIndexOf("/n");
    const curl =
      this.handshake && cut >= 0 ? endpoint.slice(0, cut) : undefined;
    const tips = this.handshake
      ? curl
        ? `Try running curl ${curl}. If the curl doesn't work, check your network setting or contact your network administrator. If it does work, verify the resource state before retrying.`
        : "Verify the resource state before retrying."
      : "It looks like a connection timeout. Verify the resource state before retrying, then check your network setting or contact your network administrator.";
    const details = {
      client_version: `Oracle-PythonCLI/${REFERENCE_VERSION}`,
      logging_tips:
        "Please run the OCI CLI command using --debug flag to find more debug information.",
      message: `The request timed out${curl ? ` while trying to reach ${curl}` : ""}. The request may have reached the service and the operation may have completed. Verify the resource state before retrying.`,
      ...(this.handshake
        ? { request_endpoint: curl ? ` ${this.method} ${curl}` : null }
        : {}),
      target_service: "CLI",
      timestamp: new Date().toISOString().replace("Z", "000"),
      troubleshooting_tips:
        tips +
        " See [https://docs.oracle.com/iaas/Content/API/SDKDocs/clitroubleshooting.htm] for more information about resolving this error. If you are unable to resolve this issue, run this CLI command with --debug option and contact Oracle support and provide them the full error message.",
    };
    return `${this.handshake ? "RequestException" : "ConnectTimeout"}:\n${JSON.stringify(details, null, 4)}\n`;
  }
}

function requestOnce(
  io: Invocation,
  url: URL,
  req: Request,
  timeoutMs: number,
  signal: AbortSignal,
  readTimeoutMs: number,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    let agents = invocationAgents.get(io);
    if (!agents) {
      agents = proxyAgents(io, url);
      invocationAgents.set(io, agents);
    }
    let tcpConnected = false;
    if (url.username || url.password)
      throw new TypeError("Request URL cannot include credentials");
    const client = secure ? https : http;
    const request = client.request(url, {
      method: req.method,
      headers: req.headers,
      agent: secure ? agents.https : agents.http,
      signal,
      timeout: timeoutMs,
    });
    // HTTPS agents assign the request socket only after a proxy CONNECT tunnel opens.
    const timer = setTimeout(() => {
      const error = new ConnectionPhaseTimeout(
        secure && (tcpConnected || !request.socket),
        req.method,
        url,
      );
      request.destroy(error);
      reject(error);
    }, timeoutMs);
    const connected = () => {
      clearTimeout(timer);
      request.setTimeout(readTimeoutMs);
      if (readTimeoutMs)
        request.once("timeout", () => {
          request.destroy(
            new DOMException("Response read timed out", "TimeoutError"),
          );
        });
    };
    request.once("socket", (socket) => {
      tcpConnected = !socket.connecting;
      if (!tcpConnected)
        socket.once("connect", () => {
          tcpConnected = true;
        });
      if (secure && "secureConnecting" in socket && socket.secureConnecting) {
        socket.once("secureConnect", connected);
      } else if (socket.connecting) {
        socket.once(secure ? "secureConnect" : "connect", connected);
      } else {
        connected();
      }
    });
    request.once("response", (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      if (signal.aborted) reject(signal.reason);
      else if ("proxyTunnelTimeout" in error)
        reject(new ConnectionPhaseTimeout(true, req.method, url));
      else reject(error);
    });
    request.end(req.body);
  });
}

export async function fetchWithConnectionTimeout(
  io: Invocation,
  url: URL,
  req: Request,
  timeoutMs: number,
  signal: AbortSignal,
  decompress = true,
  readTimeoutMs = 0,
): Promise<Response> {
  const headers = new Headers(req.headers);
  if (!headers.has("accept-encoding"))
    headers.set("accept-encoding", "gzip, deflate, br");
  let { method, body } = req;
  for (let redirects = 0; ; redirects++) {
    const incoming = await requestOnce(
      io,
      url,
      { method, headers: Object.fromEntries(headers), body },
      timeoutMs,
      signal,
      readTimeoutMs,
    );
    const status = incoming.statusCode!;
    const location = incoming.headers.location;
    if (location && [301, 302, 303, 307, 308].includes(status)) {
      incoming.resume();
      if (redirects >= 20) throw new TypeError("Too many redirects");
      const next = new URL(location, url);
      if (url.origin !== next.origin) {
        for (const name of [
          "authorization",
          "cookie",
          "proxy-authorization",
          "host",
        ])
          headers.delete(name);
      }
      if (
        (status === 303 && method !== "HEAD") ||
        ((status === 301 || status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        for (const name of [
          "content-length",
          "content-type",
          "content-encoding",
          "content-language",
          "content-location",
        ])
          headers.delete(name);
      }
      url = next;
      continue;
    }
    const responseHeaders = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      responseHeaders.append(
        incoming.rawHeaders[i]!,
        incoming.rawHeaders[i + 1]!,
      );
    }
    const init = {
      status,
      headers: responseHeaders,
      statusText: incoming.statusMessage,
    };
    if (method === "HEAD" || [204, 205, 304].includes(status)) {
      incoming.resume();
      return new Response(null, init);
    }
    let stream = Readable.toWeb(incoming) as ReadableStream<
      Uint8Array<ArrayBuffer>
    >;
    const encoding = responseHeaders.get("content-encoding");
    if (
      decompress &&
      encoding &&
      ["br", "gzip", "deflate", "zstd"].includes(encoding)
    ) {
      stream = stream.pipeThrough(
        new DecompressionStream(
          encoding === "br"
            ? "brotli"
            : (encoding as "gzip" | "deflate" | "zstd"),
        ),
      );
    }
    return new Response(stream, init);
  }
}

// Local stand-in for an OCI service endpoint: both CLIs are pointed at it with
// --endpoint. It records every request exactly as received and serves canned replies.

export type CapturedRequest = {
  method: string;
  /** Path exactly as sent, still percent-encoded. */
  path: string;
  /** Query string exactly as sent (no leading "?"). */
  rawQuery: string;
  /** Decoded query pairs in wire order. */
  query: [string, string][];
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: string;
};

export type Reply = {
  status?: number;
  headers?: Record<string, string>;
  /** Strings are sent verbatim; anything else is JSON-encoded. */
  body?: unknown;
};

export type FakeEndpoint = {
  url: string;
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

/** Replies are served in order; the last one repeats. */
export function startFakeEndpoint(replies: Reply | Reply[] = {}): FakeEndpoint {
  const queue = Array.isArray(replies) ? replies : [replies];
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // req.url is normalised by Bun; recover the raw target from the URL string as sent.
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
      return toResponse(reply);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    [Symbol.dispose]() {
      server.stop(true);
    },
  };
}

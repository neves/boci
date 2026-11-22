import { describe, expect, test } from "bun:test";
import { run } from "../../src/cli.ts";
import { createSandbox } from "../harness/sandbox.ts";

describe("os object bulk-delete", () => {
  test("deletes objects in parallel per page, waits between pages, and respects concurrency limit", async () => {
    const pages = [
      {
        objects: [
          { name: "p1/a.txt" },
          { name: "p1/b.txt" },
          { name: "p1/c.txt" },
        ],
        nextStartWith: "p2/d.txt",
      },
      {
        objects: [{ name: "p2/d.txt" }, { name: "p2/e.txt" }],
      },
    ];

    let listCall = 0;
    let activeDeletes = 0;
    let maxConcurrentDeletes = 0;
    let listWhileDeletesInFlight = false;
    const deletedPaths: string[] = [];

    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          if (activeDeletes > 0) listWhileDeletesInFlight = true;
          const page = pages[listCall++] ?? { objects: [] };
          return Response.json(page);
        }
        if (req.method === "DELETE" && url.pathname.includes("/o/")) {
          const name = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
          activeDeletes += 1;
          maxConcurrentDeletes = Math.max(maxConcurrentDeletes, activeDeletes);
          await Bun.sleep(25);
          activeDeletes -= 1;
          deletedPaths.push(name);
          return new Response("", { status: 204 });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    await using sb = await createSandbox();
    let stdout = "";
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-delete",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--force",
        "--parallel-operations-count",
        "2",
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
    expect(listCall).toBe(2);
    expect(listWhileDeletesInFlight).toBe(false);
    expect(maxConcurrentDeletes).toBe(2);
    expect(deletedPaths.sort()).toEqual([
      "p1/a.txt",
      "p1/b.txt",
      "p1/c.txt",
      "p2/d.txt",
      "p2/e.txt",
    ]);

    const parsed = JSON.parse(stdout.trim()) as {
      "delete-failures": Record<string, string>;
      "deleted-objects": string[];
    };
    expect(parsed["delete-failures"]).toEqual({});
    expect(parsed["deleted-objects"].sort()).toEqual(deletedPaths.sort());
    expect(stderr).toContain("Deleted object p1/a.txt");
    expect(stderr).toContain("Deleted object p2/e.txt");
  });

  test("table output puts Failed rows with object column before Deleted rows", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({
            objects: [{ name: "ok.txt" }, { name: "bad.txt" }],
          });
        }
        if (req.method === "DELETE" && url.pathname.endsWith("/o/ok.txt")) {
          return new Response("", { status: 204 });
        }
        if (req.method === "DELETE" && url.pathname.endsWith("/o/bad.txt")) {
          return Response.json(
            {
              code: "ObjectNotFound",
              message: "The object 'bad.txt' was not found",
            },
            { status: 404, headers: { "opc-request-id": "req-404" } },
          );
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    await using sb = await createSandbox();
    let stdout = "";
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "--output",
        "table",
        "os",
        "object",
        "bulk-delete",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
        "--force",
        "--parallel-operations-count",
        "1",
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

    expect(code).toBe(1);
    expect(stdout).toContain("| action");
    expect(stdout).toContain("| object");
    expect(stdout).toContain("| error-message");
    expect(stdout).toContain("| Failed");
    expect(stdout).toContain("| Deleted");
    expect(stdout.indexOf("Failed")).toBeLessThan(stdout.indexOf("Deleted"));
    expect(stderr).toContain("Deleted object ok.txt\n");
    expect(stderr).toContain("Deleted object bad.txt\n");
  });

  test("re-prompts on invalid confirmation input until y or n", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/n/myns/b/mybucket/o") {
          return Response.json({ objects: [{ name: "one.txt" }] });
        }
        if (req.method === "DELETE" && url.pathname.endsWith("/o/one.txt")) {
          return new Response("", { status: 204 });
        }
        return new Response("unexpected", { status: 404 });
      },
    });

    await using sb = await createSandbox();
    let stdout = "";
    let stderr = "";

    const code = await run({
      argv: [
        "--endpoint",
        `http://127.0.0.1:${server.port}`,
        "--no-retry",
        "os",
        "object",
        "bulk-delete",
        "-ns",
        "myns",
        "-bn",
        "mybucket",
      ],
      env: sb.env,
      cwd: sb.home,
      stdin: "maybe\ny\n",
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
    expect(stderr).toContain("Error: invalid input\n");
    expect(stderr).toContain("Deleted object one.txt\n");
    expect(stdout).toContain('"deleted-objects": [\n    "one.txt"\n  ]');
  });
});

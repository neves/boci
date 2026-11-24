import { expect, test } from "bun:test";
import { CUSTOM_HANDLERS } from "../../src/core/registry.ts";
import { renderListPages, sdkCommand } from "../../src/lib/custom-command.ts";
import { runInProcess } from "../harness/runner.ts";

// A collection (non-list) response paged by a hand-written wrapper, the way
// cli_util.list_call_get_all_results / list_call_get_up_to_limit (and their
// _multiple_keys variants, `multipleKeys`) aggregate it.
async function collection(
  flags: string[],
  bodies: unknown[],
  multipleKeys = false,
) {
  const path = "container image list";
  const key = "artifacts " + path;
  const original = CUSTOM_HANDLERS.get(key);
  CUSTOM_HANDLERS.set(key, (ctx) =>
    renderListPages(
      ctx,
      path,
      ctx.values,
      sdkCommand(ctx, path, {
        client: "artifacts.artifacts",
        method: "list_container_images",
        http: "GET",
        path: "/container/images",
        responseType: "ContainerImageCollection",
        queryParams: { page: { arg: "page" }, limit: { arg: "limit" } },
      }),
      { multipleKeys },
    ),
  );
  try {
    return await runInProcess(
      [
        ...key.split(" "),
        "--compartment-id",
        "example",
        ...flags,
        "--page-size",
        "1",
        "--endpoint",
        "{endpoint}",
      ],
      {
        replies: bodies.map((body, i) => ({
          headers: (i < bodies.length - 1
            ? { "opc-next-page": `p${i + 2}` }
            : {}) as Record<string, string>,
          body,
        })),
      },
    );
  } finally {
    if (original) CUSTOM_HANDLERS.set(key, original);
    else CUSTOM_HANDLERS.delete(key);
  }
}

const pages = [
  { items: [{ id: "first" }], otherIds: ["a"], remainingItemsCount: 2 },
  { items: [{ id: "second" }], otherIds: ["b"], remainingItemsCount: 1 },
];

test("--all keeps only list attributes, under dashed names", async () => {
  const result = await collection(["--all"], pages);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.requests.length).toBe(2);
  expect(JSON.parse(result.stdout).data).toEqual({
    items: [{ id: "first" }, { id: "second" }],
    "other-ids": ["a", "b"],
  });
});

test("--limit takes len() of every attribute: an int is a TypeError", async () => {
  const result = await collection(["--limit", "2"], pages);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("TypeError: object of type 'int' has no len()\n");
});

test("--limit counts and chains a string attribute like Python", async () => {
  const result = await collection(
    ["--limit", "5"],
    [
      { items: [{ id: "first" }], name: "ab" },
      { items: [{ id: "second" }], name: "cd" },
    ],
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.requests.length).toBe(2);
  expect(JSON.parse(result.stdout).data).toEqual({
    items: [{ id: "first" }, { id: "second" }],
    name: ["a", "b", "c"],
  });
});

for (const flags of [["--all"], ["--limit", "4"]])
  test(`_multiple_keys ${flags.join(" ")} keeps the last scalar`, async () => {
    const result = await collection(flags, pages, true);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.requests.length).toBe(2);
    expect(JSON.parse(result.stdout).data).toEqual({
      items: [{ id: "first" }, { id: "second" }],
      "other-ids": ["a", "b"],
      "remaining-items-count": 1,
    });
  });

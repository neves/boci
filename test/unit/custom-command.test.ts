import { expect, test } from "bun:test";
import { CUSTOM_HANDLERS } from "../../src/core/registry.ts";
import { renderListPages, sdkCommand } from "../../src/lib/custom-command.ts";
import { runInProcess } from "../harness/runner.ts";

for (const flags of [["--all"], ["--limit", "2"]])
  test("collection pagination " + flags.join(" "), async () => {
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
      ),
    );
    try {
      const result = await runInProcess(
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
          replies: [
            {
              headers: { "opc-next-page": "second" },
              body: { items: [{ id: "first" }] },
            },
            { body: { items: [{ id: "second" }] } },
          ],
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.requests.length).toBe(2);
      expect(
        JSON.parse(result.stdout).data.items.map(
          (item: { id: string }) => item.id,
        ),
      ).toEqual(["first", "second"]);
    } finally {
      if (original) CUSTOM_HANDLERS.set(key, original);
      else CUSTOM_HANDLERS.delete(key);
    }
  });

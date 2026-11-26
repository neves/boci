import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  registerCustomHandler,
  renderCommandFile,
  renderParityCase,
} from "../../scripts/scaffold-lib.ts";

describe("scaffold-lib", () => {
  test("renderCommandFile embeds extracted OperationSpec", async () => {
    const out = renderCommandFile({
      key: "iam group add-user",
      source: { file: "identity_cli_extended.py", line: 249, lines: 13 },
      sdkCalls: [
        {
          client: "identity.identity",
          method: "add_user_to_group",
          line: 12,
          operation: {
            client: "identity.identity",
            method: "add_user_to_group",
            http: "POST",
            path: "/userGroupMemberships",
            headerParams: {},
            queryParams: {
              example: { arg: "example", collectionFormat: "multi" },
            },
            positionalArgs: ["details"],
          },
        },
      ],
    });
    const dir = await mkdtemp(tmpdir() + "/boci-scaffold-");
    try {
      const file = dir + "/handler.ts";
      const src = resolve(import.meta.dir, "../../src").replaceAll("\\", "/");
      await Bun.write(file, out.replaceAll('"../../', '"' + src + "/"));
      await Bun.$`bun check ${file}`.quiet();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(out).not.toContain("positionalArgs");
    expect(out).toContain("export async function runIamGroupAddUser(");
    expect(out).toContain("const addUserToGroupOperation: OperationSpec =");
    expect(out).toContain(
      'runOperation(ctx, "group add-user", addUserToGroupOperation)',
    );
  });

  test("renderCommandFile flags arguments and calls the wrapper builds itself", () => {
    const op = (method: string, extra: Record<string, unknown> = {}) => ({
      client: "identity.identity",
      method,
      line: 1,
      operation: {
        client: "identity.identity",
        method,
        http: "POST",
        path: "/x",
        queryParams: {},
        ...extra,
      },
    });
    const out = renderCommandFile(
      {
        key: "iam group add-user",
        helpers: ["cli_util.list_call_get_all_results"],
        sdkCalls: [
          op("add_user_to_group", {
            body: "add_user_to_group_details",
            pathParams: { groupId: "group_id" },
          }),
          op("get_user"),
        ],
      },
      [{ name: "group_id" }, { name: "user_id" }],
    );
    expect(out).toContain(
      "// TODO: the wrapper builds add_user_to_group_details itself",
    );
    expect(out).not.toContain("builds group_id");
    expect(out).toContain(
      "// TODO: port the remaining calls: getUserOperation",
    );
    // A non-list first call is not rendered as a list, whatever helpers appear.
    expect(out).toContain("runOperation(");
    expect(out).not.toContain("renderListPages");
  });

  test("renderCommandFile pages like the wrapper's list helper", () => {
    const list = (helper: string) =>
      renderCommandFile({
        key: "artifacts container image list",
        helpers: [helper],
        sdkCalls: [
          {
            client: "artifacts.artifacts",
            method: "list_container_images",
            line: 1,
            operation: {
              client: "artifacts.artifacts",
              method: "list_container_images",
              http: "GET",
              path: "/container/images",
              queryParams: {},
            },
          },
        ],
      });
    expect(list("cli_util.list_call_get_all_results_multiple_keys")).toContain(
      "ctx.values, command, { multipleKeys: true });",
    );
    expect(list("cli_util.list_call_get_all_results")).toContain(
      "ctx.values, command);",
    );
  });

  test("registerCustomHandler is idempotent", () => {
    const base = `export const CUSTOM_HANDLERS = new Map<string, CustomCommandHandler>([\n]);\n`;
    const first = registerCustomHandler(
      base + 'const excluded = ["iam group add-user",];',
      "iam group add-user",
    );
    expect(first.changed).toBe(true);
    expect(first.source).toContain('"iam group add-user"');
    expect(first.source).toContain(
      'import("../commands/iam/group_add_user.ts")',
    );

    const second = registerCustomHandler(first.source, "iam group add-user");
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test("renderParityCase includes required options and endpoint", () => {
    const json = renderParityCase("iam group add-user", [
      { name: "group_id", opts: ["--group-id"], required: true },
      { name: "user_id", opts: ["--user-id"], required: true },
      { name: "optional_flag", opts: ["--optional"], required: false },
    ]);
    const parsed = JSON.parse(json);
    expect(parsed[0].expect.requests).toBe(1);
    expect(parsed[0].id).toBe("iam-group-add-user");
    expect(parsed[0].argv).toEqual([
      "iam",
      "group",
      "add-user",
      "--group-id",
      "ocid1.group.oc1..test",
      "--user-id",
      "ocid1.user.oc1..test",
      "--endpoint",
      "{endpoint}",
    ]);
  });
});

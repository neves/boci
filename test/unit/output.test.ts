// printResult through its interface: table output, --query (inline and canned) and the
// ServiceError envelope.
import { expect, test } from "bun:test";
import { Exit, type Invocation } from "../../src/lib/io.ts";
import type { OperationResult } from "../../src/core/operation.ts";
import { type OutputOptions, printResult } from "../../src/core/output.ts";

function invocation() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Invocation = {
    argv: [],
    env: {},
    cwd: "/",
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    isTTY: () => false,
    columns: () => undefined,
  };
  return { io, out, err };
}

function result(
  body: unknown,
  init: ResponseInit = {},
  extra: Partial<OperationResult> = {},
): OperationResult {
  const raw = JSON.stringify(body);
  return {
    operation: {
      client: "things",
      method: "list_things",
      http: "GET",
      path: "/things",
      responseType: "list[Thing]",
      queryParams: {},
    },
    url: new URL("https://things.example/v1/things"),
    response: new Response(raw, init),
    raw,
    allPages: false,
    pageItems: [],
    responseModels: {
      Thing: {
        attributes: [
          ["lifecycle_state", "str", "lifecycleState"],
          ["display_name", "str", "displayName"],
        ],
      },
    },
    ...extra,
  };
}

const rc: OutputOptions["rc"] = {
  path: "/home/u/.oci/oci_cli_rc",
  cannedQueries: { names: 'data[]."display-name"' },
};

const things = {
  items: [
    { displayName: "a", lifecycleState: "ACTIVE" },
    { displayName: "bb", lifecycleState: "DELETED" },
  ],
};

test("json maps camelCase keys to dashes and sorts them", () => {
  const { io, out } = invocation();
  printResult(io, result(things), { rc });
  expect(out.join("")).toBe(
    `${JSON.stringify(
      {
        data: [
          { "display-name": "a", "lifecycle-state": "ACTIVE" },
          { "display-name": "bb", "lifecycle-state": "DELETED" },
        ],
      },
      null,
      2,
    )}\n`,
  );
});

test("response subtype discriminator is inherited through named models", () => {
  const { io, out } = invocation();
  const extra = {
    responseModels: {
      Base: {
        attributes: [],
        discriminator: {
          field: "kind",
          values: { SPECIAL: "Special" },
          fallback: "Base",
        },
      },
      Middle: { attributes: [], discriminator: "Base" },
      Item: { attributes: [], discriminator: "Middle" },
      Special: {
        attributes: [
          ["kind", "str", "kind"],
          ["special_value", "str", "specialValue"],
        ] as [string, string, string][],
      },
    },
  };
  printResult(
    io,
    result({ items: [{ kind: "SPECIAL", specialValue: "yes" }] }, {}, extra),
    { rc },
  );
  expect(JSON.parse(out.join(""))).toEqual({
    data: [{ kind: "SPECIAL", specialValue: "yes" }],
  });
  const missing = invocation();
  printResult(
    missing.io,
    result({ items: [{ specialValue: "yes" }] }, {}, extra),
    { rc },
  );
  expect(JSON.parse(missing.out.join(""))).toEqual({
    data: [{ specialValue: "yes" }],
  });
});

test("maps unknown enum values to UNKNOWN_ENUM_VALUE from model enums", () => {
  const { io, out } = invocation();
  const lbResult = result(
    {
      lifecycleState: "FUTURE_STATE",
      actions: ["ALLOW", "UNKNOWN_ONE", null],
      nullableState: null,
    },
    {},
    {
      operation: {
        client: "lb",
        method: "get_load_balancer",
        http: "GET",
        path: "/loadBalancers/x",
        responseType: "LoadBalancer",
        queryParams: {},
      },
      responseModels: {
        LoadBalancer: {
          attributes: [
            ["lifecycle_state", "str", "lifecycleState"],
            ["actions", "list[str]", "actions"],
            ["nullable_state", "str", "nullableState"],
          ],
          enums: {
            lifecycle_state: ["CREATING", "ACTIVE"],
            actions: ["ALLOW", "DENY"],
            nullable_state: ["ON", "OFF"],
          },
        },
      },
    },
  );
  printResult(io, lbResult, { rc });
  expect(JSON.parse(out.join("")).data).toEqual({
    "lifecycle-state": "UNKNOWN_ENUM_VALUE",
    actions: ["ALLOW", "UNKNOWN_ENUM_VALUE", null],
    "nullable-state": null,
  });

  const other = invocation();
  printResult(
    other.io,
    result(
      { lifecycleState: "FUTURE_STATE" },
      {},
      { operation: { ...result(things).operation, responseType: "Thing" } },
    ),
    { rc },
  );
  expect(JSON.parse(other.out.join("")).data["lifecycle-state"]).toBe(
    "FUTURE_STATE",
  );
});

test("deserializes datetimes with microseconds, floats as 0.0, drops unknown fields, and sorts keys by codepoint", () => {
  const { io, out } = invocation();
  const res = result(
    {
      timeMillis: "2024-01-02T03:04:05.123Z",
      timeZero: "2024-01-02T03:04:05.000Z",
      timeOffset: "2024-01-02T03:04:05.123456+05:30",
      cpus: 0,
      tags: { "k ✓": "a", "Key-2": "b" },
      extraUnknown: "drop-me",
    },
    {},
    {
      operation: {
        client: "things",
        method: "get_thing",
        http: "GET",
        path: "/things/1",
        responseType: "Detail",
        queryParams: {},
      },
      responseModels: {
        Detail: {
          attributes: [
            ["time_millis", "datetime", "timeMillis"],
            ["time_zero", "datetime", "timeZero"],
            ["time_offset", "datetime", "timeOffset"],
            ["cpus", "float", "cpus"],
            ["tags", "dict(str, str)", "tags"],
          ],
        },
      },
    },
  );
  printResult(io, res, { rc });
  const text = out.join("");
  expect(text).toContain('"cpus": 0.0');
  expect(text).toContain('"time-millis": "2024-01-02T03:04:05.123000+00:00"');
  expect(text).toContain('"time-zero": "2024-01-02T03:04:05+00:00"');
  expect(text).toContain('"time-offset": "2024-01-02T03:04:05.123456+05:30"');
  expect(text).not.toContain("extraUnknown");
  expect(text.indexOf('"Key-2"')).toBeLessThan(text.indexOf('"k ✓"'));
});

test("polymorphic response raises KeyError when discriminator is missing", () => {
  const { io, out, err } = invocation();
  const res = result(
    { name: "x" },
    {},
    {
      operation: {
        client: "things",
        method: "get_poly",
        http: "GET",
        path: "/poly/1",
        responseType: "Sub",
        queryParams: {},
      },
      responseModels: {
        Base: {
          attributes: [["kind", "str", "kind"]],
          discriminator: {
            field: "kind",
            values: { SUB: "Sub" },
            fallback: "Base",
          },
        },
        Sub: {
          attributes: [
            ["kind", "str", "kind"],
            ["name", "str", "name"],
          ],
          discriminator: "Base",
        },
      },
    },
  );
  expect(() => printResult(io, res, { rc })).toThrow(Exit);
  expect(out).toEqual([]);
  expect(err.join("")).toBe("KeyError: 'kind'\n");
});

test("--all on a collection model aggregates only list attributes across pages", () => {
  const { io, out } = invocation();
  const baseOp = {
    client: "things",
    method: "list_collection",
    http: "GET",
    path: "/things",
    responseType: "ThingCollection",
    queryParams: {},
  };
  const models = {
    ThingCollection: {
      attributes: [
        ["count", "int", "count"],
        ["items", "list[Thing]", "items"],
      ] as [string, string, string][],
    },
    Thing: {
      attributes: [["display_name", "str", "displayName"]] as [
        string,
        string,
        string,
      ][],
    },
  };
  printResult(
    io,
    result(
      {},
      {},
      {
        operation: baseOp,
        responseModels: models,
        allPages: true,
        rawPages: [
          JSON.stringify({ count: 1 }),
          JSON.stringify({ items: [{ displayName: "one" }] }),
        ],
      },
    ),
    { rc },
  );
  expect(JSON.parse(out.join(""))).toEqual({
    data: { items: [{ "display-name": "one" }] },
  });

  const empty = invocation();
  printResult(
    empty.io,
    result(
      {},
      { headers: { etag: "e1" } },
      {
        operation: baseOp,
        responseModels: models,
        allPages: true,
        rawPages: [JSON.stringify({})],
      },
    ),
    { rc },
  );
  expect(JSON.parse(empty.out.join(""))).toEqual({ etag: "e1" });
});

test("table renders None, booleans, python repr dicts, and extra headers on stderr", () => {
  const { io, out, err } = invocation();
  const res = result(
    {
      name: null,
      flag: false,
      nested: { b: null, a: "x" },
    },
    { headers: { etag: "e1" } },
    {
      operation: {
        client: "things",
        method: "get_row",
        http: "GET",
        path: "/row/1",
        responseType: "Row",
        queryParams: {},
      },
      responseModels: {
        Row: {
          attributes: [
            ["name", "str", "name"],
            ["flag", "bool", "flag"],
            ["nested", "Nested", "nested"],
          ],
        },
        Nested: {
          attributes: [
            ["b", "str", "b"],
            ["a", "str", "a"],
          ],
        },
      },
    },
  );
  printResult(io, res, { output: "table", rc });
  expect(out.join("")).toContain("| False | None | {'b': None, 'a': 'x'} |");
  expect(err.join("")).toBe("etag: e1\n");
});

test("table renders the data's rows with padded columns", () => {
  const { io, out } = invocation();
  printResult(io, result(things), { output: "table", rc });
  expect(out.join("")).toBe(
    [
      "+--------------+-----------------+",
      "| display-name | lifecycle-state |",
      "+--------------+-----------------+",
      "| a            | ACTIVE          |",
      "| bb           | DELETED         |",
      "+--------------+-----------------+",
      "",
    ].join("\n"),
  );
});

test("--query filters before rendering; a scalar list gets Column headers", () => {
  const { io, out } = invocation();
  printResult(io, result(things), {
    query: 'data[].["display-name"]',
    output: "table",
    rc,
  });
  expect(out.join("")).toBe(
    "+---------+\n| Column1 |\n+---------+\n| a       |\n| bb      |\n+---------+\n",
  );
});

test("query:// resolves an rc canned query; --raw-output prints strings bare", () => {
  const { io, out } = invocation();
  printResult(io, result(things), { query: "query://names", rc });
  expect(JSON.parse(out.join(""))).toEqual(["a", "bb"]);
  const raw = invocation();
  printResult(raw.io, result(things), {
    query: 'data[0]."display-name"',
    rawOutput: true,
    rc,
  });
  expect(raw.out.join("")).toBe("a\n");
});

test("an undefined canned query or an empty result goes to stderr", () => {
  const missing = invocation();
  expect(() =>
    printResult(missing.io, result(things), { query: "query://nope", rc }),
  ).toThrow(Exit);
  expect(missing.err.join("")).toBe(
    `UsageError: Query nope is not defined in your OCI CLI configuration file: ${rc.path}\n`,
  );
  const empty = invocation();
  printResult(empty.io, result(things), { query: "data[?x]", rc });
  expect(empty.out).toEqual([]);
  expect(empty.err.join("")).toBe(
    "Query returned empty result, no output to show.\n",
  );
});

test("a failed call prints the ServiceError envelope and exits 1", () => {
  const { io, out, err } = invocation();
  let code: number | undefined;
  try {
    printResult(
      io,
      result(
        { code: "NotAuthorizedOrNotFound", message: "gone" },
        { status: 404, headers: { "opc-request-id": "rid" } },
      ),
      { rc },
    );
  } catch (e) {
    if (e instanceof Exit) code = e.code;
  }
  expect(code).toBe(1);
  expect(out).toEqual([]);
  const text = err.join("");
  expect(text.startsWith("ServiceError:\n")).toBe(true);
  const envelope = JSON.parse(text.slice("ServiceError:\n".length));
  expect(envelope).toMatchObject({
    code: "NotAuthorizedOrNotFound",
    "opc-request-id": "rid",
    operation_name: "list_things",
    request_endpoint: "GET https://things.example/v1/things",
    status: 404,
  });
  expect(Object.keys(envelope)).toEqual(Object.keys(envelope).sort());
});

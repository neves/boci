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

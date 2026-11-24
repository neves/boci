import { describe, expect, test } from "bun:test";
import type { TypedParam } from "../../src/core/convert.ts";
import { bindSdkArgs, type OperationResult } from "../../src/core/operation.ts";
import {
  ProgramEcho,
  ProgramExit,
  ProgramFile,
  ProgramRaise,
  ProgramRender,
  ProgramResponse,
  ProgramSdkCall,
  ProgramServiceError,
  ProgramSleep,
  ProgramUnsupported,
  ProgramUsageError,
  ProgramWaitUntil,
  runProgram,
  type Expr,
  type Statement,
} from "../../src/core/program.ts";
import { waitUntilResponse } from "../../src/core/waiter.ts";

const params = [
  { name: "a" },
  { name: "b" },
  { name: "ids", multiple: true },
] as TypedParam[];
const kw = (key: string) => ["item", ["var", "kwargs"], key];
const parse = (_: string, v: unknown) =>
  typeof v === "string" ? JSON.parse(v) : v;
const invoke: Statement = ["invoke", [], ["var", "kwargs"]];

describe("runProgram", () => {
  test("folds options into a dumped dict and drops the sources", () => {
    const program: Statement[] = [
      ["let", "d", ["dict"]],
      [
        "if",
        ["cmp", "isnot", kw("a"), null],
        [["set", ["var", "d"], "x", kw("a")]],
        [],
      ],
      ["do", ["call", "pop", ["var", "kwargs"], "a"]],
      [
        "if",
        ["cmp", ">", ["fn", "len", ["var", "d"]], 0],
        [["set", ["var", "kwargs"], "t", ["fn", "dumps", ["var", "d"]]]],
        [],
      ],
      invoke,
    ];
    const { kwargs, names } = runProgram(program, { a: 1 }, params, parse);
    expect(kwargs).toEqual({ t: '{"x":1}' });
    expect(names).toEqual(["b", "ids", "t"]);
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({});
  });

  test("unset options are None or [] to the wrapper, and absent after it", () => {
    const program: Statement[] = [
      ["set", ["var", "kwargs"], "c", ["or", kw("b"), "fallback"]],
      ["set", ["var", "kwargs"], "renamed", kw("ids")],
      invoke,
    ];
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({
      c: "fallback",
    });
  });

  test("an empty JSON string is truthy until parsed", () => {
    const program: Statement[] = [
      [
        "if",
        kw("a"),
        [["set", ["var", "kwargs"], "p", ["fn", "parse", "a", kw("a")]]],
        [],
      ],
      invoke,
    ];
    expect(runProgram(program, { a: "{}" }, params, parse).kwargs).toEqual({
      a: "{}",
      p: {},
    });
  });

  test("raises other exceptions with the text Python's str() gives them", () => {
    const raised = (cls: string, message: Expr) => {
      try {
        runProgram([["raise", "src", cls, message]], {}, params, parse);
      } catch (e) {
        return e instanceof ProgramRaise ? [e.cls, e.message] : e;
      }
    };
    expect(raised("ValueError", "type doesn't match")).toEqual([
      "ValueError",
      "type doesn't match",
    ]);
    expect(raised("KeyError", "protocol is missing.")).toEqual([
      "KeyError",
      "'protocol is missing.'",
    ]);
  });

  test("formats strings with positional fields, like str.format", () => {
    const program: Statement[] = [
      [
        "set",
        ["var", "kwargs"],
        "m",
        ["call", "format", "--{} and {}{{}}", "x", 1],
      ],
      invoke,
    ];
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({
      m: "--x and 1{}",
    });
    expect(() =>
      runProgram(
        [["do", ["call", "format", "{} {0}", "x"]]],
        {},
        params,
        parse,
      ),
    ).toThrow(ProgramUnsupported);
  });

  test("raises usage errors, and stops on paths it does not model", () => {
    expect(() => runProgram([["usage", "nope"]], {}, params, parse)).toThrow(
      ProgramUsageError,
    );
    expect(() =>
      runProgram([["raise", "raise ValueError()"]], {}, params, parse),
    ).toThrow(ProgramUnsupported);
    expect(() =>
      runProgram(
        [["do", ["call", "pop", ["var", "kwargs"], "missing"]]],
        {},
        params,
        parse,
      ),
    ).toThrow(ProgramUnsupported);
  });

  test("no invoke: no request", () => {
    expect(runProgram([], {}, params, parse).kwargs).toBeUndefined();
  });

  test("dict() builds a dict from key/value pairs", () => {
    const pair: Expr = [
      "list",
      ["var", "k"],
      ["item", ["var", "kwargs"], ["var", "k"]],
    ];
    const program: Statement[] = [
      ["let", "common", ["fn", "dict", ["map", ["list", "a", "b"], "k", pair]]],
      ["invoke", [], ["var", "common"]],
    ];
    expect(runProgram(program, { a: 1, b: 2 }, params, parse).kwargs).toEqual({
      a: 1,
      b: 2,
    });
    expect(
      runProgram([["invoke", [], ["fn", "dict"]]], {}, params, parse).kwargs,
    ).toEqual({});
  });

  test("reports which generated command a variant selector invoked", () => {
    const program: Statement[] = [
      [
        "if",
        ["cmp", "==", kw("a"), "x"],
        [["invoke", [], ["var", "kwargs"], 2]],
        [invoke],
      ],
    ];
    expect(runProgram(program, { a: "x" }, params, parse).target).toBe(2);
    expect(runProgram(program, { a: "y" }, params, parse).target).toBe(0);
  });

  test("reads click.File options: text with universal newlines, once", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const file = new ProgramFile("r", enc("a\r\nb\rc"));
    expect(file.read()).toBe("a\nb\nc");
    expect(file.read()).toBe("");
    expect(new ProgramFile("r", enc("k1\nk2")).lines()).toEqual(["k1\n", "k2"]);
    expect(new ProgramFile("rb", enc("x\r\n")).read()).toEqual(enc("x\r\n"));
    expect(() => new ProgramFile("wb").read()).toThrow(ProgramUnsupported);
  });

  test("preserves UTF-8 BOM on text reads and explicit byte decoding", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(new ProgramFile("r", bom).read()).toBe("\uFEFFa");
    const decoded = runProgram(
      [["set", ["var", "kwargs"], "a", ["call", "decode", kw("a")]], invoke],
      { a: bom },
      params,
      parse,
    );
    expect(decoded.kwargs?.a).toBe("\uFEFFa");
  });

  test("keeps malformed UTF-8 strict on text reads and explicit byte decoding", () => {
    const malformed = new Uint8Array([0xff]);
    expect(() => new ProgramFile("r", malformed).read()).toThrow(
      "UnicodeDecodeError",
    );
    expect(() =>
      runProgram(
        [["set", ["var", "kwargs"], "a", ["call", "decode", kw("a")]], invoke],
        { a: malformed },
        params,
        parse,
      ),
    ).toThrow("UnicodeDecodeError");
  });

  test("for loops, comprehensions over file lines, b64encode", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const values = {
      a: new ProgramFile("r", enc("x\ny\n")),
      b: new ProgramFile("rb", enc("hi")),
    };
    const program: Statement[] = [
      ["let", "out", ["dict"]],
      [
        "for",
        "k",
        ["call", "keys", ["dict", ["one", 1], ["two", 2]]],
        [["set", ["var", "out"], ["var", "k"], ["var", "k"]]],
      ],
      [
        "set",
        ["var", "out"],
        "lines",
        ["map", kw("a"), "line", ["call", "rstrip", ["var", "line"], "\n"]],
      ],
      [
        "set",
        ["var", "out"],
        "b64",
        [
          "call",
          "decode",
          ["fn", "b64encode", ["call", "read", kw("b")]],
          "utf-8",
        ],
      ],
      ["invoke", [["a", ["fn", "dumps", ["var", "out"]]]], null],
    ];
    expect(runProgram(program, values, params, parse).kwargs).toEqual({
      a: JSON.stringify({
        one: "one",
        two: "two",
        lines: ["x", "y"],
        b64: "aGk=",
      }),
    });
  });

  test("Tier C programs yield sdk calls, read .data, render responses, and replay", () => {
    const program: Statement[] = [
      ["let", "req", ["dict"]],
      [
        "set",
        ["var", "req"],
        "opc_request_id",
        ["fn", "requestId", ["item", ["fn", "ctxObj"], "request_id"]],
      ],
      ["let", "client", ["fn", "client", "identity", "identity"]],
      [
        "let",
        "res",
        [
          "sdk",
          0,
          ["var", "client"],
          [kw("a")],
          [["details", ["dict", ["isRetired", true]]]],
          ["var", "req"],
        ],
      ],
      ["render", ["var", "res"]],
    ];

    let sdkCall: ProgramSdkCall | undefined;
    try {
      runProgram(program, { a: "ns-1" }, params, parse, [], undefined, {
        requestId: "req-123",
      });
    } catch (e) {
      if (e instanceof ProgramSdkCall) sdkCall = e;
      else throw e;
    }
    expect(sdkCall).toBeDefined();
    expect(sdkCall?.opIndex).toBe(0);
    expect(sdkCall?.posArgs).toEqual(["ns-1"]);
    expect(sdkCall?.kwArgs).toEqual({
      opc_request_id: "req-123",
      details: { isRetired: true },
    });

    const fakeResponse = new ProgramResponse({} as OperationResult, {
      id: "tag-1",
    });
    let rendered: ProgramRender | undefined;
    try {
      runProgram(program, { a: "ns-1" }, params, parse, [], undefined, {
        requestId: "req-123",
        sdkResults: [fakeResponse],
      });
    } catch (e) {
      if (e instanceof ProgramRender) rendered = e;
      else throw e;
    }
    expect(rendered?.response).toBe(fakeResponse);

    // Final replay after render completes cleanly with no ctx.invoke.
    expect(
      runProgram(program, { a: "ns-1" }, params, parse, [], undefined, {
        requestId: "req-123",
        sdkResults: [fakeResponse],
        renderedCount: 1,
      }).kwargs,
    ).toBeUndefined();

    // `.data` reads the decoded SDK response payload.
    const dataProgram: Statement[] = [
      ["let", "client", ["fn", "client", "database", "database"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [kw("a")], [], null]],
      ["invoke", [["got", ["attr", "data", ["var", "res"]]]], null],
    ];
    expect(
      runProgram(dataProgram, { a: "db-1" }, params, parse, [], undefined, {
        sdkResults: [fakeResponse],
      }).kwargs,
    ).toEqual({ got: { id: "tag-1" } });
  });

  test("use_or_generate_request_id generates a 32-char hex UUID when absent", () => {
    const program: Statement[] = [
      [
        "invoke",
        [["id", ["fn", "requestId", ["item", ["fn", "ctxObj"], "request_id"]]]],
        null,
      ],
    ];
    const generated = runProgram(program, {}, params, parse).kwargs?.id;
    expect(typeof generated).toBe("string");
    expect(generated).toMatch(/^[0-9A-F]{32}$/);
    expect(
      runProgram(program, {}, params, parse, [], undefined, {
        requestId: "custom-id",
      }).kwargs?.id,
    ).toBe("custom-id");
  });

  test("parse_json_parameter honors default and camelize_keys arguments", () => {
    const calls: [string, unknown, boolean | undefined][] = [];
    const trackingParse = (
      name: string,
      value: unknown,
      camelize?: boolean,
    ) => {
      calls.push([name, value, camelize]);
      return typeof value === "string" ? JSON.parse(value) : value;
    };
    const program: Statement[] = [
      [
        "invoke",
        [
          [
            "parsed",
            ["fn", "parse", "request_body", kw("a"), "fallback", false],
          ],
          ["fallback", ["fn", "parse", "missing", kw("b"), "defaulted", false]],
        ],
        null,
      ],
    ];
    const res = runProgram(
      program,
      { a: '{"snake_key":1}' },
      params,
      trackingParse,
    );
    expect(res.kwargs).toEqual({
      parsed: { snake_key: 1 },
      fallback: "defaulted",
    });
    expect(calls).toEqual([["request_body", '{"snake_key":1}', false]]);
  });

  test("bindSdkArgs maps positional arguments and validates path params", () => {
    const op = {
      client: "identity.identity",
      method: "update_tag",
      http: "PUT",
      path: "/tagNamespaces/{tagNamespaceId}/tags/{tagName}",
      positionalArgs: ["tag_namespace_id", "tag_name", "update_tag_details"],
      pathParams: {
        tagNamespaceId: "tag_namespace_id",
        tagName: "tag_name",
      },
      queryParams: {},
      headerParams: {},
    };
    expect(
      bindSdkArgs(op, ["ns1", "tag1"], {
        update_tag_details: { isRetired: true },
      }),
    ).toEqual({
      tag_namespace_id: "ns1",
      tag_name: "tag1",
      update_tag_details: { isRetired: true },
    });
    expect(() =>
      bindSdkArgs(op, ["ns1", "   "], { update_tag_details: {} }),
    ).toThrow(ProgramRaise);
    expect(() =>
      bindSdkArgs(op, ["ns1"], { tag_namespace_id: "dup", tag_name: "t" }),
    ).toThrow(ProgramUnsupported);
  });

  test("ProgramResponse exposes case-insensitive .headers, .status, and snake_case model attributes", () => {
    const models = {
      Database: {
        attributes: [
          ["id", "str", "id"],
          ["db_home_id", "str", "dbHomeId"],
          ["compartment_id", "str", "compartmentId"],
        ] as [string, string, string][],
      },
    };
    const fakeResult = {
      operation: {
        client: "database.database",
        method: "get_database",
        http: "GET",
        path: "/databases/{databaseId}",
        queryParams: {},
        responseType: "Database",
      },
      responseModels: models,
      url: new URL("https://example.invalid/databases/db-1"),
      response: new Response("{}", {
        status: 202,
        headers: { "OPC-Work-Request-Id": "wr-42" },
      }),
      raw: '{"id":"db-1","dbHomeId":"home-7"}',
      allPages: false,
      pageItems: [],
    } as OperationResult;
    const response = new ProgramResponse(fakeResult, {
      id: "db-1",
      dbHomeId: "home-7",
    });

    const program: Statement[] = [
      ["let", "client", ["fn", "client", "database", "database"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [kw("a")], [], null]],
      [
        "invoke",
        [
          ["status", ["attr", "status", ["var", "res"]]],
          [
            "wr",
            [
              "item",
              ["attr", "headers", ["var", "res"]],
              "opc-work-request-id",
            ],
          ],
          [
            "wrGet",
            [
              "call",
              "get",
              ["attr", "headers", ["var", "res"]],
              "OPC-WORK-REQUEST-ID",
            ],
          ],
          [
            "missingGet",
            ["call", "get", ["attr", "headers", ["var", "res"]], "x-none", "d"],
          ],
          [
            "hasWr",
            [
              "cmp",
              "in",
              "opc-work-request-id",
              ["attr", "headers", ["var", "res"]],
            ],
          ],
          ["home", ["attr", "db_home_id", ["attr", "data", ["var", "res"]]]],
          [
            "comp",
            ["attr", "compartment_id", ["attr", "data", ["var", "res"]]],
          ],
        ],
        null,
      ],
    ];
    expect(
      runProgram(program, { a: "db-1" }, params, parse, [], undefined, {
        sdkResults: [response],
      }).kwargs,
    ).toEqual({
      status: 202,
      wr: "wr-42",
      wrGet: "wr-42",
      missingGet: "d",
      hasWr: true,
      home: "home-7",
    });

    // Missing header subscript raises KeyError.
    const missingHeaderProg: Statement[] = [
      ["let", "client", ["fn", "client", "database", "database"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      ["do", ["item", ["attr", "headers", ["var", "res"]], "missing"]],
    ];
    expect(() =>
      runProgram(missingHeaderProg, {}, params, parse, [], undefined, {
        sdkResults: [response],
      }),
    ).toThrow(ProgramRaise);

    // Invalid model attribute raises AttributeError with the model name.
    const badAttrProg: Statement[] = [
      ["let", "client", ["fn", "client", "database", "database"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      ["do", ["attr", "nonexistent", ["attr", "data", ["var", "res"]]]],
    ];
    let attrErr: ProgramRaise | undefined;
    try {
      runProgram(badAttrProg, {}, params, parse, [], undefined, {
        sdkResults: [response],
      });
    } catch (e) {
      if (e instanceof ProgramRaise) attrErr = e;
      else throw e;
    }
    expect(attrErr?.cls).toBe("AttributeError");
    expect(attrErr?.message).toBe(
      "'Database' object has no attribute 'nonexistent'",
    );
  });

  test("click.echo, sys.exit, and time.sleep yield replayable effects and errors", () => {
    const echoProg: Statement[] = [
      ["do", ["fn", "echo", "hello", ["fn", "stderr"], true, false]],
      ["do", ["fn", "echo", "inline", null, false, true]],
      ["do", ["fn", "sleep", 2]],
      ["exit", 2],
    ];
    const run = (ctx = {}) => {
      try {
        return runProgram(echoProg, {}, params, parse, [], undefined, ctx);
      } catch (e) {
        return e;
      }
    };
    const e1 = run();
    expect(e1).toBeInstanceOf(ProgramEcho);
    expect((e1 as ProgramEcho).text).toBe("hello\n");
    expect((e1 as ProgramEcho).toStderr).toBe(true);

    const e2 = run({ echoCount: 1 });
    expect(e2).toBeInstanceOf(ProgramEcho);
    expect((e2 as ProgramEcho).text).toBe("inline");
    expect((e2 as ProgramEcho).toStderr).toBe(true);

    const e3 = run({ echoCount: 2 });
    expect(e3).toBeInstanceOf(ProgramSleep);
    expect((e3 as ProgramSleep).seconds).toBe(2);

    const e4 = run({ echoCount: 2, sleepCount: 1 });
    expect(e4).toBeInstanceOf(ProgramExit);
    expect((e4 as ProgramExit).code).toBe(2);

    // Negative sleep raises ValueError; sys.exit(str) sets exit code 1 + stderr output.
    expect(() =>
      runProgram([["do", ["fn", "sleep", -1]]], {}, params, parse),
    ).toThrow(ProgramRaise);
    let strExit: ProgramExit | undefined;
    try {
      runProgram(
        [
          [
            "try",
            [["exit", "bad state"]],
            null,
            [["do", ["fn", "echo", "caught", null, true, false]]],
          ],
        ],
        {},
        params,
        parse,
      );
    } catch (e) {
      if (e instanceof ProgramExit) strExit = e;
      else throw e;
    }
    expect(strExit?.code).toBe(1);
    expect(strExit?.output).toBe("bad state\n");
  });

  test("oci.wait_until, tryMulti, reraise, tuple formatting, and ctx.obj['region'] override", () => {
    const waiterParams = [
      { name: "wait_for_state", multiple: true },
      { name: "destination_region" },
    ] as TypedParam[];
    const initResp = new ProgramResponse(
      {
        operation: {
          client: "core.blockstorage",
          method: "copy",
          http: "POST",
          path: "/",
          queryParams: {},
        },
        url: new URL("https://example.invalid/"),
        response: new Response('{"id":"b1"}', { status: 200 }),
        raw: '{"id":"b1"}',
        allPages: false,
        pageItems: [],
      } as OperationResult,
      { id: "b1" },
    );
    const pollResp = new ProgramResponse(
      {
        operation: {
          client: "core.blockstorage",
          method: "get",
          http: "GET",
          path: "/b1",
          queryParams: {},
        },
        url: new URL("https://example.invalid/b1"),
        response: new Response('{"id":"b1","lifecycleState":"AVAILABLE"}', {
          status: 200,
        }),
        raw: '{"id":"b1","lifecycleState":"AVAILABLE"}',
        allPages: false,
        pageItems: [],
      } as OperationResult,
      { id: "b1", lifecycleState: "AVAILABLE" },
      { opIndex: 1, posArgs: ["b1"], kwArgs: {}, region: "us-phoenix-1" },
    );
    const prog: Statement[] = [
      ["let", "client", ["fn", "client", "core", "blockstorage"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      ["set", ["fn", "ctxObj"], "region", kw("destination_region")],
      ["let", "client", ["fn", "client", "core", "blockstorage"]],
      [
        "tryMulti",
        [
          [
            "do",
            [
              "fn",
              "echo",
              ["call", "format", "Waiting: {}", kw("wait_for_state")],
              ["fn", "stderr"],
              true,
              false,
            ],
          ],
          [
            "let",
            "res",
            [
              "waitUntil",
              [
                ["var", "client"],
                [
                  "sdk",
                  1,
                  ["var", "client"],
                  [["attr", "id", ["attr", "data", ["var", "res"]]]],
                  [],
                  null,
                ],
                "lifecycle_state",
                kw("wait_for_state"),
              ],
              [],
              ["dict", ["max_wait_seconds", 10]],
            ],
          ],
        ],
        [
          [
            "MaximumWaitTimeExceeded",
            "e",
            [
              ["render", ["var", "res"]],
              ["exit", 2],
            ],
          ],
          ["Exception", null, [["render", ["var", "res"]], ["reraise"]]],
        ],
      ],
      ["render", ["var", "res"]],
    ];

    const values = {
      wait_for_state: ["AVAILABLE"],
      destination_region: "us-phoenix-1",
    };
    // Step 1: echo formats Click tuple with trailing comma.
    let err: unknown;
    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProgramEcho);
    expect((err as ProgramEcho).text).toBe("Waiting: ('AVAILABLE',)\n");

    // Step 2: second SDK call carries destination region from ctx.obj['region'].
    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp],
        echoCount: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProgramSdkCall);
    expect((err as ProgramSdkCall).region).toBe("us-phoenix-1");
    expect((err as ProgramSdkCall).posArgs).toEqual(["b1"]);

    // Step 3: waitUntil yields ProgramWaitUntil.
    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp, pollResp],
        echoCount: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProgramWaitUntil);
    expect((err as ProgramWaitUntil).states).toEqual(["AVAILABLE"]);
    expect((err as ProgramWaitUntil).maxWaitSeconds).toBe(10);

    // Step 4: MaximumWaitTimeExceeded enters first except -> render initial res -> exit 2.
    const timeoutErr = new ProgramRaise("MaximumWaitTimeExceeded", "timed out");
    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp, pollResp],
        echoCount: 1,
        waitResults: [timeoutErr],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProgramRender);
    expect((err as ProgramRender).response).toBe(initResp);

    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp, pollResp],
        echoCount: 1,
        renderedCount: 1,
        waitResults: [timeoutErr],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProgramExit);
    expect((err as ProgramExit).code).toBe(2);

    // Step 5: ServiceError enters except Exception -> render initial res -> reraise ServiceError.
    const svcErr = new ProgramServiceError({
      ...pollResp.result,
      response: new Response('{"code":"NotFound"}', { status: 404 }),
    });
    try {
      runProgram(prog, values, waiterParams, parse, [], undefined, {
        sdkResults: [initResp, svcErr],
        echoCount: 1,
        renderedCount: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBe(svcErr);
  });

  test("waitUntilResponse polls until state matches, handles timeout and errors", async () => {
    const mk = (status: number, body: unknown): OperationResult => ({
      operation: {
        client: "c.c",
        method: "get",
        http: "GET",
        path: "/",
        queryParams: {},
      },
      url: new URL("https://example.invalid/"),
      response: new Response(JSON.stringify(body), { status }),
      raw: JSON.stringify(body),
      allPages: false,
      pageItems: [],
    });
    const sleeps: number[] = [];
    const replies = [
      mk(200, { lifecycleState: "PROVISIONING" }),
      mk(200, { lifecycleState: "ACTIVE" }),
    ];
    let idx = 0;
    const ok = await waitUntilResponse({
      initial: mk(200, { lifecycleState: "CREATING" }),
      property: "lifecycle_state",
      states: ["ACTIVE"],
      maxWaitSeconds: 60,
      maxIntervalSeconds: 30,
      poll: async () => replies[idx++]!,
      sleep: async (s) => {
        sleeps.push(s);
      },
    });
    expect(ok.kind).toBe("response");
    expect(sleeps).toEqual([1, 2]);

    const timedOut = await waitUntilResponse({
      initial: mk(200, { status: "IN_PROGRESS" }),
      property: "status",
      states: ["SUCCEEDED"],
      maxWaitSeconds: 0,
      poll: async () => mk(200, { status: "IN_PROGRESS" }),
      sleep: async () => {},
    });
    expect(timedOut.kind).toBe("timeout");

    const errored = await waitUntilResponse({
      initial: mk(200, { status: "IN_PROGRESS" }),
      property: "status",
      states: ["SUCCEEDED"],
      maxWaitSeconds: 60,
      poll: async () => mk(404, { code: "NotFound" }),
      sleep: async () => {},
    });
    expect(errored.kind).toBe("error");
  });

  test("checkNoExtraKwargs raises TypeError like Python when callback has no **kwargs", () => {
    const program: Statement[] = [
      ["let", "a", ["call", "pop", ["var", "kwargs"], "a"]],
      ["checkNoExtraKwargs", "update_asset_source"],
    ];
    let err: ProgramRaise | undefined;
    try {
      runProgram(program, { a: 1 }, params, parse);
    } catch (e) {
      if (e instanceof ProgramRaise) err = e;
      else throw e;
    }
    expect(err?.cls).toBe("TypeError");
    expect(err?.message).toBe(
      "update_asset_source() got an unexpected keyword argument 'b'",
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { TypedParam } from "../../src/core/convert.ts";
import { bindSdkArgs, type OperationResult } from "../../src/core/operation.ts";
import {
  ProgramEcho,
  ProgramExit,
  ProgramFile,
  ProgramHeaders,
  ProgramListCall,
  ProgramRaise,
  ProgramRender,
  ProgramRenderData,
  ProgramResponse,
  ProgramSdkCall,
  ProgramServiceError,
  ProgramSleep,
  ProgramUnsupported,
  ProgramUsageError,
  ProgramWaitUntil,
  runProgram,
  toDictValue,
  type Expr,
  type Statement,
} from "../../src/core/program.ts";
import { paginateSdkList } from "../../src/core/pagination.ts";
import { renderCliData } from "../../src/core/output.ts";
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

  test("Return exits top-level, statement block, and evalBlock helper with value", () => {
    // Top-level early return skips later statements.
    const earlyTop: Statement[] = [
      ["if", ["cmp", "==", kw("a"), "stop"], [["return", null]], []],
      invoke,
    ];
    expect(
      runProgram(earlyTop, { a: "stop" }, params, parse).kwargs,
    ).toBeUndefined();
    expect(runProgram(earlyTop, { a: "go" }, params, parse).kwargs).toEqual({
      a: "go",
    });

    // Statement block catches its own return without aborting the outer program.
    const blockProg: Statement[] = [
      [
        "block",
        [
          ["set", ["var", "kwargs"], "a", "from-block"],
          ["return", null],
          ["set", ["var", "kwargs"], "a", "unreachable"],
        ],
      ],
      invoke,
    ];
    expect(runProgram(blockProg, {}, params, parse).kwargs).toEqual({
      a: "from-block",
    });

    // evalBlock returns the value passed to return, or null if falling off.
    const evalProg: Statement[] = [
      [
        "let",
        "res",
        [
          "evalBlock",
          [
            ["let", "x", ["bin", "+", 2, 3]],
            ["return", ["bin", "*", ["var", "x"], 4]],
          ],
        ] as unknown as Expr,
      ],
      ["invoke", [["ans", ["var", "res"]]], null],
    ];
    expect(runProgram(evalProg, {}, params, parse).kwargs).toEqual({ ans: 20 });
  });

  test("AugAssign mutates numbers, strings, lists in place, and dict items", () => {
    const program: Statement[] = [
      ["let", "n", 10],
      ["aug", "+", "n", 5],
      ["aug", "-", "n", 3],
      ["aug", "*", "n", 2],
      ["aug", "//", "n", 5],
      ["let", "xs", ["list", 1]],
      ["let", "alias", ["var", "xs"]],
      ["aug", "+", "xs", ["list", 2, 3]],
      ["let", "s", "hi"],
      ["aug", "+", "s", "!"],
      ["let", "d", ["dict", ["k", 7]]],
      ["augItem", "+", ["var", "d"], "k", 4],
      [
        "invoke",
        [
          ["n", ["var", "n"]],
          ["alias", ["var", "alias"]],
          ["s", ["var", "s"]],
          ["d", ["var", "d"]],
        ],
        null,
      ],
    ];
    expect(runProgram(program, {}, params, parse).kwargs).toEqual({
      n: 4,
      alias: [1, 2, 3],
      s: "hi!",
      d: { k: 11 },
    });
  });

  test("print yields ProgramEcho with sep, end, stdout/stderr, and Python formatting", () => {
    const prog: Statement[] = [
      ["do", ["fn", "print", ["list", kw("ids")], null, null, null]],
      ["do", ["fn", "print", ["list", "a", "b"], ", ", "!", ["fn", "stderr"]]],
    ];
    let first: ProgramEcho | undefined;
    try {
      runProgram(prog, { ids: ["TLS_V1_2"] }, params, parse);
    } catch (e) {
      if (e instanceof ProgramEcho) first = e;
      else throw e;
    }
    expect(first?.text).toBe("('TLS_V1_2',)\n");
    expect(first?.toStderr).toBe(false);

    let second: ProgramEcho | undefined;
    try {
      runProgram(prog, { ids: ["TLS_V1_2"] }, params, parse, [], undefined, {
        echoCount: 1,
      });
    } catch (e) {
      if (e instanceof ProgramEcho) second = e;
      else throw e;
    }
    expect(second?.text).toBe("a, b!");
    expect(second?.toStderr).toBe(true);
  });

  test("str.format supports positional, keyword, !r conversion, and **kwargs", () => {
    const prog: Statement[] = [
      [
        "invoke",
        [
          [
            "kw",
            [
              "format",
              "ns={ns} bn={bn} name={name!r}",
              [],
              [
                ["ns", "myns"],
                ["bn", "mybucket"],
                ["name", "a.txt"],
              ],
              null,
            ],
          ],
          ["pos", ["call", "format", "User {!r} not in {!r}", "u-1", "g-1"]],
          [
            "mixed",
            ["format", "{}: {val} {{ok}}", ["key"], [], ["dict", ["val", 42]]],
          ],
        ],
        null,
      ],
    ];
    expect(runProgram(prog, {}, params, parse).kwargs).toEqual({
      kw: "ns=myns bn=mybucket name='a.txt'",
      pos: "User 'u-1' not in 'g-1'",
      mixed: "key: 42 {ok}",
    });
  });

  test("os.path.expanduser and os.path.expandvars expand against context.env", () => {
    const prog: Statement[] = [
      [
        "invoke",
        [
          ["home", ["fn", "expanduser", "~/wallet.zip"]],
          ["env", ["fn", "expandvars", "$BASE/${SUB}/$UNKNOWN"]],
        ],
        null,
      ],
    ];
    expect(
      runProgram(prog, {}, params, parse, [], undefined, {
        env: { HOME: "/home/alice", BASE: "/opt", SUB: "oci" },
      }).kwargs,
    ).toEqual({
      home: "/home/alice/wallet.zip",
      env: "/opt/oci/$UNKNOWN",
    });
  });

  test("toDict, formattedFlatDict, setAttr on response.data, loadContextDefaults, and renderData", () => {
    const models = {
      Policy: {
        attributes: [
          ["id", "str", "id"],
          ["time_created", "datetime", "timeCreated"],
          ["statements", "list[str]", "statements"],
        ] as [string, string, string][],
      },
    };
    const resp = new ProgramResponse(
      {
        operation: {
          client: "identity.identity",
          method: "get_policy",
          http: "GET",
          path: "/policies/{policyId}",
          queryParams: {},
          responseType: "Policy",
        },
        responseModels: models,
        url: new URL("https://example.invalid/policies/p-1"),
        response: new Response("{}", {
          status: 200,
          headers: { etag: "e-1", "opc-request-id": "req-9" },
        }),
        raw: "{}",
        allPages: false,
        pageItems: [],
      },
      {
        id: "p-1",
        timeCreated: "2026-01-01T00:00:00Z",
        statements: ["Allow group A to read all-resources in tenancy"],
      },
    );
    expect(toDictValue(resp.data)).toEqual({
      id: "p-1",
      "time-created": "2026-01-01T00:00:00+00:00",
      statements: ["Allow group A to read all-resources in tenancy"],
    });
    expect(resp.requestId).toBe("req-9");

    // loadContextDefaults populates ctx.obj; formattedFlatDict formats sorted JSON;
    // setting result.data triggers renderData with overridden payload.
    const prog: Statement[] = [
      ["loadContextDefaults"],
      ["let", "client", ["fn", "client", "identity", "identity"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      [
        "let",
        "flat",
        [
          "fn",
          "formattedFlatDict",
          ["attr", "statements", ["attr", "data", ["var", "res"]]],
        ],
      ],
      ["let", "d", ["fn", "toDict", ["attr", "data", ["var", "res"]]]],
      ["set", ["var", "d"], "extra", ["item", ["fn", "ctxObj"], "output"]],
      ["setAttr", ["var", "res"], "data", ["var", "d"], "res.data = d"],
      ["render", ["var", "res"]],
    ];
    let rendered: ProgramRenderData | undefined;
    try {
      runProgram(prog, {}, params, parse, [], undefined, {
        sdkResults: [resp],
        loadContextDefaults: () => ({ output: "json" }),
      });
    } catch (e) {
      if (e instanceof ProgramRenderData) rendered = e;
      else throw e;
    }
    expect(rendered).toBeInstanceOf(ProgramRenderData);
    expect(rendered?.data).toEqual({
      id: "p-1",
      "time-created": "2026-01-01T00:00:00+00:00",
      statements: ["Allow group A to read all-resources in tenancy"],
      extra: "json",
    });

    // renderCliData handles display_all_headers, nest_data_in_data_attribute, table + headers, and opc-next-page.
    let out = "";
    let err = "";
    const fakeIo = {
      argv: [],
      env: {},
      cwd: "/",
      isTTY: () => false,
      columns: () => 80,
      out: (s: string) => {
        out += s;
      },
      err: (s: string) => {
        err += s;
      },
    };
    renderCliData(
      fakeIo,
      null,
      new ProgramHeaders({ ETag: "e-1", "X-Custom": "v" }).entries(),
      { rc: { cannedQueries: {}, path: "" } },
      { displayAllHeaders: true },
    );
    expect(JSON.parse(out)).toEqual({ etag: "e-1", "x-custom": "v" });
    expect(err).toBe("");

    out = "";
    err = "";
    renderCliData(
      fakeIo,
      [{ name: "a" }],
      [["opc-next-page", "p2"]],
      { output: "table", rc: { cannedQueries: {}, path: "" } },
      { displayAllHeaders: false, hasAllPagesParam: true },
    );
    expect(out).toContain("name");
    expect(err).toContain("opc-next-page: p2\n");
    expect(err).toContain("Re-run using the --all option");
  });

  test("listCall yields ProgramListCall, replays, and handles list.pop/insert and tenancyFromConfig", () => {
    const models = {
      Compartment: {
        attributes: [
          ["id", "str", "id"],
          ["name", "str", "name"],
        ] as [string, string, string][],
      },
    };
    const makeResp = (
      data: unknown,
      responseType: string,
      headers: Record<string, string> = {},
    ) =>
      new ProgramResponse(
        {
          operation: {
            client: "identity.identity",
            method: "list_compartments",
            http: "GET",
            path: "/compartments",
            responseType,
            queryParams: {},
          },
          responseModels: models,
          url: new URL("https://example.test/compartments"),
          response: new Response(JSON.stringify(data), {
            status: 200,
            headers,
          }),
          raw: JSON.stringify(data),
          allPages: false,
          pageItems: [],
        },
        data,
      );

    const prog: Statement[] = [
      ["let", "client", ["fn", "client", "identity", "identity"]],
      [
        "let",
        "res",
        [
          "listCall",
          "limit",
          false,
          0,
          ["var", "client"],
          [2, 1],
          [["compartment_id", "comp-1"]],
          null,
        ],
      ],
      ["let", "tenancy", ["fn", "tenancyFromConfig"]],
      [
        "let",
        "root",
        [
          "sdk",
          1,
          ["var", "client"],
          [],
          [["compartment_id", ["var", "tenancy"]]],
          null,
        ],
      ],
      ["do", ["call", "pop", ["attr", "data", ["var", "res"]]]],
      [
        "do",
        [
          "call",
          "insert",
          ["attr", "data", ["var", "res"]],
          0,
          ["attr", "data", ["var", "root"]],
        ],
      ],
      ["render", ["var", "res"]],
    ];

    // Step 1: yields ProgramListCall.
    let listCall: ProgramListCall | undefined;
    try {
      runProgram(prog, {}, params, parse);
    } catch (e) {
      if (e instanceof ProgramListCall) listCall = e;
      else throw e;
    }
    expect(listCall?.mode).toBe("limit");
    expect(listCall?.multipleKeys).toBe(false);
    expect(listCall?.opIndex).toBe(0);
    expect(listCall?.recordLimit).toBe(2);
    expect(listCall?.pageSize).toBe(1);
    expect(listCall?.kwArgs).toEqual({ compartment_id: "comp-1" });

    // Step 2: replay with listResults yields ProgramSdkCall with tenancyFromConfig.
    const listResp = makeResp(
      [
        { id: "c1", name: "alpha" },
        { id: "c2", name: "beta" },
      ],
      "list[Compartment]",
    );
    let sdkCall: ProgramSdkCall | undefined;
    try {
      runProgram(prog, {}, params, parse, [], undefined, {
        listResults: [listResp],
        tenancy: () => "tenancy-root",
      });
    } catch (e) {
      if (e instanceof ProgramSdkCall) sdkCall = e;
      else throw e;
    }
    expect(sdkCall?.opIndex).toBe(1);
    expect(sdkCall?.kwArgs).toEqual({ compartment_id: "tenancy-root" });

    // Step 3: replay with both mutates result.data in place (pop + insert) and triggers ProgramRenderData.
    const rootResp = makeResp(
      { id: "tenancy-root", name: "root" },
      "Compartment",
    );
    let rendered: ProgramRenderData | undefined;
    try {
      runProgram(prog, {}, params, parse, [], undefined, {
        listResults: [listResp],
        sdkResults: [rootResp],
        tenancy: () => "tenancy-root",
      });
    } catch (e) {
      if (e instanceof ProgramRenderData) rendered = e;
      else throw e;
    }
    expect(rendered).toBeInstanceOf(ProgramRenderData);
    expect(rendered?.data).toEqual([
      { id: "tenancy-root", name: "root" },
      { id: "c1", name: "alpha" },
    ]);

    // Step 4: replay after render resets listResp cleanly and does not double-mutate.
    const done = runProgram(prog, {}, params, parse, [], undefined, {
      listResults: [listResp],
      sdkResults: [rootResp],
      renderedCount: 1,
      tenancy: () => "tenancy-root",
    });
    expect(done.kwargs).toBeUndefined();
    expect(listResp.data).toEqual([
      { id: "tenancy-root", name: "root" },
      { id: "c1", name: "alpha" },
    ]);

    // stream_output=True is rejected as ProgramUnsupported.
    expect(() =>
      runProgram(
        [
          ["let", "client", ["fn", "client", "audit", "audit"]],
          [
            "do",
            [
              "listCall",
              "all",
              false,
              0,
              ["var", "client"],
              [true, true],
              [],
              null,
            ],
          ],
        ],
        {},
        params,
        parse,
      ),
    ).toThrow(ProgramUnsupported);
  });

  test("paginateSdkList matches cli_util list_call_get_all_results and list_call_get_up_to_limit semantics", async () => {
    const listModels = {
      PipelineSummary: {
        attributes: [
          ["id", "str", "id"],
          ["display_name", "str", "displayName"],
          ["time_created", "datetime", "timeCreated"],
        ] as [string, string, string][],
      },
    };
    const collectionModels = {
      Apps: {
        attributes: [
          ["items_per_page", "int", "itemsPerPage"],
          ["resources", "list[App]", "Resources"],
          ["schemas", "list[str]", "schemas"],
          ["total_results", "int", "totalResults"],
        ] as [string, string, string][],
      },
      App: {
        attributes: [
          ["id", "str", "id"],
          ["display_name", "str", "displayName"],
        ] as [string, string, string][],
      },
    };
    const pageResp = (
      data: unknown,
      responseType: string,
      models: Record<string, { attributes: [string, string, string][] }>,
      headers: Record<string, string> = {},
    ) =>
      new ProgramResponse(
        {
          operation: {
            client: "svc.svc",
            method: "list_x",
            http: "GET",
            path: "/x",
            responseType,
            queryParams: {},
          },
          responseModels: models,
          url: new URL("https://example.test/x"),
          response: new Response(JSON.stringify(data), {
            status: 200,
            headers,
          }),
          raw: JSON.stringify(data),
          allPages: false,
          pageItems: [],
        },
        data,
      );

    // 1. list_call_get_all_results on bare list with DISPLAYNAME sort DESC across 2 pages.
    const seenAll: Record<string, unknown>[] = [];
    const allRes = await paginateSdkList({
      mode: "all",
      multipleKeys: false,
      kwArgs: { sort_by: "displayName", sort_order: "DESC" },
      fetchPage: async (kw) => {
        seenAll.push(kw);
        if (seenAll.length === 1)
          return pageResp(
            [
              {
                id: "1",
                displayName: "alpha",
                timeCreated: "2026-01-01T00:00:00Z",
              },
            ],
            "list[PipelineSummary]",
            listModels,
            { "opc-next-page": "p2" },
          );
        return pageResp(
          [
            {
              id: "2",
              displayName: "zeta",
              timeCreated: "2026-01-02T00:00:00Z",
            },
          ],
          "list[PipelineSummary]",
          listModels,
        );
      },
    });
    expect(allRes).toBeInstanceOf(ProgramResponse);
    expect(seenAll).toEqual([
      { sort_by: "displayName", sort_order: "DESC" },
      { sort_by: "displayName", sort_order: "DESC", page: "p2" },
    ]);
    expect(toDictValue((allRes as ProgramResponse).data)).toEqual([
      {
        id: "2",
        "display-name": "zeta",
        "time-created": "2026-01-02T00:00:00+00:00",
      },
      {
        id: "1",
        "display-name": "alpha",
        "time-created": "2026-01-01T00:00:00+00:00",
      },
    ]);

    // 2. list_call_get_up_to_limit with recordLimit=3, pageSize=2 adjusts limit per page and truncates.
    const seenLimit: Record<string, unknown>[] = [];
    const limitRes = await paginateSdkList({
      mode: "limit",
      multipleKeys: false,
      recordLimit: 3,
      pageSize: 2,
      kwArgs: { limit: 3 },
      fetchPage: async (kw) => {
        seenLimit.push(kw);
        if (seenLimit.length === 1)
          return pageResp(
            [{ id: "1" }, { id: "2" }],
            "list[PipelineSummary]",
            listModels,
            { "opc-next-page": "p2" },
          );
        return pageResp(
          [{ id: "3" }, { id: "4" }],
          "list[PipelineSummary]",
          listModels,
          { "opc-next-page": "p3" },
        );
      },
    });
    expect(seenLimit).toEqual([{ limit: 2 }, { limit: 1, page: "p2" }]);
    expect((limitRes as ProgramResponse).data).toEqual([
      { id: "1" },
      { id: "2" },
      { id: "3" },
    ]);
    expect((limitRes as ProgramResponse).headers.get("opc-next-page")).toBe(
      "p3",
    );

    // 3. list_call_get_up_to_limit with recordLimit=0 still makes one call with limit=0.
    const seenZero: Record<string, unknown>[] = [];
    const zeroRes = await paginateSdkList({
      mode: "limit",
      multipleKeys: false,
      recordLimit: 0,
      pageSize: null,
      kwArgs: { limit: 0 },
      fetchPage: async (kw) => {
        seenZero.push(kw);
        return pageResp([{ id: "1" }], "list[PipelineSummary]", listModels);
      },
    });
    expect(seenZero).toEqual([{ limit: 0 }]);
    expect((zeroRes as ProgramResponse).data).toEqual([]);

    // 4. list_call_get_all_results_multiple_keys keeps scalars from last page and chains lists.
    const mkPages = [
      {
        itemsPerPage: 1,
        Resources: [{ id: "a1", displayName: "One" }],
        schemas: ["s1"],
        totalResults: 2,
      },
      {
        itemsPerPage: 1,
        Resources: [{ id: "a2", displayName: "Two" }],
        schemas: ["s2"],
        totalResults: 2,
      },
    ];
    let mkIdx = 0;
    const mkAll = await paginateSdkList({
      mode: "all",
      multipleKeys: true,
      kwArgs: {},
      fetchPage: async () =>
        pageResp(
          mkPages[mkIdx]!,
          "Apps",
          collectionModels,
          mkIdx++ === 0 ? { "opc-next-page": "p2" } : {},
        ),
    });
    expect((mkAll as ProgramResponse).data).toEqual({
      "items-per-page": 1,
      resources: [
        { id: "a1", "display-name": "One" },
        { id: "a2", "display-name": "Two" },
      ],
      schemas: ["s1", "s2"],
      "total-results": 2,
    });

    // 5. list_call_get_up_to_limit (non-multiple_keys) raises TypeError on int collection field.
    const typeErr = await paginateSdkList({
      mode: "limit",
      multipleKeys: false,
      recordLimit: 2,
      pageSize: null,
      kwArgs: { limit: 2 },
      fetchPage: async () => pageResp(mkPages[0]!, "Apps", collectionModels),
    });
    expect(typeErr).toBeInstanceOf(ProgramRaise);
    expect((typeErr as ProgramRaise).cls).toBe("TypeError");
    expect((typeErr as ProgramRaise).message).toBe(
      "object of type 'int' has no len()",
    );

    // 6. ServiceError on page 2 propagates cleanly.
    let errIdx = 0;
    const errRes = await paginateSdkList({
      mode: "all",
      multipleKeys: false,
      kwArgs: {},
      fetchPage: async () => {
        if (errIdx++ === 0)
          return pageResp([{ id: "1" }], "list[PipelineSummary]", listModels, {
            "opc-next-page": "p2",
          });
        return new ProgramServiceError({
          operation: {
            client: "svc.svc",
            method: "list_x",
            http: "GET",
            path: "/x",
            queryParams: {},
          },
          url: new URL("https://example.test/x"),
          response: new Response('{"code":"NotAuthorized","message":"nope"}', {
            status: 404,
          }),
          raw: '{"code":"NotAuthorized","message":"nope"}',
          allPages: false,
          pageItems: [],
        });
      },
    });
    expect(errRes).toBeInstanceOf(ProgramServiceError);
  });

  test("helper inlining compiles value returns, default/kw/star args, nested calls, shadowing, targets, and recursion guards", () => {
    const pyScript = `
import json, sys, types
sys.path.insert(0, "tools/extract")
import program

class DummyCmd:
    def __init__(self, name):
        self.name = name
        self.callback = lambda: None

cmd_tcp = DummyCmd("tcp")
cmd_udp = DummyCmd("udp")
cmd_main = DummyCmd("main")

# Sibling module inside the same services.demo package
sibling = types.ModuleType("services.demo.sibling")
sibling_src = """
DEFAULT_TAG = "from-sibling"

def sibling_enrich(d, tag=DEFAULT_TAG, *, suffix="!"):
    d["tag"] = tag + suffix
    return d["tag"]

def sibling_copy(**kwargs):
    kwargs.pop("drop", None)
    kwargs["copied"] = True
    return kwargs
"""
exec(compile(sibling_src, "<sibling>", "exec"), sibling.__dict__)
# Give inspect.getsource access via monkeypatching _fn_ast for exec'd test helpers
import ast
_sources = {}
def register_src(mod, src):
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            _sources[getattr(mod, node.name)] = node

register_src(sibling, sibling_src)

main_mod = types.ModuleType("services.demo.cli_extended")
main_mod.__dict__["sibling"] = sibling
main_mod.__dict__["sibling_copy"] = sibling.sibling_copy
main_mod.__dict__["cmd_tcp"] = cmd_tcp
main_mod.__dict__["cmd_udp"] = cmd_udp
main_mod.__dict__["cmd_main"] = cmd_main

main_src = """
def _early_return(val, fallback="none"):
    if val is None:
        return fallback
    return val.upper()

def _shadow_helper(x, kwargs):
    # Reassigning parameter x and local tmp must not clobber caller's x or tmp.
    x = "shadowed"
    tmp = "inner-tmp"
    kwargs["seen_x"] = x
    kwargs["seen_tmp"] = tmp
    return _early_return(kwargs.get("a"), fallback="defaulted")

def _dispatch(ctx, kind, tcp_cmd, udp_cmd, **kwargs):
    if kind == "tcp":
        ctx.invoke(tcp_cmd, **kwargs)
    else:
        ctx.invoke(udp_cmd, **kwargs)

def wrapper_main(ctx, **kwargs):
    x = "outer-x"
    tmp = "outer-tmp"
    res = _shadow_helper(x, kwargs)
    tag = sibling.sibling_enrich(kwargs, suffix="?")
    copied = sibling_copy(extra=1, **kwargs)
    # Original kwargs must not be mutated by **kwargs copy in sibling_copy
    kwargs["had_drop_after_copy"] = "drop" in kwargs
    kwargs["res"] = res
    kwargs["tag"] = tag
    kwargs["outer_x"] = x
    kwargs["outer_tmp"] = tmp
    kwargs["copied_flag"] = copied["copied"]
    kwargs["copied_extra"] = copied["extra"]
    kwargs["copied_has_drop"] = "drop" in copied
    _dispatch(ctx, kwargs.pop("kind"), cmd_tcp, cmd_udp, **kwargs)

def _rec_a(x):
    return _rec_b(x)

def _rec_b(x):
    return _rec_a(x)

def wrapper_rec(ctx, **kwargs):
    kwargs["v"] = _rec_a(1)
    ctx.invoke(cmd_main, **kwargs)
"""
exec(compile(main_src, "<main>", "exec"), main_mod.__dict__)
register_src(main_mod, main_src)

orig_fn_ast = program._fn_ast
program._fn_ast = lambda fn: _sources.get(fn) or orig_fn_ast(fn)
orig_import = program.importlib.import_module
program.importlib.import_module = lambda name: main_mod if name == "services.demo.cli_extended" else orig_import(name)

prog, targets, sdk_calls = program.compile_wrapper(main_mod.wrapper_main)
rec_err = program.why_unsupported(main_mod.wrapper_rec)
print(json.dumps({
    "program": prog,
    "targets": [t.name for t in targets],
    "sdkCalls": sdk_calls,
    "recErr": str(rec_err),
}))
`;
    const proc = Bun.spawnSync(["python3", "-c", pyScript], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const compiled = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      program: Statement[];
      targets: string[];
      sdkCalls: unknown[];
      recErr: string;
    };
    expect(compiled.targets).toEqual(["tcp", "udp"]);
    expect(compiled.sdkCalls).toEqual([]);
    expect(compiled.recErr).toContain("helper recursion");

    const testParams = [
      { name: "a" },
      { name: "kind" },
      { name: "drop" },
    ] as TypedParam[];
    const tcpRes = runProgram(
      compiled.program,
      { a: "hi", kind: "tcp", drop: "yes" },
      testParams,
      parse,
    );
    expect(tcpRes.target).toBe(0);
    expect(tcpRes.kwargs).toEqual({
      a: "hi",
      drop: "yes",
      seen_x: "shadowed",
      seen_tmp: "inner-tmp",
      tag: "from-sibling?",
      had_drop_after_copy: true,
      res: "HI",
      outer_x: "outer-x",
      outer_tmp: "outer-tmp",
      copied_flag: true,
      copied_extra: 1,
      copied_has_drop: false,
    });

    const udpRes = runProgram(
      compiled.program,
      { kind: "udp" },
      testParams,
      parse,
    );
    expect(udpRes.target).toBe(1);
    expect(udpRes.kwargs?.res).toBe("defaulted");
  });

  test("for tuple unpacking, break/continue, slice, cmpChain, isinstance, ctxDefaultMap, and string methods", () => {
    const program: Statement[] = [
      ["let", "out", ["dict"]],
      [
        "for",
        ["k", "v"],
        ["call", "items", ["dict", ["a", 1], ["b", 2], ["c", 3]]],
        [
          ["if", ["cmp", "==", ["var", "k"], "a"], [["continue"]], []],
          ["if", ["cmp", "==", ["var", "k"], "c"], [["break"]], []],
          ["set", ["var", "out"], ["var", "k"], ["var", "v"]],
        ],
      ],
      [
        "set",
        ["var", "out"],
        "sliced",
        ["slice", "file://hello.zip", 7, -4, null],
      ],
      [
        "set",
        ["var", "out"],
        "starts",
        ["call", "startswith", "file://x.zip", ["list", "http://", "file://"]],
      ],
      [
        "set",
        ["var", "out"],
        "ends",
        ["call", "endswith", "x.zip", ["list", ".zip", ".jar"]],
      ],
      ["set", ["var", "out"], "rep", ["call", "replace", "a_b_c", "_", "-", 1]],
      [
        "set",
        ["var", "out"],
        "chainTrue",
        [
          "cmpChain",
          1,
          [
            ["<", 5],
            ["<", 10],
          ],
        ],
      ],
      [
        "set",
        ["var", "out"],
        "chainFalse",
        [
          "cmpChain",
          5,
          [
            [">", 10],
            [">", 15],
          ],
        ],
      ],
      [
        "set",
        ["var", "out"],
        "isTuple",
        ["fn", "isinstance", kw("ids"), "tuple"],
      ],
      [
        "set",
        ["var", "out"],
        "defVal",
        ["call", "get", ["fn", "ctxDefaultMap"], "fallback_key"],
      ],
      ["invoke", [["a", ["var", "out"]]], null],
    ];
    const res = runProgram(
      program,
      { ids: ["x"] },
      params,
      parse,
      [],
      undefined,
      { defaultMap: { fallback_key: "from-json" } },
    );
    expect(res.kwargs).toEqual({
      a: {
        b: 2,
        sliced: "hello",
        starts: true,
        ends: true,
        rep: "a-b_c",
        chainTrue: true,
        chainFalse: false,
        isTuple: true,
        defVal: "from-json",
      },
    });
  });
});

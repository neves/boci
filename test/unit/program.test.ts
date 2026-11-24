import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { TypedParam } from "../../src/core/convert.ts";
import { bindSdkArgs, type OperationResult } from "../../src/core/operation.ts";
import {
  ProgramCallApi,
  ProgramEcho,
  ProgramExit,
  ProgramFile,
  ProgramHeaders,
  ProgramHttpResponse,
  ProgramListCall,
  ProgramPrompt,
  ProgramRaise,
  ProgramRawRequest,
  ProgramRender,
  ProgramRenderData,
  ProgramResponse,
  ProgramSdkCall,
  ProgramServiceError,
  ProgramSleep,
  ProgramUnsupported,
  ProgramUploadObject,
  ProgramUsageError,
  ProgramWaitUntil,
  runProgram,
  toDictValue,
  type Expr,
  type Statement,
} from "../../src/core/program.ts";
import { isZipBuffer } from "../../src/utils/zip.ts";
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

  test("while loops support break, continue, orelse, response pagination attrs, and iteration cap", () => {
    const page1 = new ProgramResponse(
      {
        response: new Response("[]", { headers: { "opc-next-page": "p2" } }),
      } as OperationResult,
      ["a"],
    );
    const page2 = new ProgramResponse(
      {
        response: new Response("[]"),
      } as OperationResult,
      ["b", "c"],
    );
    const program: Statement[] = [
      ["let", "client", ["fn", "client", "core", "virtual_network"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      ["let", "acc", ["attr", "data", ["var", "res"]]],
      [
        "while",
        ["attr", "has_next_page", ["var", "res"]],
        [
          ["let", "np", ["attr", "next_page", ["var", "res"]]],
          [
            "let",
            "res",
            ["sdk", 0, ["var", "client"], [], [["page", ["var", "np"]]], null],
          ],
          [
            "do",
            [
              "call",
              "extend",
              ["var", "acc"],
              ["attr", "data", ["var", "res"]],
            ],
          ],
        ],
        [["do", ["call", "append", ["var", "acc"], "done"]]],
      ],
      ["invoke", [["a", ["var", "acc"]]], null],
    ];
    const out = runProgram(program, {}, params, parse, [], undefined, {
      sdkResults: [page1, page2],
    });
    expect(out.kwargs).toEqual({ a: ["a", "b", "c", "done"] });

    // Break skips orelse; continue advances cleanly.
    const loopProgram: Statement[] = [
      ["let", "i", 0],
      ["let", "seen", ["list"]],
      [
        "while",
        ["cmp", "<", ["var", "i"], 5],
        [
          ["aug", "+", "i", 1],
          ["if", ["cmp", "==", ["var", "i"], 2], [["continue"]], []],
          ["do", ["call", "append", ["var", "seen"], ["var", "i"]]],
          ["if", ["cmp", "==", ["var", "i"], 3], [["break"]], []],
        ],
        [["do", ["call", "append", ["var", "seen"], 99]]],
      ],
      ["invoke", [["a", ["var", "seen"]]], null],
    ];
    expect(runProgram(loopProgram, {}, params, parse).kwargs).toEqual({
      a: [1, 3],
    });

    // Safety iteration cap stops runaway loops.
    expect(() => runProgram([["while", true, []]], {}, params, parse)).toThrow(
      ProgramUnsupported,
    );
  });

  test("tryMulti supports else, finally, tuple handlers, ServiceError attrs, and skips cleanup on suspension", () => {
    const events: string[] = [];
    const makeTry = (
      shouldFail: boolean,
      excCls = "ValueError",
    ): Statement[] => [
      ["let", "log", ["list"]],
      [
        "tryMulti",
        shouldFail
          ? [["raise", "err", excCls, "boom"]]
          : [["do", ["call", "append", ["var", "log"], "body"]]],
        [
          [
            ["ValueError", "KeyError"],
            "e",
            [
              [
                "do",
                ["call", "append", ["var", "log"], ["fn", "str", ["var", "e"]]],
              ],
            ],
          ],
        ],
        [["do", ["call", "append", ["var", "log"], "else"]]],
        [["do", ["call", "append", ["var", "log"], "finally"]]],
      ],
      ["invoke", [["a", ["var", "log"]]], null],
    ];
    expect(runProgram(makeTry(false), {}, params, parse).kwargs).toEqual({
      a: ["body", "else", "finally"],
    });
    expect(
      runProgram(makeTry(true, "ValueError"), {}, params, parse).kwargs,
    ).toEqual({
      a: ["boom", "finally"],
    });
    expect(
      runProgram(makeTry(true, "KeyError"), {}, params, parse).kwargs,
    ).toEqual({
      a: ["'boom'", "finally"],
    });

    // ServiceError attribute access inside except handler.
    const svcErr = new ProgramServiceError({
      response: new Response(
        JSON.stringify({ code: "NotFound", message: "missing" }),
        {
          status: 404,
          headers: { "opc-request-id": "req-9" },
        },
      ),
      raw: JSON.stringify({ code: "NotFound", message: "missing" }),
    } as OperationResult);
    const svcProgram: Statement[] = [
      ["let", "client", ["fn", "client", "work_requests", "work_request"]],
      [
        "tryMulti",
        [["let", "r", ["sdk", 0, ["var", "client"], [], [], null]]],
        [
          [
            "ServiceError",
            "e",
            [
              [
                "invoke",
                [
                  ["status", ["attr", "status", ["var", "e"]]],
                  ["code", ["attr", "code", ["var", "e"]]],
                  ["msg", ["attr", "message", ["var", "e"]]],
                ],
                null,
              ],
            ],
          ],
        ],
      ],
    ];
    expect(
      runProgram(svcProgram, {}, params, parse, [], undefined, {
        sdkResults: [svcErr],
      }).kwargs,
    ).toEqual({ status: 404, code: "NotFound", msg: "missing" });

    // Suspension (ProgramSdkCall) bypasses except, else, and finally.
    const suspendedProgram: Statement[] = [
      ["let", "client", ["fn", "client", "identity", "identity"]],
      [
        "tryMulti",
        [["let", "r", ["sdk", 0, ["var", "client"], [], [], null]]],
        [["Exception", null, [["usage", "should-not-catch"]]]],
        [["usage", "should-not-else"]],
        [["usage", "should-not-finally"]],
      ],
    ];
    expect(() => runProgram(suspendedProgram, {}, params, parse)).toThrow(
      ProgramSdkCall,
    );
    expect(events).toEqual([]);
  });

  test("withOpen writes and closes cleanly, reads via json.load, and supports builtins/methods", () => {
    const written = new Map<string, string>();
    const fakeFiles = {
      open(path: string, mode: string) {
        if (mode.includes("w")) {
          return new ProgramFile(mode, undefined, path, (bytes) => {
            written.set(path, new TextDecoder().decode(bytes));
          });
        }
        const content = written.get(path) ?? '{"k": 42}';
        return new ProgramFile(mode, new TextEncoder().encode(content), path);
      },
      exists: (p: string) => written.has(p),
      isfile: (p: string) => written.has(p),
      abspath: (p: string) => `/abs/${p}`,
      isZipfile: (p: string) => p.endsWith(".zip"),
    };
    const program: Statement[] = [
      [
        "withOpen",
        "f",
        ["fn", "open", "out.json", "w"],
        [
          ["do", ["call", "write", ["var", "f"], '{"ok":']],
          ["do", ["call", "write", ["var", "f"], "true}"]],
        ],
      ],
      [
        "withOpen",
        "rf",
        ["fn", "open", "out.json", "r"],
        [["let", "loaded", ["fn", "load", ["var", "rf"]]]],
      ],
      ["let", "nums", ["list", 10, 20]],
      ["do", ["call", "extend", ["var", "nums"], ["list", 30]]],
      [
        "let",
        "summary",
        [
          "dict",
          ["loaded", ["var", "loaded"]],
          ["parsed", ["fn", "loads", '{"x":1}']],
          ["enum", ["fn", "enumerate", ["list", "a", "b"], 1]],
          ["anyTrue", ["fn", "any", ["list", 0, "", "yes"]]],
          ["anyFalse", ["fn", "any", ["list", 0, "", null]]],
          ["allTrue", ["fn", "all", ["list", 1, "x"]]],
          ["intDec", ["fn", "int", " 42 "]],
          ["intHex", ["fn", "int", "0xff", 16]],
          ["minPair", ["fn", "min", 5, 2]],
          ["minList", ["fn", "min", ["list", 9, 3, 7]]],
          ["maxPair", ["fn", "max", 5, 2]],
          ["mapped", ["fn", "list", ["fn", "pyMap", "str", ["var", "nums"]]]],
          ["found", ["call", "find", "ocid1.test", "ocid"]],
          ["notFound", ["call", "find", "hello", "ocid"]],
          ["abs", ["fn", "abspath", "rel.txt"]],
          ["zipOk", ["fn", "isZipfile", "wallet.zip"]],
          ["zipNo", ["fn", "isZipfile", "wallet.txt"]],
          ["styled", ["fn", "clickStyle", "warn", ["dict", ["fg", "yellow"]]]],
        ],
      ],
      ["invoke", [["a", ["var", "summary"]]], null],
    ];
    const res = runProgram(program, {}, params, parse, [], fakeFiles);
    expect(written.get("out.json")).toBe('{"ok":true}');
    expect(res.kwargs).toEqual({
      a: {
        loaded: { ok: true },
        parsed: { x: 1 },
        enum: [
          [1, "a"],
          [2, "b"],
        ],
        anyTrue: true,
        anyFalse: false,
        allTrue: true,
        intDec: 42,
        intHex: 255,
        minPair: 2,
        minList: 3,
        maxPair: 5,
        mapped: ["10", "20", "30"],
        found: 0,
        notFound: -1,
        abs: "/abs/rel.txt",
        zipOk: true,
        zipNo: false,
        styled: "\x1b[33mwarn\x1b[0m",
      },
    });
  });

  test("invoke expression assigns result and executes trailing cleanup like _invoke_update", () => {
    const deleted: string[] = [];
    const fakeFiles = {
      open: () => {
        throw new ProgramUnsupported("open");
      },
      exists: () => false,
      isfile: () => false,
      deleteFnEndpointCache: (_ctx: Record<string, unknown>, id: string) => {
        deleted.push(id);
      },
    };
    const program: Statement[] = [
      ["let", "res", ["invoke", [["function_id", kw("a")]], ["var", "kwargs"]]],
      ["do", ["fn", "deleteFnEndpointCache", ["fn", "ctxObj"], kw("a")]],
      ["return", ["var", "res"]],
    ];
    const out = runProgram(
      program,
      { a: "ocid1.fn.1" },
      params,
      parse,
      [],
      fakeFiles,
    );
    expect(out.kwargs).toEqual({ a: "ocid1.fn.1", function_id: "ocid1.fn.1" });
    expect(deleted).toEqual(["ocid1.fn.1"]);
  });

  test("str(sdkModel) and sdkFormattedFlatDict produce snake_case JSON while formattedFlatDict produces hyphenated JSON", () => {
    const models = {
      RoverWorkload: {
        attributes: [
          ["id", "str", "id"],
          ["workload_type", "str", "workloadType"],
        ] as [string, string, string][],
      },
    };
    const resp = new ProgramResponse(
      {
        responseModels: models,
        operation: { responseType: "RoverWorkload" },
        response: new Response("{}"),
      } as unknown as OperationResult,
      { id: "w1", workloadType: "IMAGE" },
    );
    const program: Statement[] = [
      ["let", "client", ["fn", "client", "rover", "rover_node"]],
      ["let", "res", ["sdk", 0, ["var", "client"], [], [], null]],
      ["let", "w", ["attr", "data", ["var", "res"]]],
      [
        "invoke",
        [
          ["parsed", ["fn", "loads", ["fn", "str", ["var", "w"]]]],
          ["sdkFmt", ["fn", "sdkFormattedFlatDict", ["var", "w"]]],
          ["cliFmt", ["fn", "formattedFlatDict", ["var", "w"]]],
        ],
        null,
      ],
    ];
    const out = runProgram(program, {}, params, parse, [], undefined, {
      sdkResults: [resp],
    });
    expect(out.kwargs?.parsed).toEqual({ id: "w1", workload_type: "IMAGE" });
    expect(out.kwargs?.sdkFmt).toBe(
      JSON.stringify({ id: "w1", workload_type: "IMAGE" }, null, 2),
    );
    expect(out.kwargs?.cliFmt).toBe(
      JSON.stringify({ id: "w1", "workload-type": "IMAGE" }, null, 2),
    );
  });

  test("isZipBuffer detects valid ZIP EOCD records with and without comments", () => {
    // Minimal empty ZIP (22-byte EOCD).
    const emptyZip = new Uint8Array(22);
    emptyZip.set([0x50, 0x4b, 0x05, 0x06], 0);
    expect(isZipBuffer(emptyZip)).toBe(true);

    // ZIP with 5-byte comment.
    const commentedZip = new Uint8Array(27);
    commentedZip.set([0x50, 0x4b, 0x05, 0x06], 0);
    commentedZip[20] = 5;
    commentedZip[21] = 0;
    expect(isZipBuffer(commentedZip)).toBe(true);

    // Mismatched comment length / non-zip data.
    commentedZip[20] = 4;
    expect(isZipBuffer(commentedZip)).toBe(false);
    expect(isZipBuffer(new TextEncoder().encode("not a zip file at all"))).toBe(
      false,
    );
    expect(isZipBuffer(new Uint8Array(10))).toBe(false);
  });

  test("program.py compiles While, try/else/finally, with open, builtins, and _invoke_update", () => {
    const py = `
import ast, json, sys, types
sys.path.insert(0, "tools/extract")
import program

class _DummyCmd:
    def callback(self): pass

oci_util = types.ModuleType("oci.util")
def formatted_flat_dict(x): return x
formatted_flat_dict.__module__ = "oci.util"
oci_util.formatted_flat_dict = formatted_flat_dict

mod = types.ModuleType("services.demo.cli_extended")
mod.target_cmd = _DummyCmd()
mod.formatted_flat_dict = formatted_flat_dict

src = """
def _helper(ctx, kwargs):
    res = ctx.invoke(target_cmd, **kwargs)
    return res

def sample_wrapper(ctx, **kwargs):
    i = int("3")
    xs = [1]
    xs.extend([2, 3])
    while i > 0:
        i -= 1
    try:
        v = json.loads("{}")
    except (ValueError, KeyError) as e:
        v = None
    else:
        v = min(1, 2)
    finally:
        ok = any(x > 0 for x in xs)
    with open("a.txt", "w") as f:
        f.write(click.style("hi", fg="yellow"))
    p = os.path.abspath("a.txt")
    z = zipfile.is_zipfile(p)
    pos = "abc".find("b")
    m = list(map(str, xs))
    e = list(enumerate(xs, 1))
    s = formatted_flat_dict(kwargs)
    _helper(ctx, kwargs)
"""
exec(compile(src, "<demo>", "exec"), mod.__dict__)
mod._helper.__module__ = mod.__name__
mod.sample_wrapper.__module__ = mod.__name__
tree = ast.parse(src)
ast_map = {mod.__dict__[n.name]: n for n in tree.body if isinstance(n, ast.FunctionDef)}
orig_fn_ast = program._fn_ast
program._fn_ast = lambda fn: ast_map.get(fn) or orig_fn_ast(fn)
orig_import = program.importlib.import_module
program.importlib.import_module = lambda name: mod if name == mod.__name__ else orig_import(name)

prog, targets, sdk_calls = program.compile_wrapper(mod.sample_wrapper)
assert prog is not None, program.why_unsupported(mod.sample_wrapper)
print(json.dumps({"n_stmts": len(prog), "n_targets": len(targets)}))
`;
    const res = Bun.spawnSync(["python3", "-c", py], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode, new TextDecoder().decode(res.stderr)).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(res.stdout));
    expect(parsed.n_targets).toBe(1);
    expect(parsed.n_stmts).toBeGreaterThan(5);
  });

  test("ProgramModel constructs with defaults, sets/gets snake_case attrs, and serializes non-None wire keys", () => {
    const models = {
      database: {
        CreateDbHomeWithDbSystemIdDetails: {
          attributes: [
            ["db_system_id", "str", "dbSystemId"],
            ["source", "str", "source"],
            ["display_name", "str", "displayName"],
            ["database", "CreateDatabaseDetails", "database"],
          ] as [string, string, string][],
        },
        CreateDatabaseDetails: {
          attributes: [
            ["db_name", "str", "dbName"],
            ["admin_password", "str", "adminPassword"],
          ] as [string, string, string][],
        },
      },
    };
    const program: Statement[] = [
      [
        "let",
        "db",
        [
          "model",
          "database",
          "CreateDatabaseDetails",
          [],
          [["db_name", "ORCL"]],
          null,
        ],
      ],
      [
        "setAttr",
        ["var", "db"],
        "admin_password",
        "Secret123",
        "db.admin_password = 'Secret123'",
      ],
      [
        "let",
        "home",
        [
          "model",
          "database",
          "CreateDbHomeWithDbSystemIdDetails",
          [["source", "NONE"]],
          [],
          null,
        ],
      ],
      ["setAttr", ["var", "home"], "db_system_id", "ocid1.dbsys..1", ""],
      ["setAttr", ["var", "home"], "database", ["var", "db"], ""],
      [
        "invoke",
        [
          ["source", ["attr", "source", ["var", "home"]]],
          ["missing", ["attr", "display_name", ["var", "home"]]],
          ["wire", ["fn", "loads", ["fn", "dumps", ["var", "home"]]]],
        ],
        null,
      ],
    ];
    const out = runProgram(program, {}, [], parse, [], undefined, { models });
    expect(out.kwargs?.source).toBe("NONE");
    expect(out.kwargs?.missing).toBeUndefined(); // None dropped from invoke kwargs
    expect(out.kwargs?.wire).toEqual({
      dbSystemId: "ocid1.dbsys..1",
      source: "NONE",
      database: {
        dbName: "ORCL",
        adminPassword: "Secret123",
      },
    });
  });

  test("f-strings, format specs, % formatting, range, round, sorted, dirname, json.dumps opts, random.choice replay", () => {
    const program: Statement[] = [
      [
        "let",
        "f1",
        [
          "fstr",
          "hi ",
          ["fmtVal", "bob", null, ">5s"],
          " ",
          ["fmtVal", 42, null, "04d"],
          " ",
          ["fmtVal", 3.14159, null, ".2f"],
        ],
      ],
      ["let", "f2", ["call", "format", "| {:^6s} | {:>4d} |", "ok", 7]],
      ["let", "f3", ["bin", "%", "%3.1f %s", ["list", 2.5, "Mb"]]],
      ["let", "rng", ["fn", "range", 1, 6, 2]],
      ["let", "r1", ["fn", "round", 2.5]],
      ["let", "r2", ["fn", "round", 3.5]],
      ["let", "r3", ["fn", "round", 3.14159, 2]],
      ["let", "srt", ["fn", "sorted", ["list", 3, 1, 2], null, true]],
      ["let", "d1", ["fn", "dirname", "/a/b/c.txt"]],
      ["let", "d2", ["fn", "dirname", "plain.txt"]],
      [
        "let",
        "j1",
        ["fn", "dumpsOpts", ["dict", ["b", 1], ["a", 2]], 2, true, null, true],
      ],
      [
        "let",
        "j2",
        [
          "fn",
          "dumpsOpts",
          ["dict", ["b", 1], ["a", 2]],
          null,
          true,
          ["list", ",", ":"],
          true,
        ],
      ],
      ["let", "rc1", ["fn", "randomChoice", "abcdef"]],
      [
        "invoke",
        [
          ["f1", ["var", "f1"]],
          ["f2", ["var", "f2"]],
          ["f3", ["var", "f3"]],
          ["rng", ["var", "rng"]],
          ["r1", ["var", "r1"]],
          ["r2", ["var", "r2"]],
          ["r3", ["var", "r3"]],
          ["srt", ["var", "srt"]],
          ["d1", ["var", "d1"]],
          ["d2", ["var", "d2"]],
          ["j1", ["var", "j1"]],
          ["j2", ["var", "j2"]],
          ["rc1", ["var", "rc1"]],
        ],
        null,
      ],
    ];
    const randomChoices: unknown[] = [];
    const out1 = runProgram(program, {}, [], parse, [], undefined, {
      randomChoices,
    });
    const out2 = runProgram(program, {}, [], parse, [], undefined, {
      randomChoices,
    });
    expect(out1.kwargs?.f1).toBe("hi   bob 0042 3.14");
    expect(out1.kwargs?.f2).toBe("|   ok   |    7 |");
    expect(out1.kwargs?.f3).toBe("2.5 Mb");
    expect(out1.kwargs?.rng).toEqual([1, 3, 5]);
    expect(out1.kwargs?.r1).toBe(2); // Python banker's rounding
    expect(out1.kwargs?.r2).toBe(4);
    expect(out1.kwargs?.r3).toBe(3.14);
    expect(out1.kwargs?.srt).toEqual([3, 2, 1]);
    expect(out1.kwargs?.d1).toBe("/a/b");
    expect(out1.kwargs?.d2).toBe("");
    expect(out1.kwargs?.j1).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(out1.kwargs?.j2).toBe('{"a":2,"b":1}');
    expect(out1.kwargs?.rc1).toBe(out2.kwargs?.rc1);
  });

  test("click.prompt, oci.config.from_file, cli_util.build_config, jmespath, and base_client.call_api", () => {
    const program: Statement[] = [
      ["let", "cfg", ["fn", "configFromFile", "~/.oci/config", "DEFAULT"]],
      ["let", "bcfg", ["fn", "buildConfig", ["fn", "ctxObj"]]],
      ["let", "jp", ["fn", "jmespathFromContext"]],
      [
        "let",
        "choice",
        [
          "fn",
          "prompt",
          "Enter number",
          false,
          null,
          false,
          false,
          "int",
          ": ",
          true,
          false,
        ],
      ],
      ["setCtxAttr", "endpoint", null],
      ["set", ["fn", "ctxObj"], "endpoint", null],
      [
        "let",
        "client",
        ["fn", "client", "database_tools_runtime", "database_tools_runtime"],
      ],
      [
        "let",
        "res",
        [
          "callApi",
          0,
          ["var", "client"],
          [],
          [
            ["resource_path", "/x"],
            ["method", "POST"],
            ["body", ["dict", ["k", ["var", "choice"]]]],
            ["response_type", "object"],
          ],
          null,
        ],
      ],
      [
        "invoke",
        [
          ["tenancy", ["item", ["var", "cfg"], "tenancy"]],
          ["region", ["item", ["var", "bcfg"], "region"]],
          [
            "picked",
            ["call", "search", ["var", "jp"], ["attr", "data", ["var", "res"]]],
          ],
        ],
        null,
      ],
    ];
    const ctx = {
      configFromFile: () => ({ tenancy: "ocid1.tenancy..t1" }),
      buildConfig: () => ({ region: "us-ashburn-1" }),
      resolveQuery: () => "items[0].name",
      endpoint: "https://override.example",
    };
    let thrown: unknown;
    try {
      runProgram(program, {}, [], parse, [], undefined, ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProgramPrompt);
    expect((thrown as ProgramPrompt).typeSpec).toBe("int");

    let apiThrown: unknown;
    try {
      runProgram(program, {}, [], parse, [2], undefined, ctx);
    } catch (e) {
      apiThrown = e;
    }
    expect(apiThrown).toBeInstanceOf(ProgramCallApi);
    const api = apiThrown as ProgramCallApi;
    expect(api.resourcePath).toBe("/x");
    expect(api.method).toBe("POST");
    expect(api.body).toEqual({ k: 2 });
    expect(api.endpoint).toBeNull();

    const resp = new ProgramResponse(
      {
        operation: {
          client: "database_tools_runtime.database_tools_runtime",
          method: "exec",
          http: "POST",
          path: "/x",
          queryParams: {},
        },
        url: new URL("https://example.invalid/x"),
        response: new Response(JSON.stringify({ items: [{ name: "alpha" }] }), {
          status: 200,
        }),
        raw: JSON.stringify({ items: [{ name: "alpha" }] }),
        allPages: false,
        pageItems: [],
      },
      { items: [{ name: "alpha" }] },
    );
    const out = runProgram(program, {}, [], parse, [2], undefined, {
      ...ctx,
      sdkResults: [resp],
    });
    expect(out.kwargs).toEqual({
      tenancy: "ocid1.tenancy..t1",
      region: "us-ashburn-1",
      picked: "alpha",
    });
  });

  test("program.py compiles Batch 7 features: models, constants, f-strings, builtins, prompt, config, jmespath, call_api", () => {
    const py = `
import ast, json, sys, types
sys.path.insert(0, "tools/extract")
import program

class FakeModel:
    __module__ = "oci.database.models.fake_model"
    CONST_VAL = "ZIP_UPLOAD"
    def __init__(self, **kwargs):
        self.swagger_types = {"source": "str", "db_name": "str"}
        self.attribute_map = {"source": "source", "db_name": "dbName"}
        self.source = kwargs.get("source", "NONE")
        self.db_name = kwargs.get("db_name", None)

oci_mod = types.ModuleType("oci")
oci_db = types.ModuleType("oci.database")
oci_db_models = types.ModuleType("oci.database.models")
oci_db_models.FakeModel = FakeModel
oci_db.models = oci_db_models
oci_mod.database = oci_db

oci_cfg = types.ModuleType("oci.config")
def from_file(file_location=None, profile_name=None): pass
from_file.__module__ = "oci.config"
oci_cfg.from_file = from_file
oci_mod.config = oci_cfg

cli_util = types.ModuleType("oci_cli.cli_util")
def build_config(x): pass
build_config.__module__ = "oci_cli.cli_util"
def get_jmespath_expression_from_context(ctx): pass
get_jmespath_expression_from_context.__module__ = "oci_cli.cli_util"
cli_util.build_config = build_config
cli_util.get_jmespath_expression_from_context = get_jmespath_expression_from_context

mod = types.ModuleType("services.demo.cli_extended")
mod.oci = oci_mod
mod.cli_util = cli_util
mod.string = __import__("string")

src = """
def batch7_wrapper(ctx, **kwargs):
    m = oci.database.models.FakeModel(db_name="ORCL")
    m.source = oci.database.models.FakeModel.CONST_VAL
    cfg = oci.config.from_file(file_location=ctx.obj['config_file'], profile_name=ctx.obj['profile'])
    bcfg = cli_util.build_config(ctx.obj)
    jp = cli_util.get_jmespath_expression_from_context(ctx)
    n = click.prompt("Enter", type=int)
    s = f"val={n:02d} {round(1.234, 1)}"
    xs = [random.choice(string.ascii_lowercase) for _ in range(4)]
    ys = sorted(xs, reverse=True)
    d = os.path.dirname("/a/b/c")
    j = json.dumps({"s": s, "d": d}, indent=2)
    ctx.endpoint = None
    client = cli_util.build_client("database", "database", ctx)
    res = client.base_client.call_api(resource_path="/x", method="POST", body=m, response_type="object")
    if jp:
        x = jp.search(res.data)
    cli_util.render_response(res, ctx)
"""
exec(compile(src, "<demo>", "exec"), mod.__dict__)
mod.batch7_wrapper.__module__ = mod.__name__
tree = ast.parse(src)
ast_map = {mod.__dict__[n.name]: n for n in tree.body if isinstance(n, ast.FunctionDef)}
orig_fn_ast = program._fn_ast
program._fn_ast = lambda fn: ast_map.get(fn) or orig_fn_ast(fn)
orig_import = program.importlib.import_module
program.importlib.import_module = lambda name: mod if name == mod.__name__ else orig_import(name)

prog, targets, sdk_calls = program.compile_wrapper(mod.batch7_wrapper)
assert prog is not None, program.why_unsupported(mod.batch7_wrapper)
assert sdk_calls == [("database", "database", "__call_api__")], sdk_calls
print(json.dumps({"ok": True, "stmts": len(prog)}))
`;
    const res = Bun.spawnSync(["python3", "-c", py], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode, new TextDecoder().decode(res.stderr)).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(res.stdout));
    expect(parsed.ok).toBe(true);
  });
});

describe("Batch 8 program features (raw sessions, lambdas, time/fstat/bytes.fromhex/readline/decrypt)", () => {
  test("sorted with lambda key, closure variable, and reverse", () => {
    const program: Statement[] = [
      ["let", "field", "score"],
      [
        "let",
        "rows",
        [
          "list",
          ["dict", ["id", "a"], ["score", 10]],
          ["dict", ["id", "b"], ["score", 30]],
          ["dict", ["id", "c"], ["score", 20]],
        ],
      ],
      [
        "let",
        "out",
        [
          "fn",
          "sorted",
          ["var", "rows"],
          ["lambda", ["$x"], ["item", ["var", "$x"], ["var", "field"]]],
          true,
        ],
      ],
      ["invoke", [["result", ["var", "out"]]], null],
    ];
    const res = runProgram(program, {}, [], (_, v) => v);
    expect(res.kwargs?.result).toEqual([
      { id: "b", score: 30 },
      { id: "c", score: 20 },
      { id: "a", score: 10 },
    ]);
  });

  test("time.time() caches timestamps across replay", () => {
    const timestamps: number[] = [];
    const program: Statement[] = [
      ["let", "t1", ["fn", "time"]],
      ["invoke", [["t1", ["var", "t1"]]], null],
    ];
    const r1 = runProgram(program, {}, [], (_, v) => v, [], undefined, {
      timestamps,
    });
    expect(typeof r1.kwargs?.t1).toBe("number");
    expect(timestamps).toHaveLength(1);
    const r2 = runProgram(program, {}, [], (_, v) => v, [], undefined, {
      timestamps,
    });
    expect(r2.kwargs?.t1).toBe(r1.kwargs?.t1);
  });

  test("file.readline(), file.fileno() + os.fstat().st_size, and bytes.fromhex()", () => {
    const content = new TextEncoder().encode("deadbeef\nsecond line\n");
    const f = new ProgramFile("r", content, "key.txt");
    const program: Statement[] = [
      ["let", "f", ["item", ["var", "kwargs"], "f"]],
      [
        "let",
        "line1",
        ["call", "strip", ["call", "readline", ["var", "f"]], "\n"],
      ],
      ["let", "line2", ["call", "readline", ["var", "f"]]],
      ["let", "eof", ["call", "readline", ["var", "f"]]],
      [
        "let",
        "size",
        ["attr", "st_size", ["fn", "fstat", ["call", "fileno", ["var", "f"]]]],
      ],
      [
        "let",
        "raw",
        ["fn", "bytesFromHex", ["call", "ljust", ["var", "line1"], 16, "0"]],
      ],
      ["let", "fname", ["attr", "name", ["var", "f"]]],
      [
        "invoke",
        [
          ["line1", ["var", "line1"]],
          ["line2", ["var", "line2"]],
          ["eof", ["var", "eof"]],
          ["size", ["var", "size"]],
          ["raw", ["var", "raw"]],
          ["fname", ["var", "fname"]],
        ],
        null,
      ],
    ];
    const res = runProgram(
      program,
      { f },
      [{ name: "f" }] as unknown as TypedParam[],
      (_, v) => v,
    );
    expect(res.kwargs?.line1).toBe("deadbeef");
    expect(res.kwargs?.line2).toBe("second line\n");
    expect(res.kwargs?.eof).toBe("");
    expect(res.kwargs?.size).toBe(content.length);
    expect(res.kwargs?.fname).toBe("key.txt");
    expect(res.kwargs?.raw).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00]),
    );
  });

  test("re.match + .group() and str.splitlines()", () => {
    const program: Statement[] = [
      ["let", "lines", ["call", "splitlines", "user alice\npassword s3cr3t\n"]],
      ["let", "u", null],
      ["let", "p", null],
      [
        "for",
        "line",
        ["var", "lines"],
        [
          ["let", "um", ["fn", "reMatch", "^user\\s+(\\D.+)", ["var", "line"]]],
          [
            "let",
            "pm",
            ["fn", "reMatch", "^password\\s+(.+)", ["var", "line"]],
          ],
          [
            "if",
            ["var", "um"],
            [["let", "u", ["call", "group", ["var", "um"], 1]]],
            [],
          ],
          [
            "if",
            ["var", "pm"],
            [["let", "p", ["call", "group", ["var", "pm"], 1]]],
            [],
          ],
        ],
      ],
      [
        "invoke",
        [
          ["u", ["var", "u"]],
          ["p", ["var", "p"]],
        ],
        null,
      ],
    ];
    const res = runProgram(program, {}, [], (_, v) => v);
    expect(res.kwargs).toEqual({ u: "alice", p: "s3cr3t" });
  });

  test("withSession + RetryStrategyBuilder + make_retrying_call + ProgramHttpResponse + simpleResponse", () => {
    const program: Statement[] = [
      [
        "withSession",
        "sess",
        ["fn", "rawSession"],
        [
          [
            "do",
            [
              "call",
              "update",
              ["attr", "params", ["var", "sess"]],
              ["dict", ["k", "v"]],
            ],
          ],
          [
            "setAttr",
            ["var", "sess"],
            "auth",
            ["list", "alice", "pw"],
            "sess.auth = ...",
          ],
          [
            "let",
            "strat",
            [
              "retryBuilderMethod",
              "get_retry_strategy",
              [
                "fn",
                "retryStrategyBuilder",
                ["dict", ["total_elapsed_time_seconds", 120]],
              ],
              [],
              [],
            ],
          ],
          [
            "let",
            "resp",
            [
              "retryCall",
              ["var", "strat"],
              [["attr", "request", ["var", "sess"]]],
              [
                ["method", "POST"],
                ["url", "http://127.0.0.1:9999/test"],
                ["json", ["dict", ["a", 1]]],
                ["stream", false],
              ],
              null,
            ],
          ],
          ["do", ["call", "raise_for_status", ["var", "resp"]]],
          [
            "render",
            [
              "fn",
              "simpleResponse",
              ["call", "json", ["var", "resp"]],
              [
                "dictcomp",
                ["call", "items", ["attr", "headers", ["var", "resp"]]],
                ["k", "v"],
                ["var", "k"],
                ["var", "v"],
                [],
              ],
            ],
          ],
        ],
      ],
    ];
    let caught: unknown;
    try {
      runProgram(program, {}, [], (_, v) => v);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProgramRawRequest);
    const req = caught as ProgramRawRequest;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://127.0.0.1:9999/test");
    expect(req.params).toEqual({ k: "v" });
    expect(req.basicAuth).toEqual(["alice", "pw"]);
    expect(req.hasJson).toBe(true);
    expect(req.json).toEqual({ a: 1 });

    const body = '{"ok":true}';
    const fakeResp = new ProgramHttpResponse(
      200,
      "OK",
      { "content-type": "application/json" },
      new TextEncoder().encode(body),
      body,
      req.url,
    );
    let rendered: unknown;
    try {
      runProgram(program, {}, [], (_, v) => v, [], undefined, {
        rawResults: [fakeResp],
      });
    } catch (e) {
      rendered = e;
    }
    expect(rendered).toBeInstanceOf(ProgramRenderData);
    expect((rendered as ProgramRenderData).data).toEqual({ ok: true });
  });

  test("roverBundleDecrypt decrypts AES-128-CBC PKCS7 payload", () => {
    const keyHex = "00112233445566778899aabbccddeeff";
    const keyBytes = Buffer.from(keyHex, "hex");
    const cipher = createCipheriv("aes-128-cbc", keyBytes, keyBytes);
    const plaintext = new TextEncoder().encode(
      "diagnostic-bundle-secret-payload",
    );
    const ciphertext = new Uint8Array(
      Buffer.concat([cipher.update(plaintext), cipher.final()]),
    );
    const store = new Map<string, Uint8Array>([["/tmp/in.enc", ciphertext]]);
    const files = {
      open(path: string, mode: string) {
        if (mode.includes("w")) {
          return new ProgramFile(mode, undefined, path, (bytes) => {
            store.set(path, bytes);
          });
        }
        return new ProgramFile(mode, store.get(path)!, path);
      },
      exists: (p: string) => store.has(p),
      isfile: (p: string) => store.has(p),
    };
    const program: Statement[] = [
      [
        "do",
        ["fn", "roverBundleDecrypt", "/tmp/in.enc", "/tmp/out.dec", keyHex],
      ],
    ];
    runProgram(program, {}, [], (_, v) => v, [], files);
    expect(new TextDecoder().decode(store.get("/tmp/out.dec")!)).toBe(
      "diagnostic-bundle-secret-payload",
    );
  });

  test("roverUploadMultipart suspends with ProgramUploadObject", () => {
    const f = new ProgramFile(
      "rb",
      new TextEncoder().encode("bundle"),
      "b.tar",
    );
    const program: Statement[] = [
      ["let", "f", ["item", ["var", "kwargs"], "f"]],
      [
        "do",
        [
          "fn",
          "roverUploadMultipart",
          ["fn", "ctxObj"],
          ["var", "f"],
          "ns1",
          "rover-system-upgrade-staging",
          "b.tar",
        ],
      ],
    ];
    let caught: unknown;
    try {
      runProgram(
        program,
        { f },
        [{ name: "f" }] as unknown as TypedParam[],
        (_, v) => v,
        [],
        undefined,
        {
          endpoint: "http://127.0.0.1:9999",
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProgramUploadObject);
    const up = caught as ProgramUploadObject;
    expect(up.namespace).toBe("ns1");
    expect(up.bucketName).toBe("rover-system-upgrade-staging");
    expect(up.objectName).toBe("b.tar");
    expect(up.endpoint).toBe("http://127.0.0.1:9999");
  });

  test("tools/extract/program.py compiles Batch 8 constructs (withSession, progressbar, Lambda, time.time, os.fstat, bytes.fromhex, readline)", () => {
    const py = `
import ast, json, os, sys, time, timeit, types
sys.path.insert(0, "tools/extract")
import program

cli_util = types.ModuleType("oci_cli.cli_util")
def build_raw_requests_session(ctx): pass
build_raw_requests_session.__module__ = "oci_cli.cli_util"
def create_config_and_signer_based_on_click_context(ctx): pass
create_config_and_signer_based_on_click_context.__module__ = "oci_cli.cli_util"
def pretty_print_format(d): pass
pretty_print_format.__module__ = "oci_cli.cli_util"
cli_util.build_raw_requests_session = build_raw_requests_session
cli_util.create_config_and_signer_based_on_click_context = create_config_and_signer_based_on_click_context
cli_util.pretty_print_format = pretty_print_format

retry_mod = types.ModuleType("oci.retry.retry")
class RetryStrategyBuilder:
    def __init__(self, **kw): pass
RetryStrategyBuilder.__module__ = "oci.retry.retry"
class FakeRetryStrategy: pass
FakeRetryStrategy.__module__ = "oci.retry.retry"
DEFAULT_RETRY_STRATEGY = FakeRetryStrategy()

mod = types.ModuleType("services.demo.cli_extended")
mod.cli_util = cli_util
mod.create_config_and_signer_based_on_click_context = create_config_and_signer_based_on_click_context
mod.RetryStrategyBuilder = RetryStrategyBuilder
mod.DEFAULT_RETRY_STRATEGY = DEFAULT_RETRY_STRATEGY
mod.time = time
mod.os = os
mod.timer = timeit.default_timer

src = """
def batch8_wrapper(ctx, **kwargs):
    create_config_and_signer_based_on_click_context(ctx)
    now = time.time()
    t0 = timer()
    raw = bytes.fromhex("aabb")
    rows = sorted([{"k": 2}, {"k": 1}], key=lambda x: x["k"], reverse=True)
    with open("x.txt") as f:
        line = f.readline()
        sz = os.fstat(f.fileno()).st_size
    with cli_util.build_raw_requests_session(ctx) as sess:
        strat = RetryStrategyBuilder(total_elapsed_time_seconds=60).get_retry_strategy()
        r = strat.make_retrying_call(sess.request, method="GET", url="http://127.0.0.1/x", stream=True)
        with click.progressbar(length=10, label="DL", file=sys.stderr) as bar:
            for c in r.iter_content(chunk_size=4):
                bar.update(4)
            bar.finished = True
            bar.render_finish()
        print(cli_util.pretty_print_format({"now": now, "t0": t0, "rows": rows, "line": line, "sz": sz}))
"""
exec(compile(src, "<demo>", "exec"), mod.__dict__)
mod.batch8_wrapper.__module__ = mod.__name__
tree = ast.parse(src)
ast_map = {mod.__dict__[n.name]: n for n in tree.body if isinstance(n, ast.FunctionDef)}
orig_fn_ast = program._fn_ast
program._fn_ast = lambda fn: ast_map.get(fn) or orig_fn_ast(fn)
orig_import = program.importlib.import_module
program.importlib.import_module = lambda name: mod if name == mod.__name__ else orig_import(name)

prog, targets, sdk_calls = program.compile_wrapper(mod.batch8_wrapper)
assert prog is not None, program.why_unsupported(mod.batch8_wrapper)
assert targets == [] and sdk_calls == []
print(json.dumps({"ok": True, "stmts": len(prog)}))
`;
    const res = Bun.spawnSync(["python3", "-c", py], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode, new TextDecoder().decode(res.stderr)).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(res.stdout));
    expect(parsed.ok).toBe(true);
  });

  test("batch 9 primitives: parameter source, regions, bytes/rawStream, bytearray/BytesIO, CliDatetime, setClientRegion, raiseMulti", () => {
    const regions = {
      regions: ["us-phoenix-1", "us-ashburn-1", "us-langley-1"],
      shortNames: { phx: "us-phoenix-1", iad: "us-ashburn-1" },
      regionRealms: {
        "us-phoenix-1": "oc1",
        "us-ashburn-1": "oc1",
        "us-langley-1": "oc2",
      },
      realms: { oc1: "oraclecloud.com", oc2: "oraclegovcloud.com" },
      serviceEndpoints: {},
      domainFormat: "https://{service}.{region}.{secondLevelDomain}",
    };
    const out = runProgram(
      [
        ["let", "src1", ["fn", "getParameterSource", "auth_id"]],
        ["let", "src2", ["fn", "getParameterSource", "missing"]],
        ["let", "r1", ["fn", "isRegion", "us-phoenix-1"]],
        ["let", "r2", ["fn", "isRegion", "phx"]],
        ["let", "r3", ["fn", "isRegion", "nope"]],
        ["let", "rlm1", ["fn", "getRealmFromRegion", "us-langley-1"]],
        ["let", "rlm2", ["fn", "getRealmFromRegion", "phx"]],
        ["let", "buf", ["bytes", ""]],
        ["aug", "+", "buf", ["bytes", "aGVsbG8="]],
        ["let", "ba", ["fn", "bytearray", ["var", "buf"]]],
        ["let", "bio", ["fn", "bytesIO", ["var", "ba"]]],
        [
          "let",
          "txt",
          ["call", "decode", ["call", "read", ["var", "bio"]], "utf-8"],
        ],
        [
          "invoke",
          [
            ["src1", ["var", "src1"]],
            ["src2", ["var", "src2"]],
            ["r1", ["var", "r1"]],
            ["r2", ["var", "r2"]],
            ["r3", ["var", "r3"]],
            ["rlm1", ["var", "rlm1"]],
            ["rlm2", ["var", "rlm2"]],
            ["txt", ["var", "txt"]],
          ],
          null,
        ],
      ],
      {},
      [],
      (_n, v) => v,
      [],
      undefined,
      {
        paramSources: { auth_id: "COMMANDLINE" },
        regions,
      },
    );
    expect(out.kwargs).toEqual({
      src1: "COMMANDLINE",
      src2: "DEFAULT",
      r1: true,
      r2: false,
      r3: false,
      rlm1: "oc2",
      rlm2: "oc1",
      txt: "hello",
    });

    expect(() =>
      runProgram(
        [["raiseMulti", "raise Exception('a', 'b')", "Exception", "a", "b"]],
        {},
        [],
        (_n, v) => v,
      ),
    ).toThrow("('a', 'b')");
  });
});

/**
 * A Tier B wrapper's body, compiled by the extractor to a small JSON program
 * (tools/extract/program.py), run here over the wrapper's kwargs. It folds flat options
 * into the complex params of the generated command it invokes; the result is that
 * command's kwargs, which the Engine then binds to the request like any Generated command.
 */
import { createDecipheriv, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { applyQuery } from "../lib/query.ts";
import { expandHomeDir } from "../utils/expandHomeDir.ts";
import { decodePythonUtf8 } from "../utils/utf8.ts";
import { isZipBuffer } from "../utils/zip.ts";
import { inheritedDiscriminator, type Model, type Models } from "./camelize.ts";
import type { DatetimeSpec, TypedParam } from "./convert.ts";
import {
  BadParameter,
  convertCliDatetime,
  pyRepr,
  TimestampRangeError,
} from "./convert.ts";
import type { RegionsSpec } from "./endpoint.ts";
import type { OperationResult } from "./operation.ts";
import { ModelDeserializationError, renderModel } from "./output.ts";
import { expandVars } from "./rc.ts";
import { kwarg, truthy } from "./checks.ts";

export type Expr = null | boolean | number | string | Expr[];
export type Statement = (string | Expr | Statement[])[];

/** `raise click.UsageError(message)` in the wrapper. */
export class ProgramUsageError extends Error {}

/**
 * `raise cls(message)` in the wrapper, for an exception class cli_util.wrap_exceptions
 * renders; `message` is what Python's `str()` gives the exception.
 */
export class ProgramRaise extends Error {
  constructor(
    readonly cls: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `click.confirm(text, ...)` with no answer yet: the caller asks, then runs the program again
 * with the answers so far (a program is a pure function of its kwargs and answers).
 */
export class ProgramConfirm extends Error {
  constructor(
    text: string,
    readonly defaultValue = false,
    readonly abort = false,
    readonly promptSuffix = ": ",
    readonly showDefault = true,
    readonly toStderr = false,
  ) {
    super(text);
  }
}

export type PromptChoiceSpec = {
  kind: "choice";
  choices: string[];
  caseSensitive: boolean;
};

export type PromptTypeSpec =
  "str" | "int" | "float" | "bool" | PromptChoiceSpec | null;

/**
 * `click.prompt(text, ...)` with no answer yet: answered like ProgramConfirm.
 */
export class ProgramPrompt extends Error {
  constructor(
    readonly text: string,
    readonly hasDefault: boolean,
    readonly defaultValue: unknown,
    readonly hideInput: boolean,
    readonly confirmationPrompt: boolean,
    readonly typeSpec: PromptTypeSpec,
    readonly promptSuffix: string,
    readonly showDefault: boolean,
    readonly toStderr: boolean,
  ) {
    super(text);
  }
}

/**
 * `click.prompt(text, hide_input=True, confirmation_prompt=True)` with no answer yet:
 * answered like ProgramConfirm, with the string entered.
 */
export class ProgramSecret extends Error {}

/** What a program has been answered so far: click.confirm's booleans, prompts' strings/numbers. */
export type ProgramAnswer = boolean | string | number;

/** `ctx.abort()` in the wrapper. */
export class ProgramAbort extends Error {}

/** The wrapper took a path the Engine does not model (another exception, a TypeError). */
export class ProgramUnsupported extends Error {}

type Dict = Record<string, unknown>;

/**
 * `client.get_namespace().data` before the Engine has looked the namespace up: it makes
 * the request, then runs the program again with the answer (ticket 23).
 */
export class ProgramLookup extends Error {
  constructor(
    readonly region?: string,
    readonly endpoint?: string | null,
  ) {
    super("get_namespace");
  }
}

/**
 * Case-insensitive header mapping matching `oci.response.Response.headers`
 * (`requests.structures.CaseInsensitiveDict`).
 */
export class ProgramHeaders {
  private readonly map = new Map<string, [string, string]>();

  constructor(init?: Headers | Record<string, string> | null) {
    if (init instanceof Headers) {
      init.forEach((value, key) => {
        this.map.set(key.toLowerCase(), [key, value]);
      });
    } else if (init && typeof init === "object") {
      for (const [key, value] of Object.entries(init)) {
        this.map.set(key.toLowerCase(), [key, value]);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key.toLowerCase());
  }

  get(key: string): string | undefined {
    return this.map.get(key.toLowerCase())?.[1];
  }

  keys(): string[] {
    return [...this.map.values()].map(([k]) => k);
  }

  entries(): [string, string][] {
    return [...this.map.values()];
  }
}

export type ProgramSdkCallRecord = {
  opIndex: number;
  posArgs: unknown[];
  kwArgs: Dict;
  region?: string;
  endpoint?: string | null;
};

type ModelMeta = {
  models: Record<string, Model>;
  type: string;
};

const modelMeta = new WeakMap<object, ModelMeta>();
const responseOwner = new WeakMap<object, ProgramResponse>();

function markMutated(obj: object): void {
  const owner = responseOwner.get(obj);
  if (owner) owner.dataOverridden = true;
}

function cloneResponseData(v: unknown): unknown {
  if (Array.isArray(v)) return [...v];
  if (isDict(v)) {
    const copy: Dict = { ...v };
    const meta = modelMeta.get(v);
    if (meta) modelMeta.set(copy, meta);
    return copy;
  }
  return v;
}

export function tagModelData(
  data: unknown,
  models: Record<string, Model> | undefined,
  typeName: string | undefined,
): void {
  if (!models || !typeName) return;
  const listMatch = /^list\[(.*)\]$/.exec(typeName);
  if (listMatch && Array.isArray(data)) {
    const itemType = listMatch[1]!;
    for (const elem of data) tagModelData(elem, models, itemType);
    return;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    typeName in models
  ) {
    modelMeta.set(data, { models, type: typeName });
  }
}

/** An SDK operation response held by a program (`result = client.<method>(...)`). */
export class ProgramResponse {
  readonly headers: ProgramHeaders;
  readonly status: number | null;
  data: unknown;
  dataOverridden: boolean;
  private readonly initialData: unknown;
  private readonly initialDataOverridden: boolean;
  constructor(
    readonly result: OperationResult,
    data: unknown,
    readonly call?: ProgramSdkCallRecord,
    headers?: Headers | Record<string, string>,
    dataOverridden = false,
  ) {
    if (!dataOverridden) {
      tagModelData(
        data,
        result?.responseModels,
        result?.operation?.responseType,
      );
    }
    this.initialData = cloneResponseData(data);
    this.initialDataOverridden = dataOverridden;
    this.data = cloneResponseData(this.initialData);
    this.dataOverridden = dataOverridden;
    if (this.data && typeof this.data === "object") {
      responseOwner.set(this.data, this);
    }
    this.headers = new ProgramHeaders(headers ?? result?.response?.headers);
    this.status = result?.response?.status ?? null;
  }

  /** Restore pristine data and override state before each replay of runProgram. */
  reset(): void {
    this.data = cloneResponseData(this.initialData);
    this.dataOverridden = this.initialDataOverridden;
    if (this.data && typeof this.data === "object") {
      responseOwner.set(this.data, this);
    }
  }

  get requestId(): string | null {
    return this.headers.get("opc-request-id") ?? null;
  }

  get nextPage(): string | null {
    return this.headers.get("opc-next-page") ?? null;
  }

  get hasNextPage(): boolean {
    return this.nextPage !== null;
  }
}

/**
 * A non-2xx SDK response raised inside a program (`oci.exceptions.ServiceError`).
 * Catchable by `except ServiceError:` and `except Exception:`.
 */
export class ProgramServiceError extends Error {
  private parsedBody?: { code?: string; message?: string } | null;

  constructor(readonly result: OperationResult) {
    super(`ServiceError(${result.response.status})`);
  }

  get status(): number {
    return this.result.response.status;
  }

  get headers(): ProgramHeaders {
    return new ProgramHeaders(this.result.response.headers);
  }

  get requestId(): string | null {
    return this.headers.get("opc-request-id") ?? null;
  }

  private body(): { code?: string; message?: string } | null {
    if (this.parsedBody !== undefined) return this.parsedBody;
    try {
      const parsed = JSON.parse(this.result.raw);
      this.parsedBody =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { code?: string; message?: string })
          : null;
    } catch {
      this.parsedBody = null;
    }
    return this.parsedBody;
  }

  get code(): string | null {
    const c = this.body()?.code;
    return typeof c === "string" ? c : null;
  }

  get serviceMessage(): string {
    const m = this.body()?.message;
    return typeof m === "string" ? m : this.result.raw;
  }
}

/**
 * `client.<method>(*pos, **kw)` before the Engine has executed that SDK call: the caller
 * sends the HTTP request, appends a ProgramResponse (or error) to `context.sdkResults`,
 * and replays.
 */
export class ProgramSdkCall extends Error {
  constructor(
    readonly opIndex: number,
    readonly posArgs: unknown[],
    readonly kwArgs: Dict,
    readonly region?: string,
    readonly endpoint?: string | null,
  ) {
    super(`sdk[${opIndex}]`);
  }
}

/**
 * `client.base_client.call_api(...)` before the Engine has executed that raw API call:
 * the caller sends the HTTP request, appends a ProgramResponse (or error) to
 * `context.sdkResults`, and replays.
 */
export class ProgramCallApi extends Error {
  constructor(
    readonly opIndex: number,
    readonly resourcePath: string,
    readonly method: string,
    readonly pathParams: Dict | null,
    readonly queryParams: Dict | [string, unknown][] | null,
    readonly headerParams: Dict | null,
    readonly body: unknown,
    readonly responseType: string | null,
    readonly enforceContentHeaders: boolean,
    readonly operationName: string | null,
    readonly region?: string,
    readonly endpoint?: string | null,
  ) {
    super(`callApi[${opIndex}]`);
  }
}

/**
 * `cli_util.render_response(result, ctx)` before the Engine has rendered that response:
 * the caller prints it, increments `context.renderedCount`, and replays.
 */
export class ProgramRender extends Error {
  constructor(readonly response: ProgramResponse) {
    super("render_response");
  }
}

/**
 * `cli_util.render(data, headers, ctx, display_all_headers=..., nest_data_in_data_attribute=...)`
 * before the Engine has rendered it: caller renders, increments `renderedCount`, replays.
 */
export class ProgramRenderData extends Error {
  constructor(
    readonly data: unknown,
    readonly headers: ProgramHeaders | Dict | null,
    readonly displayAllHeaders: boolean,
    readonly nestDataInDataAttribute: boolean,
  ) {
    super("render");
  }
}

/** Internal control-flow signals for Python `return`/`break`/`continue` (never caught by `except Exception:`). */
class ProgramReturn {
  constructor(readonly value: unknown) {}
}
class ProgramBreak {}
class ProgramContinue {}

/** `click.echo(...)`: caller writes text to stdout/stderr, increments `echoCount`, replays. */
export class ProgramEcho extends Error {
  constructor(
    readonly text: string,
    readonly toStderr: boolean,
  ) {
    super("click.echo");
  }
}

/** `sys.exit(...)`: terminates the command (not caught by `except Exception:`). */
export class ProgramExit extends Error {
  constructor(
    readonly code: number,
    readonly output?: string,
  ) {
    super(`sys.exit(${code})`);
  }
}

/** `time.sleep(seconds)`: caller sleeps, increments `sleepCount`, replays. */
export class ProgramSleep extends Error {
  constructor(readonly seconds: number) {
    super(`time.sleep(${seconds})`);
  }
}

/**
 * `oci.wait_until(client, response, property, states, **kw)`: caller polls the getter
 * via the Engine's waiter, appends the outcome to `context.waitResults`, and replays.
 */
export class ProgramWaitUntil extends Error {
  constructor(
    readonly response: ProgramResponse,
    readonly property: string,
    readonly states: string[],
    readonly maxWaitSeconds: number,
    readonly maxIntervalSeconds: number,
    readonly succeedOnNotFound: boolean,
  ) {
    super(`wait_until(${property})`);
  }
}

/**
 * `cli_util.list_call_get_all_results[_multiple_keys]` or
 * `cli_util.list_call_get_up_to_limit[_multiple_keys]`: caller runs the paginated
 * SDK list loop, appends the outcome to `context.listResults`, and replays.
 */
export class ProgramListCall extends Error {
  constructor(
    readonly mode: "all" | "limit",
    readonly multipleKeys: boolean,
    readonly opIndex: number,
    readonly kwArgs: Dict,
    readonly region?: string,
    readonly recordLimit?: unknown,
    readonly pageSize?: unknown,
    readonly endpoint?: string | null,
  ) {
    super(`listCall[${mode}:${opIndex}]`);
  }
}

export type ProgramSdkOutcome =
  ProgramResponse | ProgramRaise | ProgramServiceError;

/** Raw HTTP response matching Python `requests.Response` (for `build_raw_requests_session`). */
export class ProgramHttpResponse {
  readonly headers: ProgramHeaders;
  readonly requestHeaders: ProgramHeaders;
  constructor(
    readonly statusCode: number,
    readonly reason: string,
    headers: Headers | Record<string, string>,
    readonly content: Uint8Array,
    readonly text: string,
    readonly requestUrl: string,
    requestHeaders: Record<string, string> = {},
  ) {
    this.headers = new ProgramHeaders(headers);
    this.requestHeaders = new ProgramHeaders(requestHeaders);
  }

  json(): unknown {
    try {
      return JSON.parse(this.text);
    } catch (err) {
      throw new ProgramRaise(
        "JSONDecodeError",
        err instanceof Error ? err.message : "Invalid JSON",
      );
    }
  }

  raiseForStatus(): void {
    if (this.statusCode >= 400) {
      const kind = this.statusCode < 500 ? "Client" : "Server";
      throw new ProgramRaise(
        "HTTPError",
        `${this.statusCode} ${kind} Error: ${this.reason} for url: ${this.requestUrl}`,
      );
    }
  }

  iterContent(chunkSize = 1): Uint8Array[] {
    const size = Math.max(1, Math.trunc(chunkSize));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < this.content.length; i += size) {
      chunks.push(this.content.subarray(i, i + size));
    }
    return chunks;
  }
}

export type ProgramRawOutcome = ProgramHttpResponse | ProgramRaise;

/** Raw HTTP request suspension from `requests_session.request(...)` / `make_retrying_call`. */
export class ProgramRawRequest extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly params: Dict | null,
    readonly headers: Record<string, string>,
    readonly data: unknown,
    readonly hasJson: boolean,
    readonly json: unknown,
    readonly stream: boolean,
    readonly basicAuth: [string, string] | null,
    readonly retryMode: "default" | "builder" | "none",
    readonly requestId: string | null,
  ) {
    super(`rawRequest ${method} ${url}`);
  }
}

/** Object Storage bundle upload suspension (`rover_utils.upload_multi_part`). */
export class ProgramUploadObject extends Error {
  constructor(
    readonly file: ProgramFile,
    readonly namespace: string,
    readonly bucketName: string,
    readonly objectName: string,
    readonly region?: string,
    readonly endpoint?: string | null,
    readonly requestId?: string | null,
  ) {
    super(`uploadObject ${bucketName}/${objectName}`);
  }
}

export type ProgramUploadOutcome = null | ProgramRaise | ProgramServiceError;

/** Lightweight response wrapper (`RoverDiagAPI(data=..., headers=...)`) for `cli_util.render_response`. */
class ProgramSimpleResponse {
  constructor(
    readonly data: unknown,
    readonly headers: ProgramHeaders | Dict | null,
  ) {}
}

/** Python `requests.Session` built by `cli_util.build_raw_requests_session(ctx)`. */
class ProgramRequestsSession {
  readonly params: Dict = {};
  readonly headers: ProgramHeaders;
  auth: [string, string] | null = null;
  constructor(requestId: string | null) {
    this.headers = new ProgramHeaders(
      requestId ? { "opc-request-id": requestId } : {},
    );
  }
}

/** Bound method reference (e.g. `requests_session.request` passed to `make_retrying_call`). */
class ProgramBoundMethod {
  constructor(
    readonly target: unknown,
    readonly method: string,
  ) {}
}

/** OCI SDK retry strategy / builder (`DEFAULT_RETRY_STRATEGY`, `NoneRetryStrategy`, `RetryStrategyBuilder`). */
class ProgramRetryStrategy {
  constructor(
    readonly mode: "default" | "builder" | "none",
    readonly opts: Dict = {},
  ) {}
}

/** Click progressbar handle (`with click.progressbar(...) as bar:`). */
class ProgramProgressBar {
  finished = false;
  printed = false;
  constructor(
    readonly length: number | null,
    readonly label: string,
    readonly toStderr: boolean,
  ) {}
}

/** Single-expression Python `lambda` value. */
class ProgramLambda {
  constructor(
    readonly params: string[],
    readonly body: Expr,
  ) {}
}

/** Result of `re.match(pattern, string)`. */
class ProgramMatch {
  constructor(readonly groups: (string | undefined)[]) {}

  group(n = 0): string | null {
    if (!Number.isInteger(n) || n < 0 || n >= this.groups.length) {
      throw new ProgramRaise("IndexError", "no such group");
    }
    return this.groups[n] ?? null;
  }
}

/** Result of `os.fstat(fd)`. */
class ProgramStatResult {
  constructor(readonly st_size: number) {}
}

/**
 * What a program reads outside its kwargs: the config region `build_client` puts in
 * `ctx.obj['config']`, `ctx.obj['request_id']`, the namespace `get_namespace()` returned,
 * and cached SDK responses / side-effect counts for deterministic replay.
 */
export type ProgramContext = {
  region?: () => string | undefined;
  tenancy?: () => string | null;
  namespace?: string;
  requestId?: string | null;
  endpoint?: string | null;
  configFile?: string | null;
  profile?: string | null;
  auth?: string | null;
  enableDualStack?: boolean;
  regionOverride?: string | null;
  query?: string | null;
  output?: string | null;
  debug?: boolean;
  noRetry?: boolean;
  maxAttempts?: number | null;
  defaultMap?: Dict | null;
  defaultValuesFromFile?: Dict | null;
  env?: Record<string, string | undefined>;
  models?: Models;
  configFromFile?: (fileLocation?: string, profileName?: string) => Dict;
  buildConfig?: (commandArgs: Dict) => Dict;
  createConfigAndSigner?: (commandArgs: Dict) => Dict;
  loadFileContents?: (path: string) => string | null;
  resolveQuery?: () => string | null;
  loadContextDefaults?: () => Dict;
  sdkResults?: ProgramSdkOutcome[];
  rawResults?: ProgramRawOutcome[];
  uploadResults?: ProgramUploadOutcome[];
  listResults?: ProgramSdkOutcome[];
  waitResults?: ProgramSdkOutcome[];
  randomChoices?: unknown[];
  timestamps?: number[];
  renderedCount?: number;
  echoCount?: number;
  sleepCount?: number;
  writtenFiles?: Set<number>;
  paramSources?: Record<
    string,
    "COMMANDLINE" | "DEFAULT" | "DEFAULT_MAP" | "ENVIRONMENT"
  >;
  regions?: RegionsSpec;
  datetime?: DatetimeSpec;
};

/**
 * An instantiated OCI SDK model (`oci.<service>.models.<Model>(...)`): Python code reads
 * and writes `snake_case` attributes, and JSON serialization maps non-None fields to wire
 * `camelCase` keys via `attribute_map` (from `spec.models`).
 */
export class ProgramModel {
  readonly attrMap = new Map<string, string>();
  readonly attrs: Dict = {};

  constructor(
    readonly module: string,
    readonly name: string,
    readonly model: Model | undefined,
    defaults: [string, unknown][] = [],
  ) {
    if (model) {
      for (const [snake, , camel] of model.attributes) {
        this.attrMap.set(snake, camel);
      }
    }
    for (const [snake, val] of defaults) {
      this.attrs[snake] = val;
    }
  }

  getAttr(attr: string): unknown {
    if (attr in this.attrs) return this.attrs[attr];
    if (this.attrMap.has(attr)) return null;
    throw new ProgramRaise(
      "AttributeError",
      `'${this.name}' object has no attribute '${attr}'`,
    );
  }

  setAttr(attr: string, value: unknown): void {
    this.attrs[attr] = value;
  }

  toWireDict(): Dict {
    const out: Dict = {};
    if (this.attrMap.size > 0) {
      for (const [snake, wire] of this.attrMap) {
        const val = this.attrs[snake];
        if (val !== undefined && val !== null) {
          out[wire] = serializeModelValue(val);
        }
      }
    } else {
      for (const [k, val] of Object.entries(this.attrs)) {
        if (val !== undefined && val !== null) {
          out[snakeToCamel(k)] = serializeModelValue(val);
        }
      }
    }
    return out;
  }

  toJSON(): Dict {
    return this.toWireDict();
  }
}

function serializeModelValue(v: unknown): unknown {
  if (v instanceof ProgramModel) return v.toWireDict();
  if (Array.isArray(v)) return v.map(serializeModelValue);
  if (isDict(v)) {
    const out: Dict = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = serializeModelValue(val);
    }
    return out;
  }
  return v;
}

/** A compiled JMESPath expression returned by `cli_util.get_jmespath_expression_from_context(ctx)`. */
class ProgramJmespath {
  constructor(readonly expression: string) {}
}

/**
 * An object only some keys of which a program reads: `ctx.obj` (its 'config', a KeyError
 * until build_client runs), that config, or an SDK client.
 */
class ProgramObject {
  constructor(
    readonly kind: string,
    readonly fields: Dict = {},
  ) {}
}

/** A generated command as a value: `{'k': generated_cli.get_x}[key]` picks what to invoke. */
class ProgramTarget {
  constructor(readonly index: number) {}
}

/**
 * An option typed `click.File`, as the wrapper sees it: opened during option conversion
 * (`data` holds what a read-mode file contains). Text mode decodes UTF-8 with universal
 * newlines, like Python's `open(path, "r")`; a second read returns "" (the file is
 * consumed). Write modes are only passed through to the generated command.
 */
export class ProgramFile {
  private consumed = false;
  private closed = false;
  private textOffset = 0;
  private byteOffset = 0;
  private readonly chunks: Uint8Array[] = [];
  private assignedFd?: number;
  constructor(
    readonly mode: string,
    private readonly data?: Uint8Array,
    /** The path given on the command line (`-` for stdio), when the file came from one. */
    readonly name?: string,
    private readonly onClose?: (data: Uint8Array) => void,
  ) {}

  /** The same file, unread: each run of a program opens its files afresh. */
  reopen(): ProgramFile {
    return new ProgramFile(this.mode, this.data, this.name, this.onClose);
  }

  get binary(): boolean {
    return this.mode.includes("b");
  }

  get writable(): boolean {
    return /[wax+]/.test(this.mode);
  }

  get size(): number {
    return this.data?.length ?? 0;
  }

  getFd(alloc: () => number): number {
    if (this.assignedFd === undefined) this.assignedFd = alloc();
    return this.assignedFd;
  }

  private decodedText(): string {
    if (this.data === undefined || /[wax+]/.test(this.mode))
      throw new ProgramUnsupported("io.UnsupportedOperation: not readable");
    let text: string;
    try {
      text = decodePythonUtf8(this.data);
    } catch {
      throw new ProgramUnsupported("UnicodeDecodeError");
    }
    return text.replace(/\r\n?/g, "\n");
  }

  read(): string | Uint8Array {
    if (this.data === undefined || /[wax+]/.test(this.mode))
      throw new ProgramUnsupported("io.UnsupportedOperation: not readable");
    if (this.binary) {
      const out = this.consumed
        ? new Uint8Array()
        : this.data.subarray(this.byteOffset);
      this.byteOffset = this.data.length;
      this.consumed = true;
      return out;
    }
    const text = this.decodedText();
    const out = this.consumed ? "" : text.slice(this.textOffset);
    this.textOffset = text.length;
    this.consumed = true;
    return out;
  }

  readline(): string | Uint8Array {
    if (this.data === undefined || /[wax+]/.test(this.mode))
      throw new ProgramUnsupported("io.UnsupportedOperation: not readable");
    if (this.binary) {
      if (this.consumed || this.byteOffset >= this.data.length) {
        this.consumed = true;
        return new Uint8Array();
      }
      const nl = this.data.indexOf(0x0a, this.byteOffset);
      const end = nl === -1 ? this.data.length : nl + 1;
      const out = this.data.subarray(this.byteOffset, end);
      this.byteOffset = end;
      if (this.byteOffset >= this.data.length) this.consumed = true;
      return out;
    }
    const text = this.decodedText();
    if (this.consumed || this.textOffset >= text.length) {
      this.consumed = true;
      return "";
    }
    const nl = text.indexOf("\n", this.textOffset);
    const end = nl === -1 ? text.length : nl + 1;
    const out = text.slice(this.textOffset, end);
    this.textOffset = end;
    if (this.textOffset >= text.length) this.consumed = true;
    return out;
  }

  write(chunk: unknown): number {
    if (!this.writable)
      throw new ProgramUnsupported("io.UnsupportedOperation: not writable");
    if (this.closed)
      throw new ProgramRaise("ValueError", "I/O operation on closed file.");
    if (this.binary) {
      if (!(chunk instanceof Uint8Array))
        throw new ProgramRaise(
          "TypeError",
          "a bytes-like object is required, not 'str'",
        );
      this.chunks.push(chunk);
      return chunk.length;
    }
    if (typeof chunk !== "string")
      throw new ProgramRaise("TypeError", "write() argument must be str");
    this.chunks.push(new TextEncoder().encode(chunk));
    return chunk.length;
  }

  close(): void {
    if (this.closed) return;
    if (!this.writable) return;
    this.closed = true;
    if (!this.onClose) return;
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.onClose(out);
  }

  /** `for line in file`: text lines, each with its newline. */
  lines(): string[] {
    if (this.binary) throw new ProgramUnsupported("iterating a binary file");
    return (this.read() as string).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  }
}

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof ProgramFile) &&
  !(v instanceof ProgramTarget) &&
  !(v instanceof ProgramObject) &&
  !(v instanceof ProgramResponse) &&
  !(v instanceof ProgramSimpleResponse) &&
  !(v instanceof ProgramHttpResponse) &&
  !(v instanceof ProgramRequestsSession) &&
  !(v instanceof ProgramBoundMethod) &&
  !(v instanceof ProgramRetryStrategy) &&
  !(v instanceof ProgramProgressBar) &&
  !(v instanceof ProgramLambda) &&
  !(v instanceof ProgramMatch) &&
  !(v instanceof ProgramStatResult) &&
  !(v instanceof ProgramHeaders) &&
  !(v instanceof ProgramModel) &&
  !(v instanceof ProgramJmespath) &&
  !(v instanceof Error) &&
  !(v instanceof Uint8Array);

const pyTruthy = (v: unknown): boolean => {
  if (v instanceof ProgramHeaders) return v.size > 0;
  if (
    v instanceof ProgramResponse ||
    v instanceof ProgramSimpleResponse ||
    v instanceof ProgramHttpResponse ||
    v instanceof ProgramRequestsSession ||
    v instanceof ProgramBoundMethod ||
    v instanceof ProgramRetryStrategy ||
    v instanceof ProgramProgressBar ||
    v instanceof ProgramLambda ||
    v instanceof ProgramMatch ||
    v instanceof ProgramStatResult ||
    v instanceof ProgramObject ||
    v instanceof ProgramFile ||
    v instanceof ProgramTarget ||
    v instanceof ProgramModel ||
    v instanceof ProgramJmespath
  )
    return true;
  if (isDict(v) && modelMeta.has(v)) return true;
  return truthy(v);
};

/** `cli_util.to_dict(obj)` (hyphenated) or `oci.util.to_dict(obj)` (snake_case). */
export function toDictValue(v: unknown, snakeCase = false): unknown {
  if (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return v;
  if (v instanceof ProgramHeaders) return Object.fromEntries(v.entries());
  if (v instanceof ProgramModel) {
    const out: Dict = {};
    const keys =
      v.attrMap.size > 0 ? [...v.attrMap.keys()] : Object.keys(v.attrs);
    for (const snake of keys) {
      const key = snakeCase ? snake : snake.replaceAll("_", "-");
      const val = snake in v.attrs ? v.attrs[snake] : null;
      out[key] = toDictValue(val, snakeCase);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((elem) => toDictValue(elem, snakeCase));
  if (isDict(v)) {
    const meta = modelMeta.get(v);
    if (meta) {
      try {
        return renderModel(v, meta.type, meta.models, snakeCase);
      } catch (e) {
        if (e instanceof ModelDeserializationError) {
          throw new ProgramRaise(e.pythonType, e.message);
        }
        throw e;
      }
    }
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, toDictValue(val, snakeCase)]),
    );
  }
  return v;
}

/** Python iteration: a list's items, a dict's keys, a str's characters, a file's lines. */
function iterate(v: unknown): unknown[] {
  if (v === null || v === undefined) {
    throw new ProgramRaise("TypeError", "'NoneType' object is not iterable");
  }
  if (Array.isArray(v)) return v;
  if (v instanceof ProgramHeaders) return v.keys();
  if (isDict(v)) return Object.keys(v);
  if (typeof v === "string") return [...v];
  if (v instanceof ProgramFile) return v.lines();
  throw new ProgramUnsupported("not iterable");
}

/** Python `str.rstrip(chars)` / `str.strip(chars)`. */
function stripChars(s: string, chars: string, left: boolean): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1] as string)) end--;
  let start = 0;
  if (left) while (start < end && chars.includes(s[start] as string)) start++;
  return s.slice(start, end);
}

function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof ProgramModel && b instanceof ProgramModel) {
    if (a.module !== b.module || a.name !== b.name) return false;
    const keys = new Set([
      ...a.attrMap.keys(),
      ...Object.keys(a.attrs),
      ...Object.keys(b.attrs),
    ]);
    for (const k of keys) {
      if (!pyEq(a.attrs[k] ?? null, b.attrs[k] ?? null)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => k in b && pyEq(a[k], b[k]))
    );
  }
  return false;
}

/** Click `multiple=True` options arrive as Python tuples, not lists. */
const pyTuples = new WeakSet<unknown[]>();

function pyElemRepr(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  return pyStr(v);
}

/** Python `str()` of a scalar, tuple, or list. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (v instanceof ProgramModel) {
    return JSON.stringify(sortKeys(toDictValue(v, true)), null, 2);
  }
  // `except Exception as e: ... str(e)`
  if (v instanceof ProgramRaise) return v.message;
  if (Array.isArray(v)) {
    const parts = v.map(pyElemRepr);
    if (pyTuples.has(v)) {
      if (parts.length === 0) return "()";
      if (parts.length === 1) return `(${parts[0]},)`;
      return `(${parts.join(", ")})`;
    }
    return `[${parts.join(", ")}]`;
  }
  if (isDict(v)) {
    // OCI SDK models implement __str__/__repr__ as oci.util.formatted_flat_dict(self).
    if (modelMeta.has(v)) {
      return JSON.stringify(sortKeys(toDictValue(v, true)), null, 2);
    }
    const parts = Object.entries(v).map(
      ([k, val]) => `${pyRepr(k)}: ${pyElemRepr(val)}`,
    );
    return `{${parts.join(", ")}}`;
  }
  throw new ProgramUnsupported("str() of a container");
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Resolve Python `snake_case` attribute lookup on a decoded OCI SDK model object. */
export function modelAttr(obj: Dict, attr: string): unknown {
  const meta = modelMeta.get(obj);
  if (meta) {
    let modelName = meta.type;
    let model = meta.models[modelName];
    if (model) {
      const disc = inheritedDiscriminator(meta.models, model);
      if (disc && typeof obj[disc.field] === "string") {
        const subName = Object.hasOwn(disc.values, obj[disc.field] as string)
          ? (disc.values[obj[disc.field] as string] as string)
          : disc.fallback;
        if (meta.models[subName]) {
          modelName = subName;
          model = meta.models[subName];
        }
      }
      const entry = model.attributes.find(([snake]) => snake === attr);
      if (!entry) {
        throw new ProgramRaise(
          "AttributeError",
          `'${modelName}' object has no attribute '${attr}'`,
        );
      }
      const [snake, swaggerType, camel] = entry;
      const val = camel in obj ? obj[camel] : snake in obj ? obj[snake] : null;
      if (val !== null && val !== undefined) {
        tagModelData(val, meta.models, swaggerType);
      }
      return val;
    }
  }
  if (attr in obj) return obj[attr];
  const camel = snakeToCamel(attr);
  if (camel in obj) return obj[camel];
  return null;
}

const MAX_WHILE_ITERATIONS = 10_000;

/** Engine replay/stop traps that must bypass Python `except`/`else`/`finally`/`with` cleanup. */
function isSuspension(e: unknown): boolean {
  return (
    e instanceof ProgramConfirm ||
    e instanceof ProgramPrompt ||
    e instanceof ProgramSecret ||
    e instanceof ProgramLookup ||
    e instanceof ProgramSdkCall ||
    e instanceof ProgramCallApi ||
    e instanceof ProgramRawRequest ||
    e instanceof ProgramUploadObject ||
    e instanceof ProgramListCall ||
    e instanceof ProgramWaitUntil ||
    e instanceof ProgramRender ||
    e instanceof ProgramRenderData ||
    e instanceof ProgramEcho ||
    e instanceof ProgramSleep ||
    e instanceof ProgramUnsupported
  );
}

function matchesException(e: unknown, excType: string | string[]): boolean {
  if (Array.isArray(excType))
    return excType.some((t) => matchesException(e, t));
  if (excType === "Exception")
    return e instanceof ProgramRaise || e instanceof ProgramServiceError;
  if (excType === "ServiceError") return e instanceof ProgramServiceError;
  if (e instanceof ProgramRaise) {
    if (e.cls === excType) return true;
    if (excType === "ValueError" && e.cls === "JSONDecodeError") return true;
    if (
      excType === "OSError" &&
      (e.cls === "FileNotFoundError" ||
        e.cls === "FileExistsError" ||
        e.cls === "IsADirectoryError" ||
        e.cls === "PermissionError")
    )
      return true;
  }
  return false;
}

const CLICK_FG_COLORS: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  reset: 39,
  bright_black: 90,
  bright_red: 91,
  bright_green: 92,
  bright_yellow: 93,
  bright_blue: 94,
  bright_magenta: 95,
  bright_cyan: 96,
  bright_white: 97,
};

function clickColorCode(color: unknown, isBg: boolean): string {
  const offset = isBg ? 10 : 0;
  if (typeof color === "number" && Number.isInteger(color)) {
    return `\x1b[${38 + offset};5;${color}m`;
  }
  if (typeof color === "string") {
    const code = CLICK_FG_COLORS[color];
    if (code === undefined)
      throw new ProgramRaise("TypeError", `Unknown color ${pyRepr(color)}`);
    return `\x1b[${code + offset}m`;
  }
  if (
    Array.isArray(color) &&
    color.length === 3 &&
    color.every((c) => typeof c === "number" && Number.isInteger(c))
  ) {
    return `\x1b[${38 + offset};2;${color[0]};${color[1]};${color[2]}m`;
  }
  throw new ProgramUnsupported("click.style color");
}

function clickStyle(text: unknown, opts: Dict): string {
  const str = typeof text === "string" ? text : pyStr(text);
  const bits: string[] = [];
  if (opts.fg !== undefined && opts.fg !== null)
    bits.push(clickColorCode(opts.fg, false));
  if (opts.bg !== undefined && opts.bg !== null)
    bits.push(clickColorCode(opts.bg, true));
  const flags: [string, number, number][] = [
    ["bold", 1, 22],
    ["dim", 2, 22],
    ["underline", 4, 24],
    ["overline", 53, 55],
    ["italic", 3, 23],
    ["blink", 5, 25],
    ["reverse", 7, 27],
    ["strikethrough", 9, 29],
  ];
  for (const [key, on, off] of flags) {
    if (opts[key] !== undefined && opts[key] !== null) {
      bits.push(`\x1b[${pyTruthy(opts[key]) ? on : off}m`);
    }
  }
  bits.push(str);
  const reset = opts.reset === undefined ? true : pyTruthy(opts.reset);
  if (reset) bits.push("\x1b[0m");
  return bits.join("");
}

function pyInt(args: unknown[]): number {
  if (args.length === 0) return 0;
  const val = args[0];
  if (args.length === 1) {
    if (typeof val === "boolean") return val ? 1 : 0;
    if (typeof val === "number") {
      if (!Number.isFinite(val))
        throw new ProgramRaise("OverflowError", "cannot convert float to int");
      return Math.trunc(val);
    }
    if (typeof val === "string") {
      const cleaned = val.trim().replace(/_/g, "");
      if (!/^[+-]?\d+$/.test(cleaned)) {
        throw new ProgramRaise(
          "ValueError",
          `invalid literal for int() with base 10: ${pyRepr(val)}`,
        );
      }
      const n = Number.parseInt(cleaned, 10);
      if (!Number.isSafeInteger(n))
        throw new ProgramUnsupported("int() overflow");
      return n;
    }
    throw new ProgramRaise(
      "TypeError",
      "int() argument must be a string or a number",
    );
  }
  if (args.length === 2) {
    const base = args[1];
    if (typeof val !== "string")
      throw new ProgramRaise(
        "TypeError",
        "int() can't convert non-string with explicit base",
      );
    if (
      typeof base !== "number" ||
      !Number.isInteger(base) ||
      (base !== 0 && (base < 2 || base > 36))
    ) {
      throw new ProgramRaise(
        "ValueError",
        "int() base must be >= 2 and <= 36, or 0",
      );
    }
    let s = val.trim().replace(/_/g, "");
    let sign = 1;
    if (s.startsWith("+")) s = s.slice(1);
    else if (s.startsWith("-")) {
      sign = -1;
      s = s.slice(1);
    }
    let radix = base;
    if (radix === 0) {
      if (s.startsWith("0x") || s.startsWith("0X")) {
        radix = 16;
        s = s.slice(2);
      } else if (s.startsWith("0o") || s.startsWith("0O")) {
        radix = 8;
        s = s.slice(2);
      } else if (s.startsWith("0b") || s.startsWith("0B")) {
        radix = 2;
        s = s.slice(2);
      } else {
        radix = 10;
      }
    } else if (
      (radix === 16 && (s.startsWith("0x") || s.startsWith("0X"))) ||
      (radix === 8 && (s.startsWith("0o") || s.startsWith("0O"))) ||
      (radix === 2 && (s.startsWith("0b") || s.startsWith("0B")))
    ) {
      s = s.slice(2);
    }
    const validDigits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, radix);
    if (
      s.length === 0 ||
      ![...s.toLowerCase()].every((ch) => validDigits.includes(ch))
    ) {
      throw new ProgramRaise(
        "ValueError",
        `invalid literal for int() with base ${base}: ${pyRepr(val)}`,
      );
    }
    const n = sign * Number.parseInt(s, radix);
    if (!Number.isSafeInteger(n))
      throw new ProgramUnsupported("int() overflow");
    return n;
  }
  throw new ProgramUnsupported("int() args");
}

function pyFind(s: string, args: unknown[]): number {
  if (args.length < 1 || args.length > 3 || typeof args[0] !== "string")
    throw new ProgramUnsupported("str.find()");
  const sub = args[0];
  const len = s.length;
  const clamp = (raw: unknown, fallback: number): number => {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "number" || !Number.isInteger(raw))
      throw new ProgramUnsupported("str.find() index");
    const i = raw < 0 ? raw + len : raw;
    return Math.max(0, Math.min(len, i));
  };
  const start = clamp(args[1], 0);
  const end = clamp(args[2], len);
  if (end < start) return -1;
  const idx = s.slice(start, end).indexOf(sub);
  return idx < 0 ? -1 : start + idx;
}

/** Resolve attribute/index suffixes in a Python format field (e.g. `obj.attr`, `arr[0]`). */
function formatTraverse(base: unknown, path: string): unknown {
  let cur = base;
  let pos = 0;
  while (pos < path.length) {
    if (path[pos] === ".") {
      const m = /^\.([A-Za-z_]\w*)/.exec(path.slice(pos));
      if (!m) throw new ProgramUnsupported(`format path ${path}`);
      const attr = m[1]!;
      if (cur instanceof ProgramResponse) {
        if (attr === "data") cur = cur.data;
        else if (attr === "headers") cur = cur.headers;
        else if (attr === "status") cur = cur.status;
        else if (attr === "request_id") cur = cur.requestId;
        else if (attr === "next_page") cur = cur.nextPage;
        else if (attr === "has_next_page") cur = cur.hasNextPage;
        else throw new ProgramUnsupported(`format attr .${attr}`);
      } else if (cur instanceof ProgramServiceError) {
        if (attr === "status") cur = cur.status;
        else if (attr === "code") cur = cur.code;
        else if (attr === "message") cur = cur.serviceMessage;
        else if (attr === "headers") cur = cur.headers;
        else if (attr === "request_id") cur = cur.requestId;
        else throw new ProgramUnsupported(`format attr .${attr}`);
      } else if (cur instanceof ProgramModel) {
        cur = cur.getAttr(attr);
      } else if (isDict(cur)) {
        cur = modelAttr(cur, attr);
      } else {
        throw new ProgramUnsupported(`format attr .${attr}`);
      }
      pos += m[0].length;
    } else if (path[pos] === "[") {
      const close = path.indexOf("]", pos + 1);
      if (close === -1) throw new ProgramUnsupported(`format index ${path}`);
      const key = path.slice(pos + 1, close);
      if (Array.isArray(cur) && /^\d+$/.test(key)) {
        const idx = Number(key);
        if (idx >= cur.length) throw new ProgramUnsupported("IndexError");
        cur = cur[idx];
      } else if (cur instanceof ProgramHeaders) {
        if (!cur.has(key)) throw new ProgramRaise("KeyError", pyRepr(key));
        cur = cur.get(key);
      } else if (isDict(cur)) {
        if (!(key in cur)) throw new ProgramRaise("KeyError", pyRepr(key));
        cur = cur[key];
      } else {
        throw new ProgramUnsupported(`format index ${path}`);
      }
      pos = close + 1;
    } else {
      throw new ProgramUnsupported(`format field ${path}`);
    }
  }
  return cur;
}

function groupDigits(digits: string, sep: string, size: number): string {
  const out: string[] = [];
  for (let i = digits.length; i > 0; i -= size) {
    out.push(digits.slice(Math.max(0, i - size), i));
  }
  return out.reverse().join(sep);
}

function padFormatted(
  prefix: string,
  body: string,
  width: number,
  fill: string,
  align: string,
): string {
  const total = prefix.length + body.length;
  if (total >= width) return prefix + body;
  const pad = width - total;
  if (align === "<") return prefix + body + fill.repeat(pad);
  if (align === ">") return fill.repeat(pad) + prefix + body;
  if (align === "=") return prefix + fill.repeat(pad) + body;
  // Center (`^`): Python puts the extra fill char on the right when odd.
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return fill.repeat(left) + prefix + body + fill.repeat(right);
}

/** Python format specification mini-language for f-strings and `str.format`. */
function pyFormatValue(
  rawVal: unknown,
  conversion: string | null | undefined,
  spec: string | null | undefined,
): string {
  let val = rawVal;
  if (conversion === "s") val = pyStr(val);
  else if (conversion === "r" || conversion === "a") val = pyElemRepr(val);
  const s = spec ?? "";
  if (s === "") return typeof val === "string" ? val : pyStr(val);

  const m =
    /^(?:(.)?([<>=^]))?([+\- ])?(z)?(#)?(0)?(\d+)?([_,])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(
      s,
    );
  if (!m) throw new ProgramUnsupported(`format spec ${s}`);
  const [
    ,
    rawFill,
    rawAlign,
    sign,
    ,
    alt,
    zero,
    rawWidth,
    grouping,
    rawPrec,
    typeChar,
  ] = m;
  const width = rawWidth ? Number.parseInt(rawWidth, 10) : 0;
  const prec = rawPrec !== undefined ? Number.parseInt(rawPrec, 10) : undefined;

  const isNum = typeof val === "number" || typeof val === "boolean";
  const effectiveType =
    typeChar ?? (typeof val === "string" ? "s" : isNum ? "" : "s");

  if (effectiveType === "s") {
    if (sign || alt || zero || grouping)
      throw new ProgramRaise(
        "ValueError",
        `Invalid format specifier '${s}' for object of type 'str'`,
      );
    let text = typeof val === "string" ? val : pyStr(val);
    if (prec !== undefined) text = text.slice(0, prec);
    const fill = rawFill ?? " ";
    const align = rawAlign ?? "<";
    if (align === "=")
      throw new ProgramRaise(
        "ValueError",
        "'=' alignment not allowed in string format specifier",
      );
    return padFormatted("", text, width, fill, align);
  }

  if (!isNum) {
    throw new ProgramRaise(
      "ValueError",
      `Unknown format code '${effectiveType}' for object`,
    );
  }
  const num = typeof val === "boolean" ? (val ? 1 : 0) : (val as number);
  const fill = rawFill ?? (zero ? "0" : " ");
  const align = rawAlign ?? (zero ? "=" : ">");

  const signStr =
    num < 0 || Object.is(num, -0)
      ? "-"
      : sign === "+"
        ? "+"
        : sign === " "
          ? " "
          : "";
  const abs = Math.abs(num);

  if (
    effectiveType === "d" ||
    effectiveType === "b" ||
    effectiveType === "o" ||
    effectiveType === "x" ||
    effectiveType === "X" ||
    effectiveType === "c" ||
    (effectiveType === "" && Number.isInteger(num) && prec === undefined)
  ) {
    if (effectiveType === "c") {
      return padFormatted(
        "",
        String.fromCodePoint(Math.trunc(num)),
        width,
        fill,
        align,
      );
    }
    if (!Number.isInteger(num)) {
      throw new ProgramRaise(
        "ValueError",
        `Unknown format code '${effectiveType}' for object of type 'float'`,
      );
    }
    const radix =
      effectiveType === "b"
        ? 2
        : effectiveType === "o"
          ? 8
          : effectiveType === "x" || effectiveType === "X"
            ? 16
            : 10;
    let digits = abs.toString(radix);
    if (effectiveType === "X") digits = digits.toUpperCase();
    if (grouping) {
      const gSize = radix === 10 ? 3 : 4;
      digits = groupDigits(digits, grouping, gSize);
    }
    const altPrefix = alt
      ? effectiveType === "b"
        ? "0b"
        : effectiveType === "o"
          ? "0o"
          : effectiveType === "x"
            ? "0x"
            : effectiveType === "X"
              ? "0X"
              : ""
      : "";
    return padFormatted(signStr + altPrefix, digits, width, fill, align);
  }

  // Float formatting: f, F, e, E, g, G, %, or default float
  let body: string;
  if (effectiveType === "f" || effectiveType === "F") {
    const p = prec ?? 6;
    body = abs.toFixed(p);
    if (alt && p === 0) body += ".";
  } else if (effectiveType === "%") {
    const p = prec ?? 6;
    body = `${(abs * 100).toFixed(p)}%`;
  } else if (effectiveType === "e" || effectiveType === "E") {
    const p = prec ?? 6;
    body = abs.toExponential(p).replace(/e([+-])(\d)$/, "e$10$2");
    if (effectiveType === "E") body = body.toUpperCase();
  } else if (
    effectiveType === "g" ||
    effectiveType === "G" ||
    effectiveType === ""
  ) {
    const p = Math.max(1, prec ?? 6);
    body =
      effectiveType === "" && prec === undefined
        ? String(abs)
        : Number(abs.toPrecision(p)).toString();
    if (effectiveType === "G") body = body.toUpperCase();
  } else {
    throw new ProgramUnsupported(`format type ${effectiveType}`);
  }
  if (grouping) {
    const dot = body.indexOf(".");
    const intPart = dot >= 0 ? body.slice(0, dot) : body;
    const restPart = dot >= 0 ? body.slice(dot) : "";
    body = groupDigits(intPart, grouping, 3) + restPart;
  }
  return padFormatted(signStr, body, width, fill, align);
}

/** Python `%` string formatting (`"%3.1f %s" % (num, x)`). */
function pyPercentFormat(template: string, rhs: unknown): string {
  const args = Array.isArray(rhs) ? rhs : [rhs];
  let idx = 0;
  return template.replace(
    /%%|%([#0\- +]*)(\d+)?(?:\.(\d+))?([diouxXeEfFgGcrsa])/g,
    (m, flags = "", width = "", prec = "", conv) => {
      if (m === "%%") return "%";
      if (idx >= args.length)
        throw new ProgramRaise(
          "TypeError",
          "not enough arguments for format string",
        );
      const val = args[idx++];
      const align = flags.includes("-") ? "<" : "";
      const sign = flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
      const alt = flags.includes("#") ? "#" : "";
      const zero = flags.includes("0") && !align ? "0" : "";
      const dotPrec = prec !== "" ? `.${prec}` : "";
      if (conv === "r")
        return pyFormatValue(val, "r", `${align}${width}${dotPrec}s`);
      if (conv === "a")
        return pyFormatValue(val, "a", `${align}${width}${dotPrec}s`);
      const mapped = conv === "i" || conv === "u" ? "d" : conv;
      return pyFormatValue(
        val,
        null,
        `${align}${sign}${alt}${zero}${width}${dotPrec}${mapped}`,
      );
    },
  );
}

/** Python `round(number[, ndigits])` with round-half-to-even (banker's rounding). */
function pyRound(args: unknown[]): number {
  if (args.length < 1 || args.length > 2)
    throw new ProgramUnsupported("round() args");
  const raw = args[0];
  if (typeof raw !== "number" && typeof raw !== "boolean")
    throw new ProgramRaise("TypeError", "type doesn't define __round__ method");
  const x = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
  const roundHalfEven = (n: number): number => {
    const f = Math.floor(n);
    const d = n - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  };
  if (args.length === 1 || args[1] === null || args[1] === undefined) {
    return roundHalfEven(x);
  }
  const ndigits = args[1];
  if (typeof ndigits !== "number" || !Number.isInteger(ndigits))
    throw new ProgramRaise("TypeError", "'ndigits' must be an integer");
  const factor = 10 ** ndigits;
  return roundHalfEven(x * factor) / factor;
}

/** Python `range(stop)` / `range(start, stop[, step])`. */
function pyRange(args: unknown[]): number[] {
  if (args.length < 1 || args.length > 3)
    throw new ProgramUnsupported("range() args");
  const toInt = (v: unknown): number => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" && Number.isInteger(v)) return v;
    throw new ProgramRaise(
      "TypeError",
      "'range' object requires integer arguments",
    );
  };
  let start = 0;
  let stop: number;
  let step = 1;
  if (args.length === 1) {
    stop = toInt(args[0]);
  } else if (args.length === 2) {
    start = toInt(args[0]);
    stop = toInt(args[1]);
  } else {
    start = toInt(args[0]);
    stop = toInt(args[1]);
    step = toInt(args[2]);
  }
  if (step === 0)
    throw new ProgramRaise("ValueError", "range() arg 3 must not be zero");
  const count =
    step > 0
      ? Math.max(0, Math.ceil((stop - start) / step))
      : Math.max(0, Math.ceil((start - stop) / -step));
  if (count > 1_000_000) throw new ProgramUnsupported("range() too large");
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + i * step);
  return out;
}

/** Python `posixpath.dirname(p)`. */
function pyDirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  let head = p.slice(0, i);
  if (head && head !== "/".repeat(head.length)) {
    head = head.replace(/\/+$/, "");
  }
  return head;
}

/** Python `json.dumps` with `indent`, `sort_keys`, `separators`, and `ensure_ascii`. */
function pyDumpsOpts(
  val: unknown,
  indent: unknown,
  sortKeysFlag: unknown,
  separators: unknown,
  ensureAscii: unknown,
): string {
  const prepared = pyTruthy(sortKeysFlag) ? sortKeys(val) : val;
  const hasIndent = indent !== null && indent !== undefined;
  const indentStr =
    typeof indent === "number"
      ? " ".repeat(Math.max(0, Math.trunc(indent)))
      : typeof indent === "string"
        ? indent
        : "";
  let itemSep = hasIndent ? "," : ", ";
  let keySep = ": ";
  if (Array.isArray(separators) && separators.length === 2) {
    itemSep = String(separators[0]);
    keySep = String(separators[1]);
  }
  const escapeAscii = ensureAscii === undefined ? true : pyTruthy(ensureAscii);
  const encodeStr = (s: string): string => {
    const raw = JSON.stringify(s);
    if (!escapeAscii) return raw;
    return raw.replace(/[^\x00-\x7f]/g, (ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, "0")}`;
      const off = cp - 0x10000;
      return `\\u${(0xd800 + (off >> 10)).toString(16)}\\u${(0xdc00 + (off & 0x3ff)).toString(16)}`;
    });
  };
  const render = (v: unknown, depth: number): string => {
    if (v instanceof ProgramModel) return render(v.toWireDict(), depth);
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "string") return encodeStr(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (!hasIndent)
        return `[${v.map((x) => render(x, depth + 1)).join(itemSep)}]`;
      const pad = indentStr.repeat(depth + 1);
      const closePad = indentStr.repeat(depth);
      return `[\n${v.map((x) => `${pad}${render(x, depth + 1)}`).join(`${itemSep}\n`)}\n${closePad}]`;
    }
    if (isDict(v)) {
      const entries = Object.entries(v);
      if (entries.length === 0) return "{}";
      if (!hasIndent) {
        return `{${entries.map(([k, x]) => `${encodeStr(k)}${keySep}${render(x, depth + 1)}`).join(itemSep)}}`;
      }
      const pad = indentStr.repeat(depth + 1);
      const closePad = indentStr.repeat(depth);
      return `{\n${entries.map(([k, x]) => `${pad}${encodeStr(k)}${keySep}${render(x, depth + 1)}`).join(`${itemSep}\n`)}\n${closePad}}`;
    }
    throw new ProgramUnsupported("json.dumps() value");
  };
  return render(prepared, 0);
}

/** Python `str.format` with positional/keyword fields, conversions, and format specs. */
function pyFormat(
  template: string,
  args: unknown[],
  kwargs: Dict = {},
): string {
  let next = 0;
  let mode: "auto" | "manual" | null = null;
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}|[{}]/g, (m, field) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (field === undefined) throw new ProgramUnsupported(`format field ${m}`);
    const parsed = /^([^!:]*)(?:!([rsa]))?(?::(.*))?$/.exec(field);
    if (!parsed) throw new ProgramUnsupported(`format field ${m}`);
    const [, fieldExpr = "", conversion, spec] = parsed;
    let val: unknown;
    const headMatch = /^([^.[]*)(.*)$/.exec(fieldExpr);
    if (!headMatch) throw new ProgramUnsupported(`format field ${m}`);
    const [, head = "", tail = ""] = headMatch;
    if (head === "") {
      if (mode === "manual") throw new ProgramUnsupported("format numbering");
      mode = "auto";
      const i = next++;
      if (i >= args.length) throw new ProgramUnsupported("IndexError");
      val = args[i];
    } else if (/^\d+$/.test(head)) {
      if (mode === "auto") throw new ProgramUnsupported("format numbering");
      mode = "manual";
      const i = Number(head);
      if (i >= args.length) throw new ProgramUnsupported("IndexError");
      val = args[i];
    } else if (/^[A-Za-z_]\w*$/.test(head)) {
      if (!(head in kwargs)) throw new ProgramRaise("KeyError", pyRepr(head));
      val = kwargs[head];
    } else {
      throw new ProgramUnsupported(`format field ${m}`);
    }
    if (tail) val = formatTraverse(val, tail);
    return pyFormatValue(val, conversion, spec);
  });
}

/**
 * data_flow's converters (dataflow_cli_extended.py) from the plain-text forms of
 * `--arguments` / `--parameters` / `--configuration` to JSON: tokens split by spaces
 * (and `=`), quoted substrings kept whole, as `re.split` with one capturing group does.
 * Bad input raises `Exception(message)`.
 */
const DATAFLOW_PARAMETERS_ERROR =
  'Incorrect \'parameters\' value, cannot proceed. Parameters should be either in a plain text format of \'param_name_1=value_1 param_name_2=value_2 ...\' or a json format of \'[ { "name": "param_name_1", "value": "value_1"}, { "name": "param_name_2", "value": "value_2"}, ...]\'';
const DATAFLOW_CONFIGURATION_ERROR =
  'Incorrect \'configuration\' value, cannot proceed. Configuration should be either in a plain text format of \'param_name_1=value_1 param_name_2=value_2 ...\' or a json format of \'{ "param_name_1": "value_1", "param_name_2": "value_2", }, ...\'';

/** Python `str.strip()`: ASCII and Unicode whitespace (not U+FEFF, which JS trims). */
const pyStrip = (s: string): string =>
  s.replace(/^[^\S\uFEFF]+|[^\S\uFEFF]+$/g, "");

function dataflowTokens(s: string, equals: boolean): string[] {
  // A capturing group: the separators (quoted substrings among them) stay in.
  const split = s.split(equals ? /( |=|".*?"|'.*?')/ : /( |".*?"|'.*?')/);
  return split.filter((t) => pyStrip(t) !== "");
}

const unquote = (t: string): string =>
  stripChars(stripChars(t, "'", true), '"', true);

function dataflowPairs(
  s: string,
  message: string,
  strip: boolean,
): [string, string][] {
  const args = dataflowTokens(s, true).map((t) =>
    unquote(strip ? pyStrip(t) : t),
  );
  if (args.length % 3 !== 0) throw new ProgramRaise("Exception", message);
  const pairs: [string, string][] = [];
  for (let i = 0; i < args.length; i += 3) {
    if (args[i + 1] !== "=") throw new ProgramRaise("Exception", message);
    pairs.push([args[i] as string, args[i + 2] as string]);
  }
  return pairs;
}

const HAND_CODED: Record<string, (s: string) => unknown> = {
  dataflowArguments: (s) => dataflowTokens(s, false).map(unquote),
  dataflowParameters: (s) =>
    // Only the parameters converter strips whitespace before the quotes.
    dataflowPairs(s, DATAFLOW_PARAMETERS_ERROR, true).map(([name, value]) => ({
      name,
      value,
    })),
  dataflowConfiguration: (s) =>
    Object.fromEntries(dataflowPairs(s, DATAFLOW_CONFIGURATION_ERROR, false)),
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Python's `base64.b64decode(s)` (binascii.a2b_base64, not strict): characters outside
 * the alphabet are skipped, a complete pad ends the input; errors raise like CPython.
 */
export function pyB64decode(s: string): Uint8Array {
  if (/[^\x00-\x7f]/.test(s))
    throw new ProgramRaise(
      "ValueError",
      "string argument should contain only ASCII characters",
    );
  const out: number[] = [];
  let quad = 0;
  let left = 0;
  let pads = 0;
  for (const ch of s) {
    if (ch === "=") {
      if (quad >= 2 && quad + ++pads >= 4) return Uint8Array.from(out);
      continue;
    }
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    pads = 0;
    if (quad === 0) left = v;
    else if (quad === 1) {
      out.push(((left << 2) | (v >> 4)) & 0xff);
      left = v & 0x0f;
    } else if (quad === 2) {
      out.push(((left << 4) | (v >> 2)) & 0xff);
      left = v & 0x03;
    } else out.push(((left << 6) | v) & 0xff);
    quad = (quad + 1) % 4;
  }
  if (quad === 1)
    throw new ProgramRaise(
      "Error",
      `Invalid base64-encoded string: number of data characters (${Math.floor(out.length / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`,
    );
  if (quad !== 0) throw new ProgramRaise("Error", "Incorrect padding");
  return Uint8Array.from(out);
}

/**
 * objectstorage_cli_extended's `_get_sse_customer_key_details` / `_get_sse_params`: the
 * key file's stripped base64 text and the base64 SHA-256 of the key it decodes to.
 */
function sseKey(file: unknown): { key: string; sha256: string } | null {
  if (file === null || file === undefined) return null;
  if (!(file instanceof ProgramFile))
    throw new ProgramUnsupported("SSE key from a non-file");
  const key = pyStrip(String(file.read()));
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(pyB64decode(key))
    .digest("base64");
  return { key, sha256 };
}

const SSE_ALGORITHM = "AES256";

function sseParams(file: unknown, prefix: string): Dict | null {
  const k = sseKey(file);
  return (
    k && {
      [`${prefix}_algorithm`]: SSE_ALGORITHM,
      [`${prefix}_key`]: k.key,
      [`${prefix}_key_sha256`]: k.sha256,
    }
  );
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isDict(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

export type ProgramResult = {
  /** The generated command's kwargs, unset ones absent; undefined when not invoked. */
  kwargs?: Dict;
  /** Every keyword the wrapper passed, None-valued ones included. */
  names?: string[];
  /** Which generated command it invoked: 0 is the first, i is `variants[i - 1]`. */
  target?: number;
};

/**
 * The filesystem a program's `open(path, mode)`, `os.path.exists(path)` and
 * `os.path.isfile(path)` see. `open` raises an OSError it models as a ProgramRaise.
 */
export type ProgramFiles = {
  open(path: string, mode: string): ProgramFile;
  exists(path: string): boolean;
  isfile(path: string): boolean;
  abspath?(path: string): string;
  isZipfile?(path: string): boolean;
  deleteFnEndpointCache?(ctxObj: Dict, functionId: string): void;
};

const NO_FILES: ProgramFiles = {
  open() {
    throw new ProgramUnsupported("open()");
  },
  exists() {
    throw new ProgramUnsupported("os.path.exists()");
  },
  isfile() {
    throw new ProgramUnsupported("os.path.isfile()");
  },
};

/**
 * Runs `program` over the wrapper's converted option values (complex params already
 * parsed). `parse` is cli_util.parse_json_parameter.
 */
export function runProgram(
  program: Statement[],
  values: Dict,
  params: TypedParam[],
  parse: (name: string, value: unknown, camelize?: boolean) => unknown,
  answers: ProgramAnswer[] = [],
  files: ProgramFiles = NO_FILES,
  context: ProgramContext = {},
): ProgramResult {
  // Click hands the callback every exposed param, unset ones at their default.
  const kwargs: Dict = {};
  const filled = new Map<string, unknown>();
  for (const p of params) {
    if ((p as { expose?: boolean }).expose === false) continue;
    const given = kwarg(p.name, values, params);
    const v = given instanceof ProgramFile ? given.reopen() : given;
    if (p.multiple && Array.isArray(v)) pyTuples.add(v);
    kwargs[p.name] = v;
    if (values[p.name] === undefined) filled.set(p.name, v);
  }
  const env: Dict = { kwargs };
  let invoked: Dict | undefined;
  let target = 0;
  let asked = 0;
  let sdkCalled = 0;
  let rawCalled = 0;
  let uploadCalled = 0;
  let listCalled = 0;
  let waitCalled = 0;
  let renderCalled = 0;
  let echoCalled = 0;
  let sleepCalled = 0;
  let randomCalled = 0;
  let timeCalled = 0;
  let nextFd = 100;
  const fdToFile = new Map<number, ProgramFile>();
  const caught: Error[] = [];
  const ctxObj = new ProgramObject("ctx.obj", {
    request_id: context.requestId ?? null,
    endpoint: context.endpoint ?? null,
    config_file: context.configFile ?? null,
    profile: context.profile ?? null,
    auth: context.auth ?? null,
    enable_dual_stack: context.enableDualStack ?? false,
    query: context.query ?? null,
    output: context.output ?? "json",
    debug: context.debug ?? false,
    no_retry: context.noRetry ?? false,
    max_attempts: context.maxAttempts ?? null,
    default_values_from_file: context.defaultValuesFromFile ?? {},
    ...(context.regionOverride !== undefined && context.regionOverride !== null
      ? { region: context.regionOverride }
      : {}),
  });

  const item = (obj: unknown, key: unknown): unknown => {
    if (obj instanceof ProgramHeaders && typeof key === "string") {
      if (obj.has(key)) return obj.get(key);
      throw new ProgramRaise("KeyError", pyRepr(key));
    }
    if (obj instanceof ProgramObject && typeof key === "string") {
      if (key in obj.fields) return obj.fields[key];
      if (obj === ctxObj && key === "config")
        throw new ProgramRaise("KeyError", pyRepr(key));
      throw new ProgramUnsupported(`${obj.kind}[${key}]`);
    }
    if (isDict(obj) && typeof key === "string") {
      if (!(key in obj)) throw new ProgramUnsupported(`KeyError: ${key}`);
      return obj[key];
    }
    if (
      (Array.isArray(obj) || typeof obj === "string") &&
      typeof key === "number"
    ) {
      const i = key < 0 ? obj.length + key : key;
      if (i < 0 || i >= obj.length) throw new ProgramUnsupported("IndexError");
      return obj[i];
    }
    throw new ProgramUnsupported("subscript");
  };

  const call = (method: string, obj: unknown, args: unknown[]): unknown => {
    if (obj instanceof ProgramHeaders) {
      const key = args[0] as string;
      switch (method) {
        case "get":
          return typeof key === "string" && obj.has(key)
            ? obj.get(key)
            : (args[1] ?? null);
        case "keys":
          if (args.length === 0) return obj.keys();
          break;
        case "items":
          if (args.length === 0) return obj.entries();
          break;
      }
    } else if (obj instanceof ProgramObject) {
      if (obj.kind === "http.raw" && method === "rawStream") {
        const resp = obj.fields._response;
        if (resp instanceof ProgramHttpResponse) {
          const size = typeof args[0] === "number" ? args[0] : 65536;
          return resp.iterContent(size);
        }
      }
      const key = args[0] as string;
      switch (method) {
        case "get":
          return typeof key === "string" && key in obj.fields
            ? obj.fields[key]
            : (args[1] ?? null);
        case "keys":
          if (args.length === 0) return Object.keys(obj.fields);
          break;
        case "items":
          if (args.length === 0) return Object.entries(obj.fields);
          break;
      }
    } else if (isDict(obj)) {
      const key = args[0] as string;
      switch (method) {
        case "get":
          return key in obj ? obj[key] : (args[1] ?? null);
        case "pop":
          if (key in obj) {
            const v = obj[key];
            delete obj[key];
            markMutated(obj);
            return v;
          }
          if (args.length > 1) return args[1];
          throw new ProgramUnsupported(`KeyError: ${key}`);
        case "setdefault":
          if (!(key in obj)) {
            obj[key] = args[1] ?? null;
            markMutated(obj);
          }
          return obj[key];
        case "update":
          if (!isDict(args[0])) throw new ProgramUnsupported("update");
          Object.assign(obj, args[0]);
          markMutated(obj);
          return null;
        case "keys":
          if (args.length === 0) return Object.keys(obj);
          break;
        case "items":
          if (args.length === 0) return Object.entries(obj);
          break;
      }
    } else if (Array.isArray(obj)) {
      switch (method) {
        case "append":
          obj.push(args[0]);
          markMutated(obj);
          return null;
        case "pop": {
          if (args.length > 1) break;
          if (obj.length === 0)
            throw new ProgramRaise("IndexError", "pop from empty list");
          const rawIdx = args.length === 0 ? obj.length - 1 : args[0];
          if (typeof rawIdx !== "number" || !Number.isInteger(rawIdx))
            throw new ProgramUnsupported("list.pop() index");
          let idx = rawIdx < 0 ? rawIdx + obj.length : rawIdx;
          if (idx < 0 || idx >= obj.length)
            throw new ProgramRaise("IndexError", "pop index out of range");
          const [removed] = obj.splice(idx, 1);
          markMutated(obj);
          return removed;
        }
        case "insert": {
          if (args.length !== 2) break;
          const rawIdx = args[0];
          if (typeof rawIdx !== "number" || !Number.isInteger(rawIdx))
            throw new ProgramUnsupported("list.insert() index");
          const idx =
            rawIdx < 0
              ? Math.max(0, obj.length + rawIdx)
              : Math.min(rawIdx, obj.length);
          obj.splice(idx, 0, args[1]);
          markMutated(obj);
          return null;
        }
        case "extend": {
          if (args.length !== 1) break;
          obj.push(...iterate(args[0]));
          markMutated(obj);
          return null;
        }
      }
    } else if (typeof obj === "string") {
      switch (method) {
        case "upper":
          return obj.toUpperCase();
        case "lower":
          return obj.toLowerCase();
        case "strip":
          if (args.length === 0) return obj.trim();
          if (typeof args[0] === "string")
            return stripChars(obj, args[0], true);
          break;
        case "rstrip":
          if (args.length === 0) return obj.trimEnd();
          if (typeof args[0] === "string")
            return stripChars(obj, args[0], false);
          break;
        case "join":
          if (
            Array.isArray(args[0]) &&
            args[0].every((x) => typeof x === "string")
          )
            return args[0].join(obj);
          break;
        case "format":
          return pyFormat(obj, args);
        case "split":
          if (typeof args[0] === "string" && args[0] !== "")
            return obj.split(args[0]);
          if (args.length === 0) return obj.split(/\s+/).filter(Boolean);
          break;
        case "splitlines": {
          const keepends = args.length >= 1 ? pyTruthy(args[0]) : false;
          if (obj === "") return [];
          if (keepends) {
            return obj.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
          }
          const parts = obj.split(/\r\n|\r|\n/);
          if (/\r\n$|\r$|\n$/.test(obj)) parts.pop();
          return parts;
        }
        case "ljust": {
          if (args.length < 1 || args.length > 2) break;
          const width = args[0];
          const fill = args.length === 2 ? args[1] : " ";
          if (
            typeof width !== "number" ||
            !Number.isInteger(width) ||
            typeof fill !== "string" ||
            [...fill].length !== 1
          ) {
            throw new ProgramRaise("TypeError", "ljust() invalid arguments");
          }
          return obj.length >= width
            ? obj
            : obj + fill.repeat(width - obj.length);
        }
        case "startswith": {
          const target = args[0];
          if (typeof target === "string") return obj.startsWith(target);
          if (
            Array.isArray(target) &&
            target.every((x) => typeof x === "string")
          )
            return target.some((x) => obj.startsWith(x));
          break;
        }
        case "endswith": {
          const target = args[0];
          if (typeof target === "string") return obj.endsWith(target);
          if (
            Array.isArray(target) &&
            target.every((x) => typeof x === "string")
          )
            return target.some((x) => obj.endsWith(x));
          break;
        }
        case "replace": {
          if (
            (args.length === 2 || args.length === 3) &&
            typeof args[0] === "string" &&
            typeof args[1] === "string"
          ) {
            if (args.length === 2 || Number(args[2]) < 0)
              return obj.replaceAll(args[0], args[1]);
            const count = Number(args[2]);
            if (!Number.isInteger(count)) break;
            if (count === 0) return obj;
            let out = obj;
            let pos = 0;
            for (let i = 0; i < count; i++) {
              const idx = out.indexOf(args[0], pos);
              if (idx < 0) break;
              out =
                out.slice(0, idx) + args[1] + out.slice(idx + args[0].length);
              pos = idx + args[1].length + (args[0].length === 0 ? 1 : 0);
            }
            return out;
          }
          break;
        }
        case "find":
          return pyFind(obj, args);
      }
    } else if (obj instanceof ProgramFile) {
      if (method === "read" && args.length === 0) return obj.read();
      if (method === "readline" && args.length === 0) return obj.readline();
      if (method === "fileno" && args.length === 0) {
        const fd = obj.getFd(() => nextFd++);
        fdToFile.set(fd, obj);
        return fd;
      }
      if (method === "write" && args.length === 1) return obj.write(args[0]);
      if (method === "close" && args.length === 0) {
        obj.close();
        return null;
      }
    } else if (obj instanceof ProgramMatch) {
      if (method === "group") {
        if (args.length === 0) return obj.group(0);
        if (args.length === 1 && typeof args[0] === "number")
          return obj.group(args[0]);
        if (args.every((x) => typeof x === "number"))
          return args.map((x) => obj.group(x as number));
      }
    } else if (obj instanceof ProgramHttpResponse) {
      if (method === "json" && args.length === 0) return obj.json();
      if (method === "raise_for_status" && args.length === 0) {
        obj.raiseForStatus();
        return null;
      }
      if (method === "iter_content" && args.length <= 1) {
        const size = typeof args[0] === "number" ? args[0] : 1;
        return obj.iterContent(size);
      }
    } else if (obj instanceof ProgramProgressBar) {
      if (method === "update") {
        // Click's non-TTY progressbar prints label once on first update/finish.
        if (!obj.printed && obj.label) {
          obj.printed = true;
          const i = echoCalled++;
          if (i >= (context.echoCount ?? 0)) {
            throw new ProgramEcho(`${obj.label}\n`, obj.toStderr);
          }
        }
        return null;
      }
      if (method === "render_finish" && args.length === 0) {
        if (!obj.printed && obj.label) {
          obj.printed = true;
          const i = echoCalled++;
          if (i >= (context.echoCount ?? 0)) {
            throw new ProgramEcho(`${obj.label}\n`, obj.toStderr);
          }
        }
        return null;
      }
    } else if (obj instanceof ProgramJmespath) {
      if (method === "search" && args.length === 1) {
        return applyQuery(args[0], obj.expression);
      }
    } else if (obj instanceof Uint8Array && method === "decode") {
      if (args.length === 0 || /^utf-?8$/i.test(String(args[0])))
        try {
          return decodePythonUtf8(obj);
        } catch {
          throw new ProgramUnsupported("UnicodeDecodeError");
        }
    }
    throw new ProgramUnsupported(`${method}()`);
  };

  const compare = (op: string, a: unknown, b: unknown): boolean => {
    switch (op) {
      case "==":
        return pyEq(a, b);
      case "!=":
        return !pyEq(a, b);
      case "is":
        return a === b;
      case "isnot":
        return a !== b;
      case "in":
      case "notin": {
        let found: boolean;
        if (b instanceof ProgramHeaders)
          found = typeof a === "string" && b.has(a);
        else if (b instanceof ProgramObject)
          found = typeof a === "string" && a in b.fields;
        else if (isDict(b)) found = typeof a === "string" && a in b;
        else if (Array.isArray(b)) found = b.some((x) => pyEq(x, a));
        else if (typeof b === "string" && typeof a === "string")
          found = b.includes(a);
        else if (b === null || b === undefined)
          throw new ProgramRaise(
            "TypeError",
            "argument of type 'NoneType' is not iterable",
          );
        else throw new ProgramUnsupported("in");
        return op === "in" ? found : !found;
      }
    }
    if (
      (typeof a === "number" && typeof b === "number") ||
      (typeof a === "string" && typeof b === "string")
    ) {
      if (op === "<") return a < b;
      if (op === "<=") return a <= b;
      if (op === ">") return a > b;
      if (op === ">=") return a >= b;
    }
    throw new ProgramUnsupported(`compare ${op}`);
  };

  const fn = (name: string, args: unknown[]): unknown => {
    const [a, b] = args;
    switch (name) {
      case "dumps":
        // A string, like json.dumps: the generated command parses it back.
        return JSON.stringify(a);
      case "dumpsSorted":
        return JSON.stringify(sortKeys(a));
      case "dumpsOpts":
        return pyDumpsOpts(a, b, args[2], args[3], args[4]);
      case "loads": {
        let text: string;
        if (typeof a === "string") text = a;
        else if (a instanceof Uint8Array) {
          try {
            text = decodePythonUtf8(a);
          } catch {
            throw new ProgramRaise("UnicodeDecodeError", "invalid utf-8");
          }
        } else {
          throw new ProgramRaise(
            "TypeError",
            "the JSON object must be str, bytes or bytearray",
          );
        }
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new ProgramRaise(
            "JSONDecodeError",
            err instanceof Error ? err.message : "Invalid JSON",
          );
        }
      }
      case "load": {
        if (!(a instanceof ProgramFile))
          throw new ProgramUnsupported("json.load() on non-file");
        return fn("loads", [a.read()]);
      }
      case "parse": {
        // cli_util.parse_json_parameter(name, value, default=None, camelize_keys=True)
        const defaultVal = args.length >= 3 ? args[2] : null;
        const camelize = args.length >= 4 ? pyTruthy(args[3]) : true;
        if (b === null || b === undefined) return defaultVal;
        return parse(String(a), b, camelize);
      }
      case "requestId":
        return pyTruthy(a)
          ? String(a)
          : randomUUID().replaceAll("-", "").toUpperCase();
      case "str":
        return pyStr(a);
      case "int":
        return pyInt(args);
      case "range":
        return pyRange(args);
      case "round":
        return pyRound(args);
      case "sorted": {
        const items = [...iterate(a)];
        const keyFnName = typeof b === "string" ? b : null;
        const keyLambda = b instanceof ProgramLambda ? b : null;
        const reverse = pyTruthy(args[2] ?? false);
        const keyed = items.map((item, idx) => ({
          item,
          idx,
          key: keyLambda
            ? evalLambda(keyLambda, [item])
            : keyFnName
              ? fn(keyFnName, [item])
              : item,
        }));
        keyed.sort((x, y) => {
          if (pyEq(x.key, y.key)) return x.idx - y.idx;
          const lt = compare("<", x.key, y.key);
          return reverse ? (lt ? 1 : -1) : lt ? -1 : 1;
        });
        return keyed.map((k) => k.item);
      }
      case "time": {
        const i = timeCalled++;
        if (context.timestamps && i < context.timestamps.length) {
          return context.timestamps[i];
        }
        const now = Date.now() / 1000;
        context.timestamps?.push(now);
        return now;
      }
      case "fstat": {
        if (typeof a !== "number" || !Number.isInteger(a))
          throw new ProgramRaise("TypeError", "fstat() fd must be an int");
        const f = fdToFile.get(a);
        if (!f)
          throw new ProgramRaise("OSError", "[Errno 9] Bad file descriptor");
        return new ProgramStatResult(f.size);
      }
      case "bytesFromHex": {
        if (typeof a !== "string")
          throw new ProgramRaise("TypeError", "fromhex() argument must be str");
        const cleaned = a.replace(/[ \t\r\n\f\v]+/g, "");
        if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(cleaned)) {
          throw new ProgramRaise(
            "ValueError",
            "non-hexadecimal number found in fromhex() arg",
          );
        }
        const out = new Uint8Array(cleaned.length / 2);
        for (let i = 0; i < out.length; i++) {
          out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
      }
      case "reMatch": {
        if (typeof a !== "string" || typeof b !== "string")
          throw new ProgramRaise("TypeError", "re.match() expects strings");
        const anchored = a.startsWith("^") ? a : `^(?:${a})`;
        const m = new RegExp(anchored).exec(b);
        return m ? new ProgramMatch([...m]) : null;
      }
      case "prettyPrintFormat":
        return pyDumpsOpts(a, 2, true, null, false);
      case "loadFileContents": {
        if (typeof a !== "string") return null;
        if (!context.loadFileContents)
          throw new ProgramUnsupported("cli_util.load_file_contents()");
        return context.loadFileContents(a);
      }
      case "createConfigAndSigner": {
        if (!pyTruthy(ctxObj.fields.request_id)) {
          ctxObj.fields.request_id = randomUUID()
            .replaceAll("-", "")
            .toUpperCase();
        }
        const cfg = context.createConfigAndSigner
          ? context.createConfigAndSigner(ctxObj.fields)
          : context.buildConfig
            ? context.buildConfig(ctxObj.fields)
            : {};
        return new ProgramObject("ConfigAndSigner", {
          config: cfg,
          signer: null,
          uses_instance_principals_auth:
            ctxObj.fields.auth === "instance_principal",
        });
      }
      case "rawSession": {
        if (!pyTruthy(ctxObj.fields.request_id)) {
          ctxObj.fields.request_id = randomUUID()
            .replaceAll("-", "")
            .toUpperCase();
        }
        if (context.createConfigAndSigner) {
          context.createConfigAndSigner(ctxObj.fields);
        }
        return new ProgramRequestsSession(
          typeof ctxObj.fields.request_id === "string"
            ? ctxObj.fields.request_id
            : null,
        );
      }
      case "retryStrategy":
        return new ProgramRetryStrategy(a === "none" ? "none" : "default", {});
      case "retryStrategyBuilder":
        return new ProgramRetryStrategy("builder", isDict(a) ? { ...a } : {});
      case "getParameterSource":
        return context.paramSources?.[String(a)] ?? "DEFAULT";
      case "isRegion": {
        if (typeof a !== "string" || !context.regions) return false;
        const lower = a.toLowerCase();
        if (lower in context.regions.shortNames) return false;
        return context.regions.regions.includes(lower);
      }
      case "getRealmFromRegion": {
        if (typeof a !== "string" || !context.regions) return "oc1";
        const lower = a.toLowerCase();
        const full = context.regions.shortNames[lower] ?? lower;
        if (!context.regions.regions.includes(full)) return "oc1";
        return context.regions.regionRealms[full] ?? "oc1";
      }
      case "bytearray": {
        if (args.length === 0) return new Uint8Array(0);
        if (a instanceof Uint8Array) return new Uint8Array(a);
        if (typeof a === "string") return new TextEncoder().encode(a);
        if (typeof a === "number" && Number.isInteger(a) && a >= 0)
          return new Uint8Array(a);
        if (Array.isArray(a) && a.every((x) => typeof x === "number"))
          return Uint8Array.from(a as number[]);
        throw new ProgramUnsupported("bytearray()");
      }
      case "bytesIO": {
        if (args.length === 0 || a === null || a === undefined)
          return new ProgramFile("rb", new Uint8Array(0));
        if (a instanceof Uint8Array)
          return new ProgramFile("rb", new Uint8Array(a));
        if (typeof a === "string")
          return new ProgramFile("rb", new TextEncoder().encode(a));
        throw new ProgramUnsupported("io.BytesIO()");
      }
      case "cliDatetimeConvert": {
        try {
          return convertCliDatetime(pyStr(a), context.datetime);
        } catch (err) {
          if (err instanceof BadParameter) {
            throw new ProgramRaise("BadParameter", err.message);
          }
          if (err instanceof TimestampRangeError) {
            throw new ProgramRaise("ValueError", err.message);
          }
          throw err;
        }
      }
      case "simpleResponse": {
        const hdrs =
          b instanceof ProgramHeaders ||
          isDict(b) ||
          b === null ||
          b === undefined
            ? (b ?? null)
            : null;
        return new ProgramSimpleResponse(a, hdrs);
      }
      case "progressbar": {
        const length = typeof a === "number" ? a : null;
        const label =
          typeof b === "string"
            ? b
            : b === null || b === undefined
              ? ""
              : pyStr(b);
        const fileArg = args[2];
        const toStderr =
          fileArg instanceof ProgramObject && fileArg.kind === "sys.stderr";
        return new ProgramProgressBar(length, label, toStderr);
      }
      case "roverBundleDecrypt": {
        // services.rover.src.oci_cli_rover.rover_utils.bundle_decrypt(in_file, out_file, key)
        if (
          typeof a !== "string" ||
          typeof b !== "string" ||
          typeof args[2] !== "string"
        ) {
          throw new ProgramUnsupported("bundle_decrypt()");
        }
        const keyHex =
          args[2].length >= 32
            ? args[2]
            : args[2] + "0".repeat(32 - args[2].length);
        const bkey = fn("bytesFromHex", [keyHex]) as Uint8Array;
        const inHandle = files.open(a, "rb");
        const encData = inHandle.read() as Uint8Array;
        const algo =
          bkey.length === 16
            ? "aes-128-cbc"
            : bkey.length === 24
              ? "aes-192-cbc"
              : "aes-256-cbc";
        const iv = bkey.subarray(0, 16);
        let decData: Uint8Array;
        try {
          const decipher = createDecipheriv(algo, bkey, iv);
          decData = Buffer.concat([decipher.update(encData), decipher.final()]);
        } catch (err) {
          throw new ProgramRaise(
            "ValueError",
            err instanceof Error ? err.message : "Decryption failed",
          );
        }
        const outHandle = files.open(b, "wb");
        outHandle.write(decData);
        outHandle.close();
        return null;
      }
      case "roverUploadMultipart": {
        // upload_multi_part(ctx, file, namespace, bucket_name, name)
        const fileObj = args[1];
        const namespace = args[2];
        const bucketName = args[3];
        const objectName = args[4];
        if (
          !(fileObj instanceof ProgramFile) ||
          typeof namespace !== "string" ||
          typeof bucketName !== "string" ||
          typeof objectName !== "string"
        ) {
          throw new ProgramUnsupported("upload_multi_part()");
        }
        const i = uploadCalled++;
        const cached = context.uploadResults?.[i];
        if (cached !== undefined) {
          if (cached instanceof Error) throw cached;
          return cached;
        }
        // Apply get_object_storage_helper region/endpoint overrides.
        let region: string | undefined;
        let endpoint: string | null | undefined;
        const cfg = ctxObj.fields.config;
        const cfgRegion =
          cfg instanceof ProgramObject
            ? cfg.fields.region
            : isDict(cfg)
              ? cfg.region
              : undefined;
        if (
          typeof cfgRegion === "string" &&
          cfgRegion.trim().split(".")[0] === "r1"
        ) {
          region = "r1.oracleiaas.com";
        } else if (
          isDict(ctxObj.fields.default_values_from_file) &&
          typeof ctxObj.fields.default_values_from_file["os.endpoint"] ===
            "string"
        ) {
          endpoint = ctxObj.fields.default_values_from_file["os.endpoint"];
        } else if (typeof ctxObj.fields.endpoint === "string") {
          endpoint = ctxObj.fields.endpoint;
        }
        const requestId =
          typeof ctxObj.fields.request_id === "string"
            ? ctxObj.fields.request_id
            : null;
        throw new ProgramUploadObject(
          fileObj,
          namespace,
          bucketName,
          objectName,
          region,
          endpoint,
          requestId,
        );
      }
      case "dirname":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.dirname()");
        return pyDirname(a);
      case "randomChoice": {
        const seq =
          typeof a === "string" ? [...a] : Array.isArray(a) ? a : null;
        if (!seq) throw new ProgramUnsupported("random.choice()");
        if (seq.length === 0)
          throw new ProgramRaise(
            "IndexError",
            "Cannot choose from an empty sequence",
          );
        const i = randomCalled++;
        if (context.randomChoices && i < context.randomChoices.length) {
          return context.randomChoices[i];
        }
        const picked = seq[Math.floor(Math.random() * seq.length)];
        context.randomChoices?.push(picked);
        return picked;
      }
      case "configFromFile": {
        if (!context.configFromFile)
          throw new ProgramUnsupported("oci.config.from_file()");
        const fileLoc = a === null || a === undefined ? undefined : String(a);
        const prof = b === null || b === undefined ? undefined : String(b);
        return context.configFromFile(fileLoc, prof);
      }
      case "buildConfig": {
        if (!context.buildConfig)
          throw new ProgramUnsupported("cli_util.build_config()");
        const cmdArgs =
          a instanceof ProgramObject ? a.fields : isDict(a) ? a : null;
        if (!cmdArgs)
          throw new ProgramUnsupported("cli_util.build_config() arg");
        return context.buildConfig(cmdArgs);
      }
      case "jmespathFromContext": {
        const rawQuery = context.resolveQuery
          ? context.resolveQuery()
          : typeof ctxObj.fields.query === "string"
            ? ctxObj.fields.query
            : null;
        if (!rawQuery) return null;
        try {
          applyQuery({}, rawQuery);
        } catch (err) {
          throw new ProgramRaise(
            "Exception",
            err instanceof Error ? err.message : String(err),
          );
        }
        return new ProgramJmespath(rawQuery);
      }
      case "bool":
        return pyTruthy(a);
      case "enumerate": {
        const items = iterate(a);
        const start = args.length >= 2 ? args[1] : 0;
        if (typeof start !== "number" || !Number.isInteger(start))
          throw new ProgramUnsupported("enumerate() start");
        return items.map((x, idx) => [start + idx, x]);
      }
      case "any":
        return iterate(a).some((x) => pyTruthy(x));
      case "all":
        return iterate(a).every((x) => pyTruthy(x));
      case "min":
      case "max": {
        const items = args.length === 1 ? iterate(a) : args;
        if (items.length === 0) {
          throw new ProgramRaise(
            "ValueError",
            `${name}() iterable argument is empty`,
          );
        }
        const cmpOp = name === "min" ? "<" : ">";
        let best = items[0];
        for (let i = 1; i < items.length; i++) {
          if (compare(cmpOp, items[i], best)) best = items[i];
        }
        return best;
      }
      case "pyMap": {
        if (typeof a !== "string") throw new ProgramUnsupported("map() target");
        return iterate(b).map((x) => fn(a, [x]));
      }
      case "clickStyle":
        return clickStyle(a, isDict(b) ? b : {});
      case "abspath":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.abspath()");
        return files.abspath ? files.abspath(a) : resolve(a);
      case "isZipfile":
        if (typeof a === "string") {
          return files.isZipfile ? files.isZipfile(a) : false;
        }
        if (a instanceof ProgramFile) {
          const data = a.reopen().read();
          return isZipBuffer(
            data instanceof Uint8Array ? data : new TextEncoder().encode(data),
          );
        }
        return false;
      case "deleteFnEndpointCache": {
        const ctxFields =
          a instanceof ProgramObject ? a.fields : isDict(a) ? a : {};
        if (typeof b === "string" && files.deleteFnEndpointCache) {
          files.deleteFnEndpointCache(ctxFields, b);
        }
        return null;
      }
      case "stderr":
        return new ProgramObject("sys.stderr");
      case "stdout":
        return new ProgramObject("sys.stdout");
      case "echo": {
        // click.echo(message=None, file=None, nl=True, err=False)
        const [message, file, nl = true, err = false] = args;
        let toStderr = pyTruthy(err);
        if (file !== null && file !== undefined) {
          if (file instanceof ProgramObject && file.kind === "sys.stderr")
            toStderr = true;
          else if (!(
            file instanceof ProgramObject && file.kind === "sys.stdout"
          ))
            throw new ProgramUnsupported("click.echo file");
        }
        const body =
          message === null || message === undefined
            ? ""
            : typeof message === "string"
              ? message
              : message instanceof Uint8Array
                ? decodePythonUtf8(message)
                : pyStr(message);
        const text = pyTruthy(nl) ? `${body}\n` : body;
        const i = echoCalled++;
        if (i < (context.echoCount ?? 0)) return null;
        throw new ProgramEcho(text, toStderr);
      }
      case "print": {
        // print(*objects, sep=' ', end='\n', file=sys.stdout)
        const [items, sepVal, endVal, file] = args;
        if (!Array.isArray(items)) throw new ProgramUnsupported("print()");
        let toStderr = false;
        if (file !== null && file !== undefined) {
          if (file instanceof ProgramObject && file.kind === "sys.stderr")
            toStderr = true;
          else if (!(
            file instanceof ProgramObject && file.kind === "sys.stdout"
          ))
            throw new ProgramUnsupported("print() file");
        }
        if (
          sepVal !== null &&
          sepVal !== undefined &&
          typeof sepVal !== "string"
        )
          throw new ProgramUnsupported("print() sep");
        if (
          endVal !== null &&
          endVal !== undefined &&
          typeof endVal !== "string"
        )
          throw new ProgramUnsupported("print() end");
        const sep = sepVal ?? " ";
        const end = endVal ?? "\n";
        const text = `${items.map((x) => pyStr(x)).join(sep)}${end}`;
        const i = echoCalled++;
        if (i < (context.echoCount ?? 0)) return null;
        throw new ProgramEcho(text, toStderr);
      }
      case "toDict":
        return toDictValue(a);
      case "sdkToDict":
        return toDictValue(a, true);
      case "formattedFlatDict":
        return JSON.stringify(sortKeys(toDictValue(a)), null, 2);
      case "sdkFormattedFlatDict":
        return JSON.stringify(sortKeys(toDictValue(a, true)), null, 2);
      case "tenancyFromConfig":
        return context.tenancy?.() ?? null;
      case "expanduser":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.expanduser()");
        return expandHomeDir(a, context.env ?? process.env);
      case "expandvars":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.expandvars()");
        return expandVars(a, context.env ?? process.env);
      case "sleep": {
        if (typeof a !== "number" || !Number.isFinite(a))
          throw new ProgramUnsupported("time.sleep()");
        if (a < 0)
          throw new ProgramRaise(
            "ValueError",
            "sleep length must be non-negative",
          );
        const i = sleepCalled++;
        if (i < (context.sleepCount ?? 0)) return null;
        throw new ProgramSleep(a);
      }
      case "b64encode":
        if (!(a instanceof Uint8Array))
          throw new ProgramUnsupported("b64encode() of a str");
        return new TextEncoder().encode(Buffer.from(a).toString("base64"));
      case "removeSkeleton":
        // json_skeleton_utils.remove_json_skeleton_params_from_dict
        if (isDict(a)) {
          delete a.generate_param_json_input;
          delete a.generate_full_command_json_input;
          delete a.from_json;
        }
        return null;
      case "dict": {
        // dict() / dict(pairs) / dict(a_dict): a new dict.
        if (args.length === 0) return {};
        if (a instanceof ProgramHeaders) return Object.fromEntries(a.entries());
        if (isDict(a)) return { ...a };
        const out: Dict = {};
        for (const pair of iterate(a)) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== "string"
          )
            throw new ProgramUnsupported("dict() pair");
          out[pair[0]] = pair[1];
        }
        return out;
      }
      case "dataflowArguments":
      case "dataflowParameters":
      case "dataflowConfiguration":
        // json.dumps(..., sort_keys=True): the generated command parses it back.
        return JSON.stringify(sortKeys(HAND_CODED[name]?.(pyStr(a))));
      case "sseParams":
        return sseParams(a, "opc_sse_customer");
      case "sourceSseParams":
        return sseParams(a, "opc_source_sse_customer");
      case "sseCustomerKey": {
        const k = sseKey(a);
        return (
          k && { algorithm: SSE_ALGORITHM, key: k.key, keySha256: k.sha256 }
        );
      }
      case "ctxObj":
        return ctxObj;
      case "ctxDefaultMap":
        return context.defaultMap ?? null;
      case "client": {
        // cli_util.build_client: ctx.obj['config'] is the config it built from.
        const overrideRegion =
          typeof ctxObj.fields.region === "string"
            ? ctxObj.fields.region
            : undefined;
        const overrideEndpoint =
          typeof ctxObj.fields.endpoint === "string"
            ? ctxObj.fields.endpoint
            : ctxObj.fields.endpoint === null
              ? null
              : undefined;
        const region = overrideRegion ?? context.region?.();
        ctxObj.fields.config = new ProgramObject(
          "config",
          region !== undefined ? { region } : {},
        );
        return new ProgramObject(`${String(a)}.${String(b)}`, {
          ...(overrideRegion !== undefined ? { region: overrideRegion } : {}),
          ...(overrideEndpoint !== undefined
            ? { endpoint: overrideEndpoint }
            : {}),
        });
      }
      case "namespace":
        if (
          !(a instanceof ProgramObject) ||
          a.kind !== "object_storage.object_storage"
        )
          throw new ProgramUnsupported("get_namespace()");
        if (context.namespace === undefined) {
          throw new ProgramLookup(
            typeof a.fields.region === "string" ? a.fields.region : undefined,
            "endpoint" in a.fields
              ? (a.fields.endpoint as string | null)
              : undefined,
          );
        }
        return context.namespace;
      case "confirm": {
        const defaultVal = args.length >= 2 ? pyTruthy(args[1]) : false;
        const abort = args.length >= 3 ? pyTruthy(args[2]) : false;
        const promptSuffix = args.length >= 4 ? pyStr(args[3]) : ": ";
        const showDefault = args.length >= 5 ? pyTruthy(args[4]) : true;
        const toStderr = args.length >= 6 ? pyTruthy(args[5]) : false;
        const i = asked++;
        if (i < answers.length) {
          const ans = Boolean(answers[i]);
          if (!ans && abort) throw new ProgramAbort();
          return ans;
        }
        throw new ProgramConfirm(
          pyStr(a),
          defaultVal,
          abort,
          promptSuffix,
          showDefault,
          toStderr,
        );
      }
      case "prompt": {
        const [
          textArg,
          hasDefaultArg,
          defaultVal,
          hideArg,
          confirmArg,
          rawTypeSpec,
          suffixArg,
          showDefaultArg,
          errArg,
        ] = args;
        let typeSpec: PromptTypeSpec = null;
        if (
          rawTypeSpec === "str" ||
          rawTypeSpec === "int" ||
          rawTypeSpec === "float" ||
          rawTypeSpec === "bool"
        ) {
          typeSpec = rawTypeSpec;
        } else if (
          Array.isArray(rawTypeSpec) &&
          rawTypeSpec[0] === "choice" &&
          Array.isArray(rawTypeSpec[1])
        ) {
          typeSpec = {
            kind: "choice",
            choices: rawTypeSpec[1].map(String),
            caseSensitive: pyTruthy(rawTypeSpec[2] ?? true),
          };
        }
        const i = asked++;
        if (i < answers.length) return answers[i];
        throw new ProgramPrompt(
          pyStr(textArg),
          pyTruthy(hasDefaultArg),
          defaultVal,
          pyTruthy(hideArg),
          pyTruthy(confirmArg),
          typeSpec,
          suffixArg === undefined || suffixArg === null
            ? ": "
            : pyStr(suffixArg),
          showDefaultArg === undefined ? true : pyTruthy(showDefaultArg),
          pyTruthy(errArg),
        );
      }
      case "roverSecret": {
        // rover_utils.prompt_for_secrets(secret_type)
        const i = asked++;
        if (i < answers.length) return answers[i];
        throw new ProgramSecret(`Enter ${pyStr(a)} (minimum 8 characters)`);
      }
      case "sandboxFile":
        if (a instanceof ProgramFile) return a;
        if (typeof b === "string")
          return new ProgramFile("rb", new TextEncoder().encode(b));
        throw new ProgramUnsupported("sandbox file body");
      case "hasName":
        return a instanceof ProgramFile && a.name !== undefined;
      case "fileName":
        if (!(a instanceof ProgramFile) || a.name === undefined)
          throw new ProgramUnsupported("file.name");
        return a.name === "-" ? "<stdin>" : a.name;
      case "basename":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.basename()");
        return basename(a);
      case "isstr":
        // isinstance(a, six.string_types) / isinstance(a, str)
        return typeof a === "string";
      case "isinstance": {
        const types = Array.isArray(b) ? (b as string[]) : [String(b)];
        return types.some((t) => {
          switch (t) {
            case "str":
              return typeof a === "string";
            case "bool":
              return typeof a === "boolean";
            case "int":
              return (
                typeof a === "boolean" ||
                (typeof a === "number" && Number.isInteger(a))
              );
            case "float":
              return typeof a === "number";
            case "tuple":
              return Array.isArray(a) && pyTuples.has(a);
            case "list":
              return Array.isArray(a) && !pyTuples.has(a);
            case "dict":
              return isDict(a);
            case "bytes":
              return a instanceof Uint8Array;
            case "file":
              return a instanceof ProgramFile;
            case "Exception":
              return (
                a instanceof ProgramRaise || a instanceof ProgramServiceError
              );
            default:
              throw new ProgramUnsupported(`isinstance(${t})`);
          }
        });
      }
      case "open":
        if (typeof a !== "string" || typeof b !== "string")
          throw new ProgramUnsupported("open()");
        return files.open(a, b);
      case "exists":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.exists()");
        return files.exists(a);
      case "isfile":
        if (typeof a !== "string")
          throw new ProgramUnsupported("os.path.isfile()");
        return files.isfile(a);
      case "items":
        if (a instanceof ProgramHeaders) return a.entries();
        if (isDict(a)) return Object.entries(a);
        throw new ProgramUnsupported("iteritems()");
      case "list":
        return args.length === 0 ? [] : [...iterate(a)];
      case "next": {
        // next(iterator): its first item; only ever called on a fresh one.
        const items = iterate(a);
        if (items.length === 0) throw new ProgramUnsupported("StopIteration");
        return items[0];
      }
      case "len":
        if (a instanceof ProgramHeaders) return a.size;
        if (typeof a === "string" || Array.isArray(a)) return a.length;
        if (isDict(a)) return Object.keys(a).length;
        throw new ProgramUnsupported("len()");
    }
    throw new ProgramUnsupported(`${name}()`);
  };

  /** Assigns `x` to a name or unpacks it over names (`a, b = x`). */
  const assign = (target: unknown, x: unknown): void => {
    if (typeof target === "string") {
      env[target] = x;
      return;
    }
    const names = target as string[];
    if (!Array.isArray(x) || x.length !== names.length)
      throw new ProgramUnsupported("ValueError: unpack");
    names.forEach((n, i) => {
      env[n] = x[i];
    });
  };

  /** A comprehension's loop variable(s) bound to `x`; true when every `if` holds. */
  const bind = (target: unknown, x: unknown, conds?: Expr[]): boolean => {
    assign(target, x);
    return (conds ?? []).every((c) => pyTruthy(evaluate(c)));
  };

  /** Evaluates a single-expression Python lambda with bound parameter values. */
  const evalLambda = (lam: ProgramLambda, argVals: unknown[]): unknown => {
    if (argVals.length !== lam.params.length) {
      throw new ProgramRaise("TypeError", "lambda argument count mismatch");
    }
    const saved: [string, boolean, unknown][] = lam.params.map((p) => [
      p,
      p in env,
      env[p],
    ]);
    for (let i = 0; i < lam.params.length; i++) {
      env[lam.params[i]!] = argVals[i];
    }
    try {
      return evaluate(lam.body);
    } finally {
      for (const [p, had, prev] of saved) {
        if (had) env[p] = prev;
        else delete env[p];
      }
    }
  };

  /** Executes a raw HTTP request on a `ProgramRequestsSession` (with replay caching). */
  const executeSessionRequest = (
    session: ProgramRequestsSession,
    pos: unknown[],
    kw: Dict,
    retryMode: "default" | "builder" | "none",
  ): ProgramHttpResponse => {
    const method = (pos[0] ?? kw.method) as unknown;
    const url = (pos[1] ?? kw.url) as unknown;
    if (typeof method !== "string" || typeof url !== "string") {
      throw new ProgramUnsupported("requests_session.request() method/url");
    }
    const mergedParams: Dict = { ...session.params };
    if (isDict(kw.params)) Object.assign(mergedParams, kw.params);
    const mergedHeaders: Record<string, string> = {};
    for (const [k, v] of session.headers.entries()) mergedHeaders[k] = v;
    if (isDict(kw.headers)) {
      for (const [k, v] of Object.entries(kw.headers)) {
        if (v !== undefined && v !== null) mergedHeaders[k] = String(v);
      }
    }
    const hasJson = "json" in kw && kw.json !== null && kw.json !== undefined;
    const i = rawCalled++;
    const cached = context.rawResults?.[i];
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    const requestId =
      typeof ctxObj.fields.request_id === "string"
        ? ctxObj.fields.request_id
        : null;
    throw new ProgramRawRequest(
      method,
      url,
      Object.keys(mergedParams).length > 0 ? mergedParams : null,
      mergedHeaders,
      kw.data,
      hasJson,
      kw.json,
      pyTruthy(kw.stream ?? false),
      session.auth,
      retryMode,
      requestId,
    );
  };

  const evaluate = (e: Expr): unknown => {
    if (!Array.isArray(e)) return e;
    const [op, ...rest] = e as [string, ...Expr[]];
    switch (op) {
      case "bytes":
        return new Uint8Array(Buffer.from(rest[0] as string, "base64"));
      case "setClientRegion": {
        const clientObj = evaluate(rest[0] as Expr);
        const region = evaluate(rest[1] as Expr);
        if (!(clientObj instanceof ProgramObject) || typeof region !== "string")
          throw new ProgramUnsupported("set_region");
        clientObj.fields.region = region;
        clientObj.fields.endpoint = null;
        return null;
      }
      case "var": {
        const name = rest[0] as string;
        if (!(name in env)) throw new ProgramUnsupported(`NameError: ${name}`);
        return env[name];
      }
      case "item":
        return item(evaluate(rest[0] as Expr), evaluate(rest[1] as Expr));
      case "slice": {
        const seq = evaluate(rest[0] as Expr);
        const lower = rest[1] === null ? null : evaluate(rest[1] as Expr);
        const upper = rest[2] === null ? null : evaluate(rest[2] as Expr);
        const stepVal = rest[3] === null ? null : evaluate(rest[3] as Expr);
        if (typeof seq !== "string" && !Array.isArray(seq))
          throw new ProgramUnsupported("slice");
        const step = stepVal === null || stepVal === undefined ? 1 : stepVal;
        if (typeof step !== "number" || !Number.isInteger(step) || step === 0)
          throw new ProgramUnsupported("slice step");
        const len = seq.length;
        const clamp = (raw: unknown, fallback: number): number => {
          if (raw === null || raw === undefined) return fallback;
          if (typeof raw !== "number" || !Number.isInteger(raw))
            throw new ProgramUnsupported("slice index");
          let i = raw < 0 ? raw + len : raw;
          if (step > 0) return Math.max(0, Math.min(len, i));
          return Math.max(-1, Math.min(len - 1, i));
        };
        const start = clamp(lower, step > 0 ? 0 : len - 1);
        const stop = clamp(upper, step > 0 ? len : -1);
        if (step === 1) return seq.slice(start, stop);
        if (typeof seq === "string") {
          let out = "";
          if (step > 0) {
            for (let i = start; i < stop; i += step) out += seq[i];
          } else {
            for (let i = start; i > stop; i += step) out += seq[i];
          }
          return out;
        }
        const out: unknown[] = [];
        if (step > 0) {
          for (let i = start; i < stop; i += step) out.push(seq[i]);
        } else {
          for (let i = start; i > stop; i += step) out.push(seq[i]);
        }
        return out;
      }
      case "call":
        return call(
          rest[0] as string,
          evaluate(rest[1] as Expr),
          rest.slice(2).map(evaluate),
        );
      case "attr": {
        const attr = rest[0] as string;
        const obj = evaluate(rest[1] as Expr);
        if (obj instanceof ProgramFile) {
          if (attr === "name") return obj.name ?? null;
          throw new ProgramRaise(
            "AttributeError",
            `'file' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramRequestsSession) {
          if (attr === "params") return obj.params;
          if (attr === "headers") return obj.headers;
          if (attr === "auth") return obj.auth;
          if (attr === "request") return new ProgramBoundMethod(obj, "request");
          throw new ProgramRaise(
            "AttributeError",
            `'Session' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramHttpResponse) {
          if (attr === "status_code") return obj.statusCode;
          if (attr === "reason") return obj.reason;
          if (attr === "headers") return obj.headers;
          if (attr === "text") return obj.text;
          if (attr === "content") return obj.content;
          if (attr === "raw") {
            return new ProgramObject("http.raw", { _response: obj });
          }
          if (attr === "request") {
            return new ProgramObject("http.request", {
              url: obj.requestUrl,
              headers: obj.requestHeaders,
            });
          }
          throw new ProgramRaise(
            "AttributeError",
            `'Response' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramSimpleResponse) {
          if (attr === "data") return obj.data;
          if (attr === "headers") return obj.headers;
          throw new ProgramRaise(
            "AttributeError",
            `'RoverDiagAPI' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramStatResult) {
          if (attr === "st_size") return obj.st_size;
          throw new ProgramRaise(
            "AttributeError",
            `'stat_result' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramProgressBar) {
          if (attr === "finished") return obj.finished;
          throw new ProgramRaise(
            "AttributeError",
            `'ProgressBar' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramObject && attr in obj.fields) {
          return obj.fields[attr];
        }
        if (obj instanceof ProgramResponse) {
          if (attr === "data") return obj.data;
          if (attr === "headers") return obj.headers;
          if (attr === "status") return obj.status;
          if (attr === "request_id") return obj.requestId;
          if (attr === "next_page") return obj.nextPage;
          if (attr === "has_next_page") return obj.hasNextPage;
          throw new ProgramRaise(
            "AttributeError",
            `'Response' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramServiceError) {
          if (attr === "status") return obj.status;
          if (attr === "code") return obj.code;
          if (attr === "message") return obj.serviceMessage;
          if (attr === "headers") return obj.headers;
          if (attr === "request_id") return obj.requestId;
          throw new ProgramRaise(
            "AttributeError",
            `'ServiceError' object has no attribute '${attr}'`,
          );
        }
        if (obj === null || obj === undefined) {
          throw new ProgramRaise(
            "AttributeError",
            `'NoneType' object has no attribute '${attr}'`,
          );
        }
        if (obj instanceof ProgramModel) return obj.getAttr(attr);
        if (isDict(obj)) return modelAttr(obj, attr);
        throw new ProgramUnsupported(`attribute .${attr}`);
      }
      case "lambda": {
        const pnames = rest[0] as unknown as string[];
        const bodyExpr = rest[1] as Expr;
        return new ProgramLambda(pnames, bodyExpr);
      }
      case "retryBuilderMethod": {
        const methodName = rest[0] as string;
        const recv = evaluate(rest[1] as Expr);
        if (!(recv instanceof ProgramRetryStrategy)) {
          throw new ProgramUnsupported(`retryBuilderMethod ${methodName}`);
        }
        // Evaluate arguments for side effects; return strategy object.
        (rest[2] as Expr[]).map(evaluate);
        for (const [k, vExpr] of rest[3] as [string, Expr][]) {
          recv.opts[k] = evaluate(vExpr);
        }
        return recv;
      }
      case "retryCall": {
        const strategy = evaluate(rest[0] as Expr);
        if (!(strategy instanceof ProgramRetryStrategy)) {
          throw new ProgramUnsupported("make_retrying_call on non-strategy");
        }
        const pos = (rest[1] as Expr[]).map(evaluate);
        const kwPairs = rest[2] as [string, Expr][];
        const starExpr = rest[3] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("make_retrying_call ** of non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          kw[k] = evaluate(expr);
        }
        const targetFn = pos[0];
        if (
          targetFn instanceof ProgramBoundMethod &&
          targetFn.target instanceof ProgramRequestsSession &&
          targetFn.method === "request"
        ) {
          return executeSessionRequest(
            targetFn.target,
            pos.slice(1),
            kw,
            strategy.mode,
          );
        }
        throw new ProgramUnsupported("make_retrying_call target");
      }
      case "sessionRequest": {
        const session = evaluate(rest[0] as Expr);
        if (!(session instanceof ProgramRequestsSession)) {
          throw new ProgramUnsupported("request() on non-session");
        }
        const pos = (rest[1] as Expr[]).map(evaluate);
        const kwPairs = rest[2] as [string, Expr][];
        const starExpr = rest[3] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("request() ** of non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          kw[k] = evaluate(expr);
        }
        return executeSessionRequest(session, pos, kw, "none");
      }
      case "fstr":
        return rest
          .map((part) => {
            const v = evaluate(part);
            return typeof v === "string" ? v : pyStr(v);
          })
          .join("");
      case "fmtVal": {
        const val = evaluate(rest[0] as Expr);
        const conv = rest[1] as string | null;
        const rawSpec = rest[2] === null ? null : evaluate(rest[2] as Expr);
        const spec =
          rawSpec === null || rawSpec === undefined ? null : pyStr(rawSpec);
        return pyFormatValue(val, conv, spec);
      }
      case "model": {
        const moduleName = rest[0] as string;
        const className = rest[1] as string;
        const defaultPairs = rest[2] as [string, Expr][];
        const kwPairs = rest[3] as [string, Expr][];
        const starExpr = rest[4] as Expr | null;
        const defaults: [string, unknown][] = defaultPairs.map(([k, v]) => [
          k,
          evaluate(v),
        ]);
        const modelDef = context.models?.[moduleName]?.[className];
        const instance = new ProgramModel(
          moduleName,
          className,
          modelDef,
          defaults,
        );
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("model ** of a non-dict");
          for (const [k, v] of Object.entries(star)) instance.setAttr(k, v);
        }
        for (const [k, vExpr] of kwPairs) {
          instance.setAttr(k, evaluate(vExpr));
        }
        return instance;
      }
      case "callApi": {
        const opIndex = rest[0] as number;
        const clientObj = evaluate(rest[1] as Expr);
        if (!(clientObj instanceof ProgramObject))
          throw new ProgramUnsupported("call_api on non-client");
        const pos = (rest[2] as Expr[]).map(evaluate);
        const kwPairs = rest[3] as [string, Expr][];
        const starExpr = rest[4] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("call_api ** of a non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          if (k in kw)
            throw new ProgramUnsupported(`duplicate call_api kwarg ${k}`);
          kw[k] = evaluate(expr);
        }
        const argNames = [
          "resource_path",
          "method",
          "path_params",
          "query_params",
          "header_params",
          "body",
          "response_type",
          "enforce_content_headers",
          "allow_control_chars",
          "enable_strict_url_encoding",
          "operation_name",
          "api_reference_link",
          "required_arguments",
        ];
        for (let idx = 0; idx < pos.length; idx++) {
          const name = argNames[idx];
          if (!name) throw new ProgramUnsupported("call_api too many args");
          if (name in kw)
            throw new ProgramUnsupported(`duplicate call_api arg ${name}`);
          kw[name] = pos[idx];
        }
        if (
          typeof kw.resource_path !== "string" ||
          typeof kw.method !== "string"
        )
          throw new ProgramUnsupported("call_api resource_path/method");
        const i = sdkCalled++;
        const cached = context.sdkResults?.[i];
        if (cached !== undefined) {
          if (cached instanceof Error) throw cached;
          cached.reset();
          return cached;
        }
        const region =
          typeof clientObj.fields.region === "string"
            ? clientObj.fields.region
            : undefined;
        const endpoint =
          "endpoint" in clientObj.fields
            ? (clientObj.fields.endpoint as string | null)
            : undefined;
        throw new ProgramCallApi(
          opIndex,
          kw.resource_path,
          kw.method,
          isDict(kw.path_params) ? kw.path_params : null,
          isDict(kw.query_params) || Array.isArray(kw.query_params)
            ? (kw.query_params as Dict | [string, unknown][])
            : null,
          isDict(kw.header_params) ? kw.header_params : null,
          kw.body,
          typeof kw.response_type === "string" ? kw.response_type : null,
          kw.enforce_content_headers === undefined
            ? true
            : pyTruthy(kw.enforce_content_headers),
          typeof kw.operation_name === "string" ? kw.operation_name : null,
          region,
          endpoint,
        );
      }
      case "invoke":
        recordInvoke(rest as unknown[]);
        return null;
      case "format": {
        const receiver = evaluate(rest[0] as Expr);
        if (typeof receiver !== "string")
          throw new ProgramUnsupported("format() on non-string");
        const pos = (rest[1] as Expr[]).map(evaluate);
        const kwPairs = rest[2] as [string, Expr][];
        const starExpr = rest[3] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("format ** of a non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          if (k in kw)
            throw new ProgramUnsupported(`duplicate format kwarg ${k}`);
          kw[k] = evaluate(expr);
        }
        return pyFormat(receiver, pos, kw);
      }
      case "evalBlock":
        try {
          execute(rest[0] as unknown as Statement[]);
          return null;
        } catch (e) {
          if (e instanceof ProgramReturn) return e.value;
          throw e;
        }
      case "sdk": {
        const opIndex = rest[0] as number;
        const clientObj = evaluate(rest[1] as Expr);
        if (!(clientObj instanceof ProgramObject))
          throw new ProgramUnsupported("sdk call on non-client");
        const pos = (rest[2] as Expr[]).map(evaluate);
        const kwPairs = rest[3] as [string, Expr][];
        const starExpr = rest[4] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("sdk ** of a non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          if (k in kw) throw new ProgramUnsupported(`duplicate sdk kwarg ${k}`);
          kw[k] = evaluate(expr);
        }
        const i = sdkCalled++;
        const cached = context.sdkResults?.[i];
        if (cached !== undefined) {
          if (cached instanceof Error) throw cached;
          cached.reset();
          return cached;
        }
        const region =
          typeof clientObj.fields.region === "string"
            ? clientObj.fields.region
            : undefined;
        const endpoint =
          "endpoint" in clientObj.fields
            ? (clientObj.fields.endpoint as string | null)
            : undefined;
        throw new ProgramSdkCall(opIndex, pos, kw, region, endpoint);
      }
      case "listCall": {
        const mode = rest[0] as "all" | "limit";
        const multipleKeys = Boolean(rest[1]);
        const opIndex = rest[2] as number;
        const clientObj = evaluate(rest[3] as Expr);
        if (!(clientObj instanceof ProgramObject))
          throw new ProgramUnsupported("listCall on non-client");
        const extra = (rest[4] as Expr[]).map(evaluate);
        const kwPairs = rest[5] as [string, Expr][];
        const starExpr = rest[6] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("listCall ** of a non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) {
          if (k in kw)
            throw new ProgramUnsupported(`duplicate listCall kwarg ${k}`);
          kw[k] = evaluate(expr);
        }
        let recordLimit: unknown;
        let pageSize: unknown;
        if (mode === "all") {
          const [, streamOutput] = extra;
          if (pyTruthy(streamOutput))
            throw new ProgramUnsupported("list_call stream_output");
        } else {
          [recordLimit, pageSize] = extra;
        }
        const i = listCalled++;
        const cached = context.listResults?.[i];
        if (cached !== undefined) {
          if (cached instanceof Error) throw cached;
          cached.reset();
          return cached;
        }
        const region =
          typeof clientObj.fields.region === "string"
            ? clientObj.fields.region
            : undefined;
        const endpoint =
          "endpoint" in clientObj.fields
            ? (clientObj.fields.endpoint as string | null)
            : undefined;
        throw new ProgramListCall(
          mode,
          multipleKeys,
          opIndex,
          kw,
          region,
          recordLimit,
          pageSize,
          endpoint,
        );
      }
      case "waitUntil": {
        const pos = (rest[0] as Expr[]).map(evaluate);
        const kwPairs = rest[1] as [string, Expr][];
        const starExpr = rest[2] as Expr | null;
        const kw: Dict = {};
        if (starExpr !== null) {
          const star = evaluate(starExpr);
          if (!isDict(star))
            throw new ProgramUnsupported("wait_until ** of a non-dict");
          Object.assign(kw, star);
        }
        for (const [k, expr] of kwPairs) kw[k] = evaluate(expr);
        const response = pos[1] ?? kw.response;
        const property = pos[2] ?? kw.property;
        const stateArg = pos[3] ?? kw.state;
        if (
          !(response instanceof ProgramResponse) ||
          typeof property !== "string"
        )
          throw new ProgramUnsupported("oci.wait_until args");
        const states = Array.isArray(stateArg)
          ? stateArg.map(String)
          : typeof stateArg === "string"
            ? [stateArg]
            : null;
        if (!states) throw new ProgramUnsupported("oci.wait_until state");
        const maxWait =
          kw.max_wait_seconds !== undefined && kw.max_wait_seconds !== null
            ? Number(kw.max_wait_seconds)
            : 1200;
        const maxInterval =
          kw.max_interval_seconds !== undefined &&
          kw.max_interval_seconds !== null
            ? Number(kw.max_interval_seconds)
            : 30;
        const succeedOnNotFound = pyTruthy(kw.succeed_on_not_found ?? false);
        const i = waitCalled++;
        const cached = context.waitResults?.[i];
        if (cached !== undefined) {
          if (cached instanceof Error) throw cached;
          cached.reset();
          return cached;
        }
        throw new ProgramWaitUntil(
          response,
          property,
          states,
          maxWait,
          maxInterval,
          succeedOnNotFound,
        );
      }
      case "fn":
        return fn(rest[0] as string, rest.slice(1).map(evaluate));
      case "dict": {
        const out: Dict = {};
        for (const pair of rest as Expr[][]) {
          const key = evaluate(pair[0] as Expr);
          if (typeof key !== "string") throw new ProgramUnsupported("dict key");
          out[key] = evaluate(pair[1] as Expr);
        }
        return out;
      }
      case "list":
        return rest.map(evaluate);
      case "map": {
        const out: unknown[] = [];
        for (const x of iterate(evaluate(rest[0] as Expr)))
          if (bind(rest[1], x, rest[3] as Expr[] | undefined))
            out.push(evaluate(rest[2] as Expr));
        return out;
      }
      case "dictcomp": {
        const out: Dict = {};
        for (const x of iterate(evaluate(rest[0] as Expr))) {
          if (!bind(rest[1], x, rest[4] as Expr[])) continue;
          const key = evaluate(rest[2] as Expr);
          if (typeof key !== "string") throw new ProgramUnsupported("dict key");
          out[key] = evaluate(rest[3] as Expr);
        }
        return out;
      }
      case "target":
        return new ProgramTarget(rest[0] as number);
      case "not":
        return !pyTruthy(evaluate(rest[0] as Expr));
      case "and": {
        let v: unknown = true;
        for (const part of rest) {
          v = evaluate(part);
          if (!pyTruthy(v)) return v;
        }
        return v;
      }
      case "or": {
        let v: unknown = false;
        for (const part of rest) {
          v = evaluate(part);
          if (pyTruthy(v)) return v;
        }
        return v;
      }
      case "cmp":
        return compare(
          rest[0] as string,
          evaluate(rest[1] as Expr),
          evaluate(rest[2] as Expr),
        );
      case "cmpChain": {
        let left = evaluate(rest[0] as Expr);
        for (const [cmpOp, rhsExpr] of rest[1] as [string, Expr][]) {
          const right = evaluate(rhsExpr);
          if (!compare(cmpOp, left, right)) return false;
          left = right;
        }
        return true;
      }
      case "bin": {
        const opName = rest[0] as string;
        const a = evaluate(rest[1] as Expr);
        const b = evaluate(rest[2] as Expr);
        return applyBinOp(opName, a, b, false);
      }
      case "ifexp":
        return pyTruthy(evaluate(rest[0] as Expr))
          ? evaluate(rest[1] as Expr)
          : evaluate(rest[2] as Expr);
    }
    throw new ProgramUnsupported(`op ${op}`);
  };

  const applyBinOp = (
    opName: string,
    a: unknown,
    b: unknown,
    inPlace: boolean,
  ): unknown => {
    if (opName === "+" && Array.isArray(a)) {
      if (inPlace) {
        a.push(...iterate(b));
        return a;
      }
      if (Array.isArray(b)) return [...a, ...b];
    }
    if (opName === "+" && typeof a === "string" && typeof b === "string")
      return a + b;
    if (opName === "+" && a instanceof Uint8Array && b instanceof Uint8Array) {
      const merged = new Uint8Array(a.length + b.length);
      merged.set(a, 0);
      merged.set(b, a.length);
      return merged;
    }
    if (opName === "%" && typeof a === "string") return pyPercentFormat(a, b);
    if (opName === "*" && typeof a === "string" && typeof b === "number")
      return b <= 0 ? "" : a.repeat(Math.trunc(b));
    if (opName === "*" && typeof a === "number" && typeof b === "string")
      return a <= 0 ? "" : b.repeat(Math.trunc(a));
    if (typeof a === "number" && typeof b === "number") {
      switch (opName) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0)
            throw new ProgramRaise("ZeroDivisionError", "division by zero");
          return a / b;
        case "//":
          if (b === 0)
            throw new ProgramRaise(
              "ZeroDivisionError",
              "integer division or modulo by zero",
            );
          return Math.floor(a / b);
        case "%":
          if (b === 0)
            throw new ProgramRaise(
              "ZeroDivisionError",
              "integer division or modulo by zero",
            );
          return ((a % b) + b) % b;
      }
    }
    throw new ProgramUnsupported(`TypeError: ${opName}`);
  };

  const recordInvoke = (rest: unknown[]): void => {
    if (invoked) throw new ProgramUnsupported("second invoke");
    const star = rest[1] === null ? {} : evaluate(rest[1] as Expr);
    if (!isDict(star)) throw new ProgramUnsupported("** of a non-dict");
    invoked = { ...star };
    const picked =
      rest[2] === undefined || typeof rest[2] === "number"
        ? (rest[2] ?? 0)
        : evaluate(rest[2] as Expr);
    if (!(picked instanceof ProgramTarget) && typeof picked !== "number")
      throw new ProgramUnsupported("invoke of a non-command");
    target = typeof picked === "number" ? picked : picked.index;
    for (const [name, e] of rest[0] as [string, Expr][])
      invoked[name] = evaluate(e);
  };

  const execute = (statements: Statement[]): void => {
    for (const st of statements) {
      const [op, ...rest] = st as [string, ...unknown[]];
      switch (op) {
        case "let":
          env[rest[0] as string] = evaluate(rest[1] as Expr);
          break;
        case "unpack":
          assign(rest[0], evaluate(rest[1] as Expr));
          break;
        case "set": {
          const obj = evaluate(rest[0] as Expr);
          const key = evaluate(rest[1] as Expr);
          const value = evaluate(rest[2] as Expr);
          if (obj instanceof ProgramObject && typeof key === "string")
            obj.fields[key] = value;
          else if (isDict(obj) && typeof key === "string") {
            obj[key] = value;
            markMutated(obj);
          } else if (Array.isArray(obj) && typeof key === "number") {
            obj[key < 0 ? obj.length + key : key] = value;
            markMutated(obj);
          } else throw new ProgramUnsupported("item assignment");
          break;
        }
        case "setAttr": {
          const obj = evaluate(rest[0] as Expr);
          const attr = rest[1] as string;
          const value = evaluate(rest[2] as Expr);
          if (obj instanceof ProgramModel) {
            obj.setAttr(attr, value);
            break;
          }
          if (obj instanceof ProgramResponse && attr === "data") {
            obj.data = value;
            obj.dataOverridden = true;
            break;
          }
          if (obj instanceof ProgramRequestsSession && attr === "auth") {
            if (
              Array.isArray(value) &&
              value.length === 2 &&
              typeof value[0] === "string" &&
              typeof value[1] === "string"
            ) {
              obj.auth = [value[0], value[1]];
            } else if (value === null || value === undefined) {
              obj.auth = null;
            } else {
              throw new ProgramUnsupported("session.auth");
            }
            break;
          }
          if (obj instanceof ProgramProgressBar && attr === "finished") {
            obj.finished = pyTruthy(value);
            break;
          }
          throw new ProgramUnsupported(String(rest[3] ?? `.${attr} =`));
        }
        case "setCtxAttr": {
          evaluate(rest[1] as Expr);
          break;
        }
        case "aug": {
          const opName = rest[0] as string;
          const name = rest[1] as string;
          if (!(name in env))
            throw new ProgramUnsupported(`NameError: ${name}`);
          const rhs = evaluate(rest[2] as Expr);
          env[name] = applyBinOp(opName, env[name], rhs, true);
          break;
        }
        case "augItem": {
          const opName = rest[0] as string;
          const obj = evaluate(rest[1] as Expr);
          const key = evaluate(rest[2] as Expr);
          const cur = item(obj, key);
          const nextVal = applyBinOp(
            opName,
            cur,
            evaluate(rest[3] as Expr),
            true,
          );
          if (obj === ctxObj && typeof key === "string")
            ctxObj.fields[key] = nextVal;
          else if (isDict(obj) && typeof key === "string") obj[key] = nextVal;
          else if (Array.isArray(obj) && typeof key === "number")
            obj[key < 0 ? obj.length + key : key] = nextVal;
          else throw new ProgramUnsupported("item assignment");
          break;
        }
        case "return":
          throw new ProgramReturn(evaluate(rest[0] as Expr));
        case "break":
          throw new ProgramBreak();
        case "continue":
          throw new ProgramContinue();
        case "block":
          try {
            execute(rest[0] as Statement[]);
          } catch (e) {
            if (!(e instanceof ProgramReturn)) throw e;
          }
          break;
        case "loadContextDefaults": {
          const loaded = context.loadContextDefaults?.();
          if (loaded) Object.assign(ctxObj.fields, loaded);
          break;
        }
        case "del": {
          const obj = evaluate(rest[0] as Expr);
          const key = evaluate(rest[1] as Expr);
          if (!isDict(obj) || typeof key !== "string" || !(key in obj))
            throw new ProgramUnsupported(`KeyError: ${String(key)}`);
          delete obj[key];
          markMutated(obj);
          break;
        }
        case "do":
          evaluate(rest[0] as Expr);
          break;
        case "if":
          execute(
            (pyTruthy(evaluate(rest[0] as Expr))
              ? rest[1]
              : rest[2]) as Statement[],
          );
          break;
        case "for":
          for (const x of iterate(evaluate(rest[1] as Expr))) {
            assign(rest[0], x);
            try {
              execute(rest[2] as Statement[]);
            } catch (e) {
              if (e instanceof ProgramBreak) break;
              if (e instanceof ProgramContinue) continue;
              throw e;
            }
          }
          break;
        case "while": {
          const test = rest[0] as Expr;
          const body = rest[1] as Statement[];
          const orelse = (rest[2] as Statement[] | undefined) ?? [];
          let iters = 0;
          let broke = false;
          while (pyTruthy(evaluate(test))) {
            if (++iters > MAX_WHILE_ITERATIONS) {
              throw new ProgramUnsupported(
                "while loop iteration limit exceeded",
              );
            }
            try {
              execute(body);
            } catch (e) {
              if (e instanceof ProgramBreak) {
                broke = true;
                break;
              }
              if (e instanceof ProgramContinue) continue;
              throw e;
            }
          }
          if (!broke && orelse.length > 0) execute(orelse);
          break;
        }
        case "withOpen": {
          const varName = rest[0] as string | null;
          const opened = evaluate(rest[1] as Expr);
          if (!(opened instanceof ProgramFile))
            throw new ProgramUnsupported("with open() returned non-file");
          if (varName !== null) env[varName] = opened;
          try {
            execute(rest[2] as Statement[]);
          } catch (e) {
            if (!isSuspension(e)) opened.close();
            throw e;
          }
          opened.close();
          break;
        }
        case "withSession": {
          const varName = rest[0] as string | null;
          const session = evaluate(rest[1] as Expr);
          if (!(session instanceof ProgramRequestsSession))
            throw new ProgramUnsupported("with session returned non-session");
          if (varName !== null) env[varName] = session;
          execute(rest[2] as Statement[]);
          break;
        }
        case "withProgressBar": {
          const varName = rest[0] as string | null;
          const bar = evaluate(rest[1] as Expr);
          if (!(bar instanceof ProgramProgressBar))
            throw new ProgramUnsupported("with progressbar returned non-bar");
          if (varName !== null) env[varName] = bar;
          execute(rest[2] as Statement[]);
          if (!bar.printed && bar.label) {
            bar.printed = true;
            const i = echoCalled++;
            if (i >= (context.echoCount ?? 0)) {
              throw new ProgramEcho(`${bar.label}\n`, bar.toStderr);
            }
          }
          break;
        }
        case "try":
          try {
            execute(rest[0] as Statement[]);
          } catch (e) {
            // `except Exception`: what the Engine models as raised Python exceptions.
            if (!matchesException(e, "Exception")) throw e;
            if (rest[1] !== null) env[rest[1] as string] = e;
            caught.push(e as Error);
            try {
              execute(rest[2] as Statement[]);
            } finally {
              caught.pop();
            }
          }
          break;
        case "tryMulti": {
          const body = rest[0] as Statement[];
          const handlers = rest[1] as [
            string | string[],
            string | null,
            Statement[],
          ][];
          const orelse = (rest[2] as Statement[] | undefined) ?? [];
          const finalbody = (rest[3] as Statement[] | undefined) ?? [];
          let completedNormally = false;
          try {
            try {
              execute(body);
              completedNormally = true;
            } catch (e) {
              if (isSuspension(e)) throw e;
              const matched = handlers.find(([excType]) =>
                matchesException(e, excType),
              );
              if (!matched) throw e;
              if (matched[1] !== null) env[matched[1]] = e;
              caught.push(e as Error);
              try {
                execute(matched[2]);
              } finally {
                caught.pop();
              }
            }
            if (completedNormally && orelse.length > 0) {
              execute(orelse);
            }
          } catch (e) {
            if (finalbody.length > 0 && !isSuspension(e)) {
              execute(finalbody);
            }
            throw e;
          }
          if (finalbody.length > 0) {
            execute(finalbody);
          }
          break;
        }
        case "reraise": {
          const active = caught.at(-1);
          if (!active)
            throw new ProgramUnsupported("bare raise outside except");
          throw active;
        }
        case "exit": {
          const arg = evaluate(rest[0] as Expr);
          if (arg === null || arg === undefined) throw new ProgramExit(0);
          if (typeof arg === "boolean") throw new ProgramExit(arg ? 1 : 0);
          if (typeof arg === "number")
            throw new ProgramExit(((arg % 256) + 256) % 256);
          throw new ProgramExit(1, `${pyStr(arg)}\n`);
        }
        case "checkNoExtraKwargs": {
          const targetName = (rest[1] as string | undefined) ?? "kwargs";
          const dict = targetName === "kwargs" ? kwargs : env[targetName];
          if (!isDict(dict)) throw new ProgramUnsupported("checkNoExtraKwargs");
          const extra = Object.keys(dict)[0];
          if (extra !== undefined) {
            throw new ProgramRaise(
              "TypeError",
              `${String(rest[0])}() got an unexpected keyword argument ${pyRepr(extra)}`,
            );
          }
          break;
        }
        case "abort":
          throw new ProgramAbort();
        case "usage":
          throw new ProgramUsageError(pyStr(evaluate(rest[0] as Expr)));
        case "raise": {
          if (rest.length < 3) throw new ProgramUnsupported(rest[0] as string);
          const cls = rest[1] as string;
          const arg = pyStr(evaluate(rest[2] as Expr));
          // str(KeyError(x)) is repr(x).
          throw new ProgramRaise(cls, cls === "KeyError" ? pyRepr(arg) : arg);
        }
        case "raiseMulti": {
          const cls = rest[1] as string;
          const vals = rest
            .slice(2)
            .map((argExpr) => evaluate(argExpr as Expr));
          const msg = `(${vals.map((v) => (typeof v === "string" ? pyRepr(v) : pyStr(v))).join(", ")})`;
          throw new ProgramRaise(cls, msg);
        }
        case "render": {
          const res = evaluate(rest[0] as Expr);
          if (res instanceof ProgramSimpleResponse) {
            const i = renderCalled++;
            if (i < (context.renderedCount ?? 0)) break;
            throw new ProgramRenderData(
              pyTruthy(res.data) ? toDictValue(res.data) : null,
              res.headers,
              false,
              true,
            );
          }
          if (!(res instanceof ProgramResponse))
            throw new ProgramUnsupported("render_response of non-response");
          const i = renderCalled++;
          if (i < (context.renderedCount ?? 0)) break;
          if (res.dataOverridden) {
            throw new ProgramRenderData(
              pyTruthy(res.data) ? toDictValue(res.data) : null,
              res.headers,
              false,
              true,
            );
          }
          throw new ProgramRender(res);
        }
        case "renderData": {
          const data = evaluate(rest[0] as Expr);
          const headersVal = evaluate(rest[1] as Expr);
          const displayAllHeaders = pyTruthy(evaluate(rest[2] as Expr));
          const nestData = pyTruthy(evaluate(rest[3] as Expr));
          let headers: ProgramHeaders | Dict | null = null;
          if (headersVal === null || headersVal === undefined) {
            headers = null;
          } else if (
            headersVal instanceof ProgramHeaders ||
            isDict(headersVal)
          ) {
            headers = headersVal;
          } else {
            throw new ProgramUnsupported("render() headers");
          }
          const i = renderCalled++;
          if (i < (context.renderedCount ?? 0)) break;
          throw new ProgramRenderData(
            pyTruthy(data) ? toDictValue(data) : null,
            headers,
            displayAllHeaders,
            nestData,
          );
        }
        case "invoke":
          recordInvoke(rest);
          break;
        default:
          throw new ProgramUnsupported(`statement ${op}`);
      }
    }
  };

  try {
    execute(program);
  } catch (e) {
    if (!(e instanceof ProgramReturn)) throw e;
  }
  if (!invoked) return {};
  // Back to the Engine's convention: unset options are absent, not None or a default.
  const result: Dict = {};
  const defaults = new Set(filled.values());
  for (const [name, value] of Object.entries(invoked)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && defaults.has(value)) continue;
    if (filled.has(name) && filled.get(name) === value) continue;
    result[name] = value;
  }
  return { kwargs: result, names: Object.keys(invoked), target };
}

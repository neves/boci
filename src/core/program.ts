/**
 * A Tier B wrapper's body, compiled by the extractor to a small JSON program
 * (tools/extract/program.py), run here over the wrapper's kwargs. It folds flat options
 * into the complex params of the generated command it invokes; the result is that
 * command's kwargs, which the Engine then binds to the request like any Generated command.
 */
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { expandHomeDir } from "../utils/expandHomeDir.ts";
import { decodePythonUtf8 } from "../utils/utf8.ts";
import { isZipBuffer } from "../utils/zip.ts";
import { inheritedDiscriminator, type Model } from "./camelize.ts";
import type { TypedParam } from "./convert.ts";
import type { OperationResult } from "./operation.ts";
import { renderModel } from "./output.ts";
import { expandVars } from "./rc.ts";
import { kwarg, truthy } from "./checks.ts";
import { pyRepr } from "./convert.ts";

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
 * `click.confirm(text)` with no answer yet: the caller asks, then runs the program again
 * with the answers so far (a program is a pure function of its kwargs and answers).
 */
export class ProgramConfirm extends Error {}

/**
 * `click.prompt(text, hide_input=True, confirmation_prompt=True)` with no answer yet:
 * answered like ProgramConfirm, with the string entered.
 */
export class ProgramSecret extends Error {}

/** What a program has been answered so far: click.confirm's booleans, prompts' strings. */
export type ProgramAnswer = boolean | string;

/** `ctx.abort()` in the wrapper. */
export class ProgramAbort extends Error {}

/** The wrapper took a path the Engine does not model (another exception, a TypeError). */
export class ProgramUnsupported extends Error {}

type Dict = Record<string, unknown>;

/**
 * `client.get_namespace().data` before the Engine has looked the namespace up: it makes
 * the request, then runs the program again with the answer (ticket 23).
 */
export class ProgramLookup extends Error {}

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
  ) {
    super(`sdk[${opIndex}]`);
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
  ) {
    super(`listCall[${mode}:${opIndex}]`);
  }
}

export type ProgramSdkOutcome =
  ProgramResponse | ProgramRaise | ProgramServiceError;

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
  defaultMap?: Dict | null;
  env?: Record<string, string | undefined>;
  loadContextDefaults?: () => Dict;
  sdkResults?: ProgramSdkOutcome[];
  listResults?: ProgramSdkOutcome[];
  waitResults?: ProgramSdkOutcome[];
  renderedCount?: number;
  echoCount?: number;
  sleepCount?: number;
  writtenFiles?: Set<number>;
};

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
  private readonly chunks: Uint8Array[] = [];
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

  read(): string | Uint8Array {
    if (this.data === undefined || /[wax+]/.test(this.mode))
      throw new ProgramUnsupported("io.UnsupportedOperation: not readable");
    const data = this.consumed ? new Uint8Array() : this.data;
    this.consumed = true;
    if (this.binary) return data;
    let text: string;
    try {
      text = decodePythonUtf8(data);
    } catch {
      throw new ProgramUnsupported("UnicodeDecodeError");
    }
    return text.replace(/\r\n?/g, "\n");
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
  !(v instanceof ProgramHeaders) &&
  !(v instanceof Error) &&
  !(v instanceof Uint8Array);

const pyTruthy = (v: unknown): boolean => {
  if (v instanceof ProgramHeaders) return v.size > 0;
  if (
    v instanceof ProgramResponse ||
    v instanceof ProgramObject ||
    v instanceof ProgramFile ||
    v instanceof ProgramTarget
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
  if (Array.isArray(v)) return v.map((elem) => toDictValue(elem, snakeCase));
  if (isDict(v)) {
    const meta = modelMeta.get(v);
    if (meta) return renderModel(v, meta.type, meta.models, snakeCase);
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
    e instanceof ProgramSecret ||
    e instanceof ProgramLookup ||
    e instanceof ProgramSdkCall ||
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

/** Python `str.format` with positional/keyword fields and `!s`/`!r`/`!a` conversions. */
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
    if (spec) throw new ProgramUnsupported(`format spec ${m}`);
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
    if (conversion === "r" || conversion === "a") return pyElemRepr(val);
    return pyStr(val);
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
  let listCalled = 0;
  let waitCalled = 0;
  let renderCalled = 0;
  let echoCalled = 0;
  let sleepCalled = 0;
  const caught: Error[] = [];
  const ctxObj = new ProgramObject("ctx.obj", {
    request_id: context.requestId ?? null,
    endpoint: context.endpoint ?? null,
    config_file: context.configFile ?? null,
    profile: context.profile ?? null,
    auth: context.auth ?? null,
    enable_dual_stack: context.enableDualStack ?? false,
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
      if (method === "write" && args.length === 1) return obj.write(args[0]);
      if (method === "close" && args.length === 0) {
        obj.close();
        return null;
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
        const region = overrideRegion ?? context.region?.();
        ctxObj.fields.config = new ProgramObject(
          "config",
          region !== undefined ? { region } : {},
        );
        return new ProgramObject(
          `${String(a)}.${String(b)}`,
          overrideRegion !== undefined ? { region: overrideRegion } : {},
        );
      }
      case "namespace":
        if (
          !(a instanceof ProgramObject) ||
          a.kind !== "object_storage.object_storage"
        )
          throw new ProgramUnsupported("get_namespace()");
        if (context.namespace === undefined) throw new ProgramLookup();
        return context.namespace;
      case "confirm": {
        const i = asked++;
        if (i < answers.length) return answers[i];
        throw new ProgramConfirm(pyStr(a));
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

  const evaluate = (e: Expr): unknown => {
    if (!Array.isArray(e)) return e;
    const [op, ...rest] = e as [string, ...Expr[]];
    switch (op) {
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
        if (isDict(obj)) return modelAttr(obj, attr);
        throw new ProgramUnsupported(`attribute .${attr}`);
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
        throw new ProgramSdkCall(opIndex, pos, kw, region);
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
        throw new ProgramListCall(
          mode,
          multipleKeys,
          opIndex,
          kw,
          region,
          recordLimit,
          pageSize,
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
          if (obj === ctxObj && typeof key === "string")
            ctxObj.fields[key] = value;
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
          if (obj instanceof ProgramResponse && attr === "data") {
            obj.data = value;
            obj.dataOverridden = true;
            break;
          }
          throw new ProgramUnsupported(String(rest[3] ?? `.${attr} =`));
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
          if (typeof arg === "number") throw new ProgramExit(arg);
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
        case "render": {
          const res = evaluate(rest[0] as Expr);
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

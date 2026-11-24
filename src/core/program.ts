/**
 * A Tier B wrapper's body, compiled by the extractor to a small JSON program
 * (tools/extract/program.py), run here over the wrapper's kwargs. It folds flat options
 * into the complex params of the generated command it invokes; the result is that
 * command's kwargs, which the Engine then binds to the request like any Generated command.
 */
import { basename } from "node:path";
import { decodePythonUtf8 } from "../utils/utf8.ts";
import type { TypedParam } from "./convert.ts";
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
 * What a program reads outside its kwargs: the config region `build_client` puts in
 * `ctx.obj['config']`, and the namespace `get_namespace()` returned.
 */
export type ProgramContext = {
  region?: () => string | undefined;
  namespace?: string;
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
  constructor(
    readonly mode: string,
    private readonly data?: Uint8Array,
    /** The path given on the command line (`-` for stdio), when the file came from one. */
    readonly name?: string,
  ) {}

  /** The same file, unread: each run of a program opens its files afresh. */
  reopen(): ProgramFile {
    return new ProgramFile(this.mode, this.data, this.name);
  }

  get binary(): boolean {
    return this.mode.includes("b");
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
  !(v instanceof Error) &&
  !(v instanceof Uint8Array);

/** Python iteration: a list's items, a dict's keys, a str's characters, a file's lines. */
function iterate(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
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

/** Python `str()` of a scalar. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string" || typeof v === "number") return String(v);
  // `except Exception as e: ... str(e)`
  if (v instanceof ProgramRaise) return v.message;
  throw new ProgramUnsupported("str() of a container");
}

/** Python `str.format` with positional fields only (`{}`, `{0}`), no format specs. */
function pyFormat(template: string, args: unknown[]): string {
  let next = 0;
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}|[{}]/g, (m, field) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (field === undefined || !/^\d*$/.test(field))
      throw new ProgramUnsupported(`format field ${m}`);
    // Python refuses to mix automatic and manual numbering (a ValueError).
    if ((field === "") !== next >= 0 && next !== 0)
      throw new ProgramUnsupported("format numbering");
    const i = field === "" ? next++ : ((next = -1), Number(field));
    if (i >= args.length) throw new ProgramUnsupported("IndexError");
    return pyStr(args[i]);
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
  parse: (name: string, value: unknown) => unknown,
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
    kwargs[p.name] = v;
    if (values[p.name] === undefined) filled.set(p.name, v);
  }
  const env: Dict = { kwargs };
  let invoked: Dict | undefined;
  let target = 0;
  let asked = 0;
  const ctxObj = new ProgramObject("ctx.obj");

  const item = (obj: unknown, key: unknown): unknown => {
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
    if (isDict(obj)) {
      const key = args[0] as string;
      switch (method) {
        case "get":
          return key in obj ? obj[key] : (args[1] ?? null);
        case "pop":
          if (key in obj) {
            const v = obj[key];
            delete obj[key];
            return v;
          }
          if (args.length > 1) return args[1];
          throw new ProgramUnsupported(`KeyError: ${key}`);
        case "setdefault":
          if (!(key in obj)) obj[key] = args[1] ?? null;
          return obj[key];
        case "update":
          if (!isDict(args[0])) throw new ProgramUnsupported("update");
          Object.assign(obj, args[0]);
          return null;
        case "keys":
          if (args.length === 0) return Object.keys(obj);
          break;
        case "items":
          if (args.length === 0) return Object.entries(obj);
          break;
      }
    } else if (Array.isArray(obj) && method === "append") {
      obj.push(args[0]);
      return null;
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
      }
    } else if (obj instanceof ProgramFile && method === "read") {
      if (args.length === 0) return obj.read();
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
        if (isDict(b)) found = typeof a === "string" && a in b;
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
      case "parse":
        return parse(String(a), b);
      case "str":
        return pyStr(a);
      case "bool":
        return truthy(a);
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
      case "client": {
        // cli_util.build_client: ctx.obj['config'] is the config it built from.
        const region = context.region?.();
        if (region === undefined)
          throw new ProgramUnsupported("build_client without a region");
        ctxObj.fields.config = new ProgramObject("config", { region });
        return new ProgramObject(`${String(a)}.${String(b)}`);
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
        // isinstance(a, six.string_types)
        return typeof a === "string";
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
    return (conds ?? []).every((c) => truthy(evaluate(c)));
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
      case "call":
        return call(
          rest[0] as string,
          evaluate(rest[1] as Expr),
          rest.slice(2).map(evaluate),
        );
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
        return !truthy(evaluate(rest[0] as Expr));
      case "and": {
        let v: unknown = true;
        for (const part of rest) {
          v = evaluate(part);
          if (!truthy(v)) return v;
        }
        return v;
      }
      case "or": {
        let v: unknown = false;
        for (const part of rest) {
          v = evaluate(part);
          if (truthy(v)) return v;
        }
        return v;
      }
      case "cmp":
        return compare(
          rest[0] as string,
          evaluate(rest[1] as Expr),
          evaluate(rest[2] as Expr),
        );
      case "bin": {
        const a = evaluate(rest[1] as Expr);
        const b = evaluate(rest[2] as Expr);
        if (typeof a === "number" && typeof b === "number")
          return rest[0] === "+" ? a + b : a - b;
        if (rest[0] === "+" && typeof a === "string" && typeof b === "string")
          return a + b;
        throw new ProgramUnsupported(`TypeError: ${String(rest[0])}`);
      }
      case "ifexp":
        return truthy(evaluate(rest[0] as Expr))
          ? evaluate(rest[1] as Expr)
          : evaluate(rest[2] as Expr);
    }
    throw new ProgramUnsupported(`op ${op}`);
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
          if (isDict(obj) && typeof key === "string") obj[key] = value;
          else if (Array.isArray(obj) && typeof key === "number")
            obj[key < 0 ? obj.length + key : key] = value;
          else throw new ProgramUnsupported("item assignment");
          break;
        }
        case "del": {
          const obj = evaluate(rest[0] as Expr);
          const key = evaluate(rest[1] as Expr);
          if (!isDict(obj) || typeof key !== "string" || !(key in obj))
            throw new ProgramUnsupported(`KeyError: ${String(key)}`);
          delete obj[key];
          break;
        }
        case "do":
          evaluate(rest[0] as Expr);
          break;
        case "if":
          execute(
            (truthy(evaluate(rest[0] as Expr))
              ? rest[1]
              : rest[2]) as Statement[],
          );
          break;
        case "for":
          for (const x of iterate(evaluate(rest[1] as Expr))) {
            env[rest[0] as string] = x;
            execute(rest[2] as Statement[]);
          }
          break;
        case "try":
          try {
            execute(rest[0] as Statement[]);
          } catch (e) {
            // `except Exception`: what the Engine models as raised Python exceptions.
            if (!(e instanceof ProgramRaise)) throw e;
            if (rest[1] !== null) env[rest[1] as string] = e;
            execute(rest[2] as Statement[]);
          }
          break;
        case "abort":
          throw new ProgramAbort();
        case "usage":
          throw new ProgramUsageError(rest[0] as string);
        case "raise": {
          if (rest.length < 3) throw new ProgramUnsupported(rest[0] as string);
          const cls = rest[1] as string;
          const arg = pyStr(evaluate(rest[2] as Expr));
          // str(KeyError(x)) is repr(x).
          throw new ProgramRaise(cls, cls === "KeyError" ? pyRepr(arg) : arg);
        }
        case "invoke": {
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
          break;
        }
        default:
          throw new ProgramUnsupported(`statement ${op}`);
      }
    }
  };

  execute(program);
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

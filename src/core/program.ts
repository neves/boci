/**
 * A Tier B wrapper's body, compiled by the extractor to a small JSON program
 * (tools/extract/program.py), run here over the wrapper's kwargs. It folds flat options
 * into the complex params of the generated command it invokes; the result is that
 * command's kwargs, which the Engine then binds to the request like any Generated command.
 */
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

/** The wrapper took a path the Engine does not model (another exception, a TypeError). */
export class ProgramUnsupported extends Error {}

type Dict = Record<string, unknown>;

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
  ) {}

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
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
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
 * Runs `program` over the wrapper's converted option values (complex params already
 * parsed). `parse` is cli_util.parse_json_parameter.
 */
export function runProgram(
  program: Statement[],
  values: Dict,
  params: TypedParam[],
  parse: (name: string, value: unknown) => unknown,
): ProgramResult {
  // Click hands the callback every exposed param, unset ones at their default.
  const kwargs: Dict = {};
  const filled = new Map<string, unknown>();
  for (const p of params) {
    if ((p as { expose?: boolean }).expose === false) continue;
    const v = kwarg(p.name, values, params);
    kwargs[p.name] = v;
    if (values[p.name] === undefined) filled.set(p.name, v);
  }
  const env: Dict = { kwargs };
  let invoked: Dict | undefined;
  let target = 0;

  const item = (obj: unknown, key: unknown): unknown => {
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
          return new TextDecoder("utf-8", { fatal: true }).decode(obj);
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
      case "len":
        if (typeof a === "string" || Array.isArray(a)) return a.length;
        if (isDict(a)) return Object.keys(a).length;
        throw new ProgramUnsupported("len()");
    }
    throw new ProgramUnsupported(`${name}()`);
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
        const name = rest[1] as string;
        return iterate(evaluate(rest[0] as Expr)).map((x) => {
          env[name] = x;
          return evaluate(rest[2] as Expr);
        });
      }
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
          target = (rest[2] as number | undefined) ?? 0;
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

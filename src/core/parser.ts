// Port of Click 8.4's _OptionParser (click/parser.py) and Option.add_to_parser.
// Argument handling must match Click exactly, including on malformed input (ADR 0003).
import { getCloseMatches } from "../lib/difflib.ts";

export type ParamSpec = {
  kind: "option" | "argument";
  name: string;
  opts: string[];
  secondaryOpts: string[];
  multiple: boolean;
  count: boolean;
  nargs: number;
  isFlag: boolean;
  isBoolFlag?: boolean;
  flagNeedsValue?: boolean;
  flagValue?: unknown;
};

export type ParseSettings = {
  interspersed: boolean;
  ignoreUnknown: boolean;
  allowExtra: boolean;
};

export const UNSET = Symbol("UNSET");
export const FLAG_NEEDS_VALUE = Symbol("FLAG_NEEDS_VALUE");
export type Value =
  | string
  | boolean
  | number
  | unknown[]
  | typeof UNSET
  | typeof FLAG_NEEDS_VALUE
  | unknown;

export class UsageError extends Error {
  constructor(
    message: string,
    public type:
      "NoSuchOption" | "BadOptionUsage" | "BadArgumentUsage" | "UsageError",
    public option?: string,
  ) {
    super(message);
  }
}

const repr = (s: string) =>
  s.includes("'") && !s.includes('"')
    ? `"${s}"`
    : `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

function noSuchOption(
  opt: string,
  possibilities?: Iterable<string>,
): UsageError {
  let message = `No such option ${repr(opt)}.`;
  const close = possibilities ? getCloseMatches(opt, possibilities) : [];
  if (close.length) {
    const list = [...close].sort().map(repr).join(", ");
    message +=
      close.length === 1
        ? ` Did you mean ${list}?`
        : ` (Did you mean one of: ${list}?)`;
  }
  return new UsageError(message, "NoSuchOption", opt);
}

/** click.parser._split_opt */
export function splitOpt(opt: string): [string, string] {
  const first = opt.slice(0, 1);
  if (/^[\p{L}\p{N}]$/u.test(first)) return ["", opt];
  if (opt.slice(1, 2) === first) return [opt.slice(0, 2), opt.slice(2)];
  return [first, opt.slice(1)];
}

type Action =
  "store" | "store_const" | "append" | "append_const" | "count" | "count_const";

class Opt {
  shortOpts: string[] = [];
  longOpts: string[] = [];
  prefixes = new Set<string>();
  constructor(
    public param: ParamSpec,
    opts: string[],
    public action: Action,
    public nargs = 1,
    public constValue: unknown = undefined,
  ) {
    for (const opt of opts) {
      const [prefix, value] = splitOpt(opt);
      if (!prefix)
        throw new Error(`Invalid start character for option (${opt})`);
      this.prefixes.add(prefix[0] as string);
      if (prefix.length === 1 && [...value].length === 1)
        this.shortOpts.push(opt);
      else {
        this.longOpts.push(opt);
        this.prefixes.add(prefix);
      }
    }
  }
  get takesValue() {
    return this.action === "store" || this.action === "append";
  }
  process(value: Value, state: State) {
    const dest = this.param.name;
    switch (this.action) {
      case "store":
        state.opts[dest] = value;
        break;
      case "store_const":
        state.opts[dest] = this.constValue;
        break;
      case "append":
        ((state.opts[dest] ??= []) as unknown[]).push(value);
        break;
      case "append_const":
        ((state.opts[dest] ??= []) as unknown[]).push(this.constValue);
        break;
      case "count":
        state.opts[dest] = ((state.opts[dest] as number | undefined) ?? 0) + 1;
        break;
      default:
        throw new Error(`unknown action '${this.action}'`);
    }
    state.order.push(this.param);
  }
}

type State = {
  opts: Record<string, Value>;
  largs: string[];
  rargs: string[];
  order: ParamSpec[];
};

export type ParseResult = {
  opts: Record<string, Value>;
  args: string[];
  order: ParamSpec[];
};

export class OptionParser {
  private shortOpt = new Map<string, Opt>();
  private longOpt = new Map<string, Opt>();
  private optPrefixes = new Set(["-", "--"]);
  private args: ParamSpec[] = [];

  constructor(
    params: ParamSpec[],
    private settings: Pick<ParseSettings, "interspersed" | "ignoreUnknown">,
  ) {
    for (const p of params) this.add(p);
  }

  /** click.core.Option.add_to_parser / Argument.add_to_parser */
  private add(p: ParamSpec) {
    if (p.kind === "argument") {
      this.args.push(p);
      return;
    }
    let action: Action = p.multiple ? "append" : p.count ? "count" : "store";
    if (p.isFlag) {
      action = `${action}_const` as Action;
      if (p.isBoolFlag && p.secondaryOpts.length) {
        this.addOption(new Opt(p, p.opts, action, 1, true));
        this.addOption(new Opt(p, p.secondaryOpts, action, 1, false));
      } else {
        this.addOption(
          new Opt(p, p.opts, action, 1, "flagValue" in p ? p.flagValue : true),
        );
      }
    } else this.addOption(new Opt(p, p.opts, action, p.nargs));
  }

  private addOption(o: Opt) {
    for (const prefix of o.prefixes) this.optPrefixes.add(prefix);
    for (const s of o.shortOpts) this.shortOpt.set(s, o);
    for (const l of o.longOpts) this.longOpt.set(l, o);
  }

  parse(argv: string[]): ParseResult {
    const state: State = { opts: {}, largs: [], rargs: [...argv], order: [] };
    this.processArgsForOptions(state);
    this.processArgsForArgs(state);
    return { opts: state.opts, args: state.largs, order: state.order };
  }

  private processArgsForArgs(state: State) {
    const [pargs, rest] = unpackArgs(
      [...state.largs, ...state.rargs],
      this.args.map((a) => a.nargs),
    );
    this.args.forEach((arg, idx) => {
      let value = pargs[idx] as Value;
      if (arg.nargs > 1 && Array.isArray(value)) {
        const holes = value.filter((x) => x === UNSET).length;
        if (holes === value.length) value = UNSET;
        else if (holes !== 0)
          throw new UsageError(
            `Argument ${repr(arg.name)} takes ${arg.nargs} values.`,
            "BadArgumentUsage",
          );
      }
      if (Array.isArray(value) && value.length === 0) value = UNSET;
      state.opts[arg.name] = value;
      state.order.push(arg);
    });
    state.largs = rest;
    state.rargs = [];
  }

  private processArgsForOptions(state: State) {
    while (state.rargs.length) {
      const arg = state.rargs.shift() as string;
      if (arg === "--") return;
      if (this.optPrefixes.has(arg.slice(0, 1)) && [...arg].length > 1)
        this.processOpts(arg, state);
      else if (this.settings.interspersed) state.largs.push(arg);
      else {
        state.rargs.unshift(arg);
        return;
      }
    }
  }

  private matchLongOpt(opt: string, explicit: string | null, state: State) {
    const option = this.longOpt.get(opt);
    if (!option) throw noSuchOption(opt, this.longOpt.keys());
    let value: Value;
    if (option.takesValue) {
      if (explicit !== null) state.rargs.unshift(explicit);
      value = this.valueFromState(opt, option, state);
    } else if (explicit !== null) {
      throw new UsageError(
        `Option ${repr(opt)} does not take a value.`,
        "BadOptionUsage",
        opt,
      );
    } else value = UNSET;
    option.process(value, state);
  }

  private matchShortOpt(arg: string, state: State) {
    let stop = false;
    let i = 1;
    const chars = [...arg];
    const prefix = chars[0] as string;
    const unknown: string[] = [];
    for (const ch of chars.slice(1)) {
      const opt = `${prefix}${ch}`;
      const option = this.shortOpt.get(opt);
      i++;
      if (!option) {
        if (this.settings.ignoreUnknown) {
          unknown.push(ch);
          continue;
        }
        throw noSuchOption(opt);
      }
      let value: Value;
      if (option.takesValue) {
        if (i < chars.length) {
          state.rargs.unshift(chars.slice(i).join(""));
          stop = true;
        }
        value = this.valueFromState(opt, option, state);
      } else value = UNSET;
      option.process(value, state);
      if (stop) break;
    }
    if (this.settings.ignoreUnknown && unknown.length)
      state.largs.push(`${prefix}${unknown.join("")}`);
  }

  private valueFromState(name: string, option: Opt, state: State): Value {
    const nargs = option.nargs;
    if (state.rargs.length < nargs) {
      if (option.param.flagNeedsValue) return FLAG_NEEDS_VALUE;
      throw new UsageError(
        nargs === 1
          ? `Option ${repr(name)} requires an argument.`
          : `Option ${repr(name)} requires ${nargs} arguments.`,
        "BadOptionUsage",
        name,
      );
    }
    if (nargs === 1) {
      const next = state.rargs[0] as string;
      if (
        option.param.flagNeedsValue &&
        this.optPrefixes.has(next.slice(0, 1)) &&
        [...next].length > 1
      ) {
        return FLAG_NEEDS_VALUE;
      }
      return state.rargs.shift() as string;
    }
    return state.rargs.splice(0, nargs);
  }

  private processOpts(arg: string, state: State) {
    const eq = arg.indexOf("=");
    const longOpt = eq === -1 ? arg : arg.slice(0, eq);
    const explicit = eq === -1 ? null : arg.slice(eq + 1);
    try {
      this.matchLongOpt(longOpt, explicit, state);
    } catch (e) {
      if (!(e instanceof UsageError) || e.type !== "NoSuchOption") throw e;
      if (!this.optPrefixes.has(arg.slice(0, 2))) {
        this.matchShortOpt(arg, state);
        return;
      }
      if (!this.settings.ignoreUnknown) throw e;
      state.largs.push(arg);
    }
  }
}

/** click.parser._unpack_args */
function unpackArgs(args: string[], nargsSpec: number[]): [Value[], string[]] {
  const rest = [...args];
  const spec = [...nargsSpec];
  const rv: Value[] = [];
  let spos: number | null = null;
  const fetch = () =>
    (rest.length
      ? spos === null
        ? rest.shift()
        : rest.pop()
      : UNSET) as Value;
  while (spec.length) {
    const nargs = (spos === null ? spec.shift() : spec.pop()) as number;
    if (nargs === 1) rv.push(fetch());
    else if (nargs > 1) {
      const x = Array.from({ length: nargs }, fetch);
      if (spos !== null) x.reverse();
      rv.push(x);
    } else if (nargs < 0) {
      if (spos !== null) throw new TypeError("Cannot have two nargs < 0");
      spos = rv.length;
      rv.push(UNSET);
    }
  }
  if (spos !== null) {
    rv[spos] = [...rest];
    rest.length = 0;
    const tail = rv.splice(spos + 1).reverse();
    rv.push(...tail);
  }
  return [rv, rest];
}

// Click (8.4) and oci type conversion with the exact error messages, so invalid values
// fail like the Reference CLI. Values from the command line only; defaults are trusted.
import type { ParamSpec } from "./parser.ts";

export type TypedParam = ParamSpec & {
  type: string;
  typeClass: string;
  required?: boolean;
  choices?: string[];
  caseSensitive?: boolean;
  range?: {
    min: number | null;
    max: number | null;
    minOpen: boolean;
    maxOpen: boolean;
    clamp: boolean;
  };
  datetimeRounding?: string | null;
};

export type DatetimeSpec = {
  formats: { format: string; regex: string; timezone: string | null }[];
  message: string;
};

/** Raised for click.BadParameter: shown as "Invalid value for <hint>: <message>". */
export class BadParameter extends Error {}

/** Python repr() of a str. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === "\\") body += "\\\\";
    else if (ch === quote) body += `\\${quote}`;
    else if (ch === "\n") body += "\\n";
    else if (ch === "\r") body += "\\r";
    else if (ch === "\t") body += "\\t";
    else if (c < 0x20 || c === 0x7f)
      body += `\\x${c.toString(16).padStart(2, "0")}`;
    else body += ch;
  }
  return `${quote}${body}${quote}`;
}

const PY_WS =
  "[ \\t\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*";
const INT_RE = new RegExp(`^${PY_WS}([+-]?)(\\d+(?:_\\d+)*)${PY_WS}$`);
const FLOAT_RE = new RegExp(
  `^${PY_WS}([+-]?(?:(?:\\d+(?:_\\d+)*)?\\.?\\d+(?:_\\d+)*(?:[eE][+-]?\\d+(?:_\\d+)*)?|\\d+(?:_\\d+)*\\.(?:[eE][+-]?\\d+(?:_\\d+)*)?|inf(?:inity)?|nan))${PY_WS}$`,
  "i",
);

const BOOL_STATES: Record<string, boolean> = {
  "1": true,
  "0": false,
  yes: true,
  no: false,
  true: true,
  false: false,
  on: true,
  off: false,
  t: true,
  f: false,
  y: true,
  n: false,
  "": false,
};

/** Python float → str for range messages (int stays int). */
const pyNum = (n: number) => String(n);

/** The hint Click puts in "Invalid value for ...": every opt quoted, " / "-joined. */
export const errorHint = (p: ParamSpec) =>
  p.opts.map((o) => `'${o}'`).join(" / ");

export function convert(
  p: TypedParam,
  value: unknown,
  datetime?: DatetimeSpec,
): unknown {
  if (p.multiple && Array.isArray(value))
    return value.map((v) => convertOne(p, v, datetime));
  return convertOne(p, value, datetime);
}

function convertOne(
  p: TypedParam,
  value: unknown,
  datetime?: DatetimeSpec,
): unknown {
  if (typeof value !== "string") return value; // flag constants (True/False/flag_value)
  switch (p.typeClass) {
    case "click.types.IntParamType":
      return toInt(value);
    case "click.types.IntRange":
      return inRange(p, toInt(value));
    case "click.types.FloatParamType":
      return toFloat(value);
    case "click.types.FloatRange":
      return inRange(p, toFloat(value));
    case "click.types.BoolParamType": {
      const b = BOOL_STATES[value.trim().toLowerCase()];
      if (b === undefined) {
        throw new BadParameter(
          `${pyRepr(value)} is not a valid boolean. Recognized values: ${Object.keys(BOOL_STATES).sort().join(", ")}`,
        );
      }
      return b;
    }
    case "click.types.Choice":
      return clickChoice(p, value);
    case "oci_cli.custom_types.cli_case_insensitive_choice.CliCaseInsensitiveChoice":
      return ciChoice(p, value);
    case "oci_cli.custom_types.cli_datetime.CliDatetime":
      return toDatetime(p, value, datetime);
    default:
      return value; // text, complex type (JSON parsed later), from-json, file, path
  }
}

function toInt(value: string): number {
  const m = INT_RE.exec(value);
  if (!m) throw new BadParameter(`${pyRepr(value)} is not a valid integer.`);
  return Number(`${m[1]}${(m[2] as string).replaceAll("_", "")}`);
}

function toFloat(value: string): number {
  const m = FLOAT_RE.exec(value);
  if (!m) throw new BadParameter(`${pyRepr(value)} is not a valid float.`);
  const t = (m[1] as string).replaceAll("_", "").toLowerCase();
  if (t.endsWith("inf") || t.endsWith("infinity"))
    return t.startsWith("-") ? -Infinity : Infinity;
  if (t.endsWith("nan")) return Number.NaN;
  return Number(t);
}

function inRange(p: TypedParam, rv: number): number {
  const r = p.range;
  if (!r) return rv;
  const ltMin = r.min !== null && (r.minOpen ? rv <= r.min : rv < r.min);
  const gtMax = r.max !== null && (r.maxOpen ? rv >= r.max : rv > r.max);
  if (r.clamp) {
    if (r.min !== null && ltMin) return r.minOpen ? r.min + 1 : r.min;
    if (r.max !== null && gtMax) return r.maxOpen ? r.max - 1 : r.max;
  }
  if (ltMin || gtMax) {
    let desc: string;
    if (r.min === null)
      desc = `x${r.maxOpen ? "<" : "<="}${pyNum(r.max as number)}`;
    else if (r.max === null) desc = `x${r.minOpen ? ">" : ">="}${pyNum(r.min)}`;
    else
      desc = `${pyNum(r.min)}${r.minOpen ? "<" : "<="}x${r.maxOpen ? "<" : "<="}${pyNum(r.max)}`;
    throw new BadParameter(`${pyNum(rv)} is not in the range ${desc}.`);
  }
  return rv;
}

function clickChoice(p: TypedParam, value: string): string {
  const fold = (s: string) => (p.caseSensitive === false ? s.toLowerCase() : s);
  const choices = p.choices ?? [];
  const hit = choices.find((c) => fold(c) === fold(value));
  if (hit !== undefined) return hit;
  const list = choices.map((c) => pyRepr(fold(c))).join(", ");
  throw new BadParameter(
    choices.length === 1
      ? `${pyRepr(value)} is not ${list}.`
      : `${pyRepr(value)} is not one of ${list}.`,
  );
}

function ciChoice(p: TypedParam, value: string): string {
  const choices = p.choices ?? [];
  if (choices.includes(value)) return value;
  const hit = choices.find((c) => c.toLowerCase() === value.toLowerCase());
  if (hit !== undefined) return hit;
  throw new BadParameter(
    `invalid choice: ${value}. (choose from ${choices.join(", ")})`,
  );
}

// ---------------------------------------------------------------- datetime

/** oci_cli.custom_types.cli_datetime.CliDatetime.convert → RFC 3339 UTC with microseconds. */
function toDatetime(p: TypedParam, value: string, spec?: DatetimeSpec): string {
  if (!spec) throw new Error("boci: datetime spec missing");
  let utcMicros: bigint;
  if (/^\p{Nd}+$/u.test(value)) {
    // arrow.get(value, 'X'): its timestamp pattern needs at least two digits. Past
    // datetime's year 9999 oci crashes with an OverflowError (see DIVERGENCES.md);
    // boci reports it as the same invalid-Unix-time error instead.
    const MAX_SECONDS = 253402300799n;
    if (!/^\d{2,}$/.test(value) || BigInt(value) > MAX_SECONDS) {
      throw new BadParameter(
        `Value ${value} is not a value Unix time. ${spec.message}`,
      );
    }
    utcMicros = BigInt(value) * 1_000_000n;
  } else {
    const v = value.trim().replaceAll(" ", "T");
    const fmt = spec.formats.find((f) => new RegExp(f.regex).test(v));
    if (!fmt)
      throw new BadParameter(
        `Value ${value} is not in a supported datetime format. ${spec.message}`,
      );
    utcMicros = parseFormatted(v);
  }
  if (p.datetimeRounding === "minute") {
    const minute = 60_000_000n;
    const seconds = (((utcMicros % minute) + minute) % minute) / 1_000_000n;
    utcMicros =
      utcMicros -
      (((utcMicros % minute) + minute) % minute) +
      (seconds >= 30n ? minute : 0n);
  }
  return formatUtc(utcMicros);
}

/** Every oci format is YYYY-MM-DD[THH:mm[:ss[.f{1,6}]]][Z | ±HH:MM | ±HHMM]; naive means UTC. */
function parseFormatted(v: string): bigint {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?)?([Zz]|[+\-|]\d{2}:?\d{2})?$/.exec(
      v,
    );
  if (!m)
    throw new BadParameter(`Value ${v} is not in a supported datetime format.`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", tz] = m;
  const micros = BigInt(frac.padEnd(6, "0") || "0");
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  let total = BigInt(ms) * 1000n + micros;
  if (tz && tz.toUpperCase() !== "Z") {
    const sign = tz.startsWith("-") ? -1n : 1n;
    const digits = tz.slice(1).replace(":", "");
    const offset =
      (BigInt(digits.slice(0, 2)) * 60n + BigInt(digits.slice(2, 4))) *
      60_000_000n;
    total -= sign * offset;
  }
  return total;
}

function formatUtc(micros: bigint): string {
  const ms = Number(micros / 1000n);
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const us = Number(((micros % 1_000_000n) + 1_000_000n) % 1_000_000n);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(us, 6)}Z`;
}

/** click.core.iter_params_for_processing: eager first, then invocation order, then declaration. */
export function processingOrder<T extends ParamSpec & { eager?: boolean }>(
  order: ParamSpec[],
  params: T[],
): T[] {
  const firstSeen = new Map<string, number>();
  order.forEach((p, i) => {
    if (!firstSeen.has(p.name)) firstSeen.set(p.name, i);
  });
  return params
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ea = a.p.eager ? 0 : 1;
      const eb = b.p.eager ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ia = firstSeen.get(a.p.name) ?? Number.POSITIVE_INFINITY;
      const ib = firstSeen.get(b.p.name) ?? Number.POSITIVE_INFINITY;
      return ia === ib ? a.i - b.i : ia - ib;
    })
    .map(({ p }) => p);
}

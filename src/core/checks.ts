/**
 * A wrapper's argument checks (`if ...: raise click.UsageError(msg)`), compiled by the
 * extractor to a small predicate set (tools/extract/checks.py) and evaluated here over
 * the converted option values, before any JSON parsing or request.
 */
import type { TypedParam } from "./convert.ts";

export type Predicate =
  | boolean
  | { truthy: string }
  | { none: string }
  | { eq: [string, string] }
  | { lowerEq: [string, string] }
  | { not: Predicate }
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { same: [Predicate, Predicate] }
  | { countGt: [string[], number] };

export type UsageCheck = { test: Predicate; message: string };

/** What Click hands the callback for an option the command line left out. */
export function kwarg(
  name: string,
  values: Record<string, unknown>,
  params: TypedParam[],
): unknown {
  const value = values[name];
  if (value !== undefined) return value;
  const param = params.find((p) => p.name === name);
  if (param?.multiple) {
    if ((param as { callback?: string }).callback === "oci-default") {
      return param.default ?? null;
    }
    return [];
  }
  if (param?.isFlag) return param.default ?? false;
  return param?.default ?? null;
}

/** Python truthiness. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** Python `str(value)`, for the values a check compares. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function holds(
  test: Predicate,
  values: Record<string, unknown>,
  params: TypedParam[],
): boolean {
  const read = (name: string) => kwarg(name, values, params);
  if (typeof test === "boolean") return test;
  if ("truthy" in test) return truthy(read(test.truthy));
  if ("none" in test) return read(test.none) === null;
  if ("eq" in test) return read(test.eq[0]) === test.eq[1];
  if ("lowerEq" in test)
    return pyStr(read(test.lowerEq[0])).toLowerCase() === test.lowerEq[1];
  if ("not" in test) return !holds(test.not, values, params);
  if ("and" in test) return test.and.every((p) => holds(p, values, params));
  if ("or" in test) return test.or.some((p) => holds(p, values, params));
  if ("countGt" in test) {
    const [names, n] = test.countGt;
    return names.filter((name) => read(name) !== null).length > n;
  }
  return (
    holds(test.same[0], values, params) === holds(test.same[1], values, params)
  );
}

/** The message of the first check that fires, in source order. */
export function failingCheck(
  checks: UsageCheck[] | undefined,
  values: Record<string, unknown>,
  params: TypedParam[],
): string | undefined {
  return checks?.find((c) => holds(c.test, values, params))?.message;
}

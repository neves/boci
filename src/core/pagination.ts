// Pagination helpers matching `oci_cli.cli_util.list_call_get_all_results`,
// `list_call_get_up_to_limit`, and their `*_multiple_keys` variants.
import { truthy } from "./checks.ts";
import { inheritedDiscriminator, type Models } from "./camelize.ts";
import type { OperationResult } from "./operation.ts";
import { ModelDeserializationError, renderModel } from "./output.ts";
import {
  modelAttr,
  ProgramRaise,
  ProgramResponse,
  ProgramUnsupported,
  tagModelData,
  type ProgramSdkOutcome,
} from "./program.ts";

export class PythonTypeError extends Error {}

export type CollectionAttribute = {
  snake: string;
  key: string;
  wire: string;
  type?: string;
};

/**
 * A collection model's attributes as Python iterates them: sorted snake_case names,
 * aggregated under dashed keys. Without the model in the spec, the response's own keys.
 */
export function collectionAttributes(
  result: OperationResult,
  data: Record<string, unknown>,
): CollectionAttribute[] {
  const models = result.responseModels;
  let model = models?.[result.operation.responseType ?? ""];
  if (model && models) {
    const disc = inheritedDiscriminator(models, model);
    if (disc && typeof disc !== "string") {
      if (!Object.hasOwn(data, disc.field)) {
        throw new ProgramRaise("KeyError", `'${disc.field}'`);
      }
      const key = data[disc.field];
      const subtype =
        typeof key === "string" && Object.hasOwn(disc.values, key)
          ? disc.values[key]
          : disc.fallback;
      model = models[subtype!] ?? model;
    }
  }
  const attributes = model
    ? model.attributes.map(([snake, type, wire]) => ({ snake, wire, type }))
    : Object.keys(data).map((wire) => ({
        snake: wire.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        wire,
        type: undefined,
      }));
  return attributes
    .map((a) => ({ ...a, key: a.snake.replaceAll("_", "-") }))
    .sort((a, b) => (a.snake < b.snake ? -1 : a.snake > b.snake ? 1 : 0));
}

/** Python's len() of a deserialized attribute value. */
export function pyLen(value: unknown, type?: string): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string" && type !== "datetime" && type !== "date")
    return [...value].length;
  if (
    typeof value === "object" &&
    value !== null &&
    (type === undefined || type.startsWith("dict("))
  )
    return Object.keys(value).length;
  const name =
    value === null || value === undefined
      ? "NoneType"
      : typeof value === "boolean"
        ? "bool"
        : typeof value === "number"
          ? type === "float" || (type !== "int" && !Number.isInteger(value))
            ? "float"
            : "int"
          : type === "datetime" || type === "date"
            ? `datetime.${type}`
            : (type ?? "object");
  throw new PythonTypeError(`object of type '${name}' has no len()`);
}

/** itertools.chain.from_iterable over the values one attribute had on each page. */
export function pyChain(values: unknown[]): unknown[] {
  return values.flatMap((v) =>
    Array.isArray(v)
      ? v
      : typeof v === "string"
        ? [...v]
        : typeof v === "object" && v !== null
          ? Object.keys(v)
          : [],
  );
}

export type ListCallMode = "all" | "limit";

export type PaginateSdkListOptions = {
  mode: ListCallMode;
  multipleKeys: boolean;
  recordLimit?: unknown;
  pageSize?: unknown;
  kwArgs: Record<string, unknown>;
  fetchPage: (kwArgs: Record<string, unknown>) => Promise<ProgramSdkOutcome>;
};

type AggEntry =
  | { isList: true; pages: unknown[]; type?: string }
  | { isList: false; value: unknown; type?: string };

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getAttributeValue(
  data: Record<string, unknown>,
  attr: CollectionAttribute,
  models?: Models[string],
): unknown {
  const value = Object.hasOwn(data, attr.wire)
    ? data[attr.wire]
    : Object.hasOwn(data, attr.snake)
      ? data[attr.snake]
      : null;
  if (value !== null && value !== undefined) {
    tagModelData(value, models, attr.type);
  }
  return value;
}

function renderCollectionField(
  value: unknown,
  type: string | undefined,
  models?: Models[string],
): unknown {
  if (!type) return value;
  try {
    return renderModel(value, type, models);
  } catch (e) {
    if (e instanceof ModelDeserializationError) {
      throw new ProgramRaise(e.pythonType, e.message);
    }
    throw e;
  }
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

function sortListItems(
  items: unknown[],
  attr: "display_name" | "time_created",
  reverse: boolean,
): unknown[] {
  const keyed = items.map((item, idx) => {
    if (!isPlainRecord(item)) {
      throw new ProgramRaise(
        "AttributeError",
        `'${pyTypeName(item)}' object has no attribute '${attr}'`,
      );
    }
    const val = modelAttr(item, attr);
    if (attr === "time_created") {
      if (val === null || val === undefined) {
        return { item, idx, ms: Number.NEGATIVE_INFINITY, str: "" };
      }
      const str = String(val);
      const ms = Date.parse(str);
      return {
        item,
        idx,
        ms: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms,
        str,
      };
    }
    return {
      item,
      idx,
      ms: 0,
      str: val === null || val === undefined ? "" : String(val),
    };
  });
  keyed.sort((a, b) => {
    let cmp = 0;
    if (attr === "time_created") {
      cmp = a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0;
      if (cmp === 0) cmp = a.str < b.str ? -1 : a.str > b.str ? 1 : 0;
    } else {
      cmp = a.str < b.str ? -1 : a.str > b.str ? 1 : 0;
    }
    if (cmp !== 0) return reverse ? -cmp : cmp;
    return a.idx - b.idx;
  });
  return keyed.map((k) => k.item);
}

function appendPageValue(
  dict: Map<string, AggEntry>,
  attr: CollectionAttribute,
  value: unknown,
): void {
  const existing = dict.get(attr.key);
  if (existing === undefined) {
    dict.set(attr.key, { isList: true, pages: [value], type: attr.type });
  } else if (existing.isList) {
    existing.pages.push(value);
  } else {
    throw new ProgramRaise(
      "AttributeError",
      `'${pyTypeName(existing.value)}' object has no attribute 'append'`,
    );
  }
}

function makeAggregatedResponse(
  last: ProgramResponse,
  data: unknown,
): ProgramResponse {
  return new ProgramResponse(
    last.result,
    data,
    last.call,
    last.result.response.headers,
    true,
  );
}

/**
 * Execute `cli_util.list_call_get_all_results[_multiple_keys]` or
 * `cli_util.list_call_get_up_to_limit[_multiple_keys]` over an SDK list operation.
 */
export async function paginateSdkList(
  opts: PaginateSdkListOptions,
): Promise<ProgramSdkOutcome> {
  const { mode, multipleKeys, recordLimit, pageSize, fetchPage } = opts;
  const funcKwargs: Record<string, unknown> = { ...opts.kwArgs };

  if (mode === "limit") {
    if (recordLimit === null || recordLimit === undefined) {
      return fetchPage(funcKwargs);
    }
    if (typeof recordLimit !== "number") {
      throw new ProgramUnsupported("list_call_get_up_to_limit record_limit");
    }
    let keepPaginating = true;
    let remaining = recordLimit;
    let fetchedAtLeastOnce = false;
    let callResult: ProgramResponse | null = null;
    const aggregated: unknown[] = [];
    const aggregatedDict = new Map<string, AggEntry>();
    let wrappedArrayPagination = false;

    while (keepPaginating && (remaining > 0 || !fetchedAtLeastOnce)) {
      fetchedAtLeastOnce = true;

      if (truthy(pageSize)) {
        if (typeof pageSize !== "number") {
          throw new ProgramUnsupported("list_call_get_up_to_limit page_size");
        }
        funcKwargs.limit = Math.min(pageSize, remaining);
      } else if ("limit" in funcKwargs) {
        if (typeof funcKwargs.limit !== "number") {
          throw new ProgramUnsupported("list_call_get_up_to_limit limit");
        }
        funcKwargs.limit = Math.min(funcKwargs.limit, remaining);
      }

      const outcome = await fetchPage({ ...funcKwargs });
      if (!(outcome instanceof ProgramResponse)) return outcome;
      callResult = outcome;

      if (!Array.isArray(callResult.data)) {
        if (!isPlainRecord(callResult.data)) {
          return new ProgramRaise(
            "AttributeError",
            `'${pyTypeName(callResult.data)}' object has no attribute 'attribute_map'`,
          );
        }
        wrappedArrayPagination = true;
        const attrs = collectionAttributes(callResult.result, callResult.data);
        for (const attr of attrs) {
          const val = getAttributeValue(
            callResult.data,
            attr,
            callResult.result.responseModels,
          );
          if (multipleKeys) {
            if (Array.isArray(val)) {
              try {
                appendPageValue(aggregatedDict, attr, val);
              } catch (e) {
                if (e instanceof ProgramRaise) return e;
                throw e;
              }
              remaining -= val.length;
            } else {
              aggregatedDict.set(attr.key, {
                isList: false,
                value: val,
                type: attr.type,
              });
            }
          } else {
            try {
              appendPageValue(aggregatedDict, attr, val);
              remaining -= pyLen(val, attr.type);
            } catch (e) {
              if (e instanceof PythonTypeError) {
                return new ProgramRaise("TypeError", e.message);
              }
              if (e instanceof ProgramRaise) return e;
              throw e;
            }
          }
        }
      } else {
        aggregated.push(...callResult.data);
        remaining -= callResult.data.length;
      }

      const nextPage = callResult.headers.get("opc-next-page");
      if (nextPage !== undefined) funcKwargs.page = nextPage;
      keepPaginating = nextPage !== undefined;
    }

    if (!callResult) {
      throw new ProgramUnsupported("list_call_get_up_to_limit no response");
    }

    if (wrappedArrayPagination) {
      const finalData: Record<string, unknown> = {};
      let limitItems = recordLimit;
      const keys = [...aggregatedDict.keys()].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const key of keys) {
        const entry = aggregatedDict.get(key)!;
        if (!multipleKeys || entry.isList) {
          if (limitItems > 0) {
            const chained = pyChain(entry.isList ? entry.pages : [entry.value]);
            const sliced = chained.slice(0, limitItems);
            limitItems -= sliced.length;
            finalData[key] = renderCollectionField(
              sliced,
              entry.type,
              callResult.result.responseModels,
            );
          }
        } else {
          finalData[key] = renderCollectionField(
            entry.value,
            entry.type,
            callResult.result.responseModels,
          );
        }
      }
      return makeAggregatedResponse(callResult, finalData);
    }

    return makeAggregatedResponse(callResult, aggregated.slice(0, recordLimit));
  }

  // mode === "all"
  let keepPaginating = true;
  let callResult: ProgramResponse | null = null;
  const aggregated: unknown[] = [];
  const aggregatedDict = new Map<string, AggEntry>();
  let wrappedArrayPagination = false;

  while (keepPaginating) {
    const outcome = await fetchPage({ ...funcKwargs });
    if (!(outcome instanceof ProgramResponse)) return outcome;
    callResult = outcome;

    if (!Array.isArray(callResult.data)) {
      if (!isPlainRecord(callResult.data)) {
        return new ProgramRaise(
          "AttributeError",
          `'${pyTypeName(callResult.data)}' object has no attribute 'attribute_map'`,
        );
      }
      wrappedArrayPagination = true;
      const attrs = collectionAttributes(callResult.result, callResult.data);
      for (const attr of attrs) {
        const val = getAttributeValue(
          callResult.data,
          attr,
          callResult.result.responseModels,
        );
        if (Array.isArray(val)) {
          try {
            appendPageValue(aggregatedDict, attr, val);
          } catch (e) {
            if (e instanceof ProgramRaise) return e;
            throw e;
          }
        } else if (multipleKeys) {
          aggregatedDict.set(attr.key, {
            isList: false,
            value: val,
            type: attr.type,
          });
        }
      }
    } else {
      aggregated.push(...callResult.data);
    }

    const nextPage = callResult.headers.get("opc-next-page");
    if (nextPage !== undefined) funcKwargs.page = nextPage;
    keepPaginating = nextPage !== undefined;
  }

  if (!callResult) {
    throw new ProgramUnsupported("list_call_get_all_results no response");
  }

  if (wrappedArrayPagination) {
    const finalData: Record<string, unknown> = {};
    for (const [key, entry] of aggregatedDict.entries()) {
      if (entry.isList) {
        finalData[key] = renderCollectionField(
          pyChain(entry.pages),
          entry.type,
          callResult.result.responseModels,
        );
      } else {
        finalData[key] = renderCollectionField(
          entry.value,
          entry.type,
          callResult.result.responseModels,
        );
      }
    }
    return makeAggregatedResponse(callResult, finalData);
  }

  let postProcessed = aggregated;
  if ("sort_by" in funcKwargs && funcKwargs.sort_by !== undefined) {
    if (typeof funcKwargs.sort_by !== "string") {
      return new ProgramRaise(
        "AttributeError",
        `'${pyTypeName(funcKwargs.sort_by)}' object has no attribute 'upper'`,
      );
    }
    const sortBy = funcKwargs.sort_by.toUpperCase();
    try {
      if (sortBy === "DISPLAYNAME") {
        let sortDirection = "ASC";
        if ("sort_order" in funcKwargs && funcKwargs.sort_order !== undefined) {
          if (typeof funcKwargs.sort_order !== "string") {
            return new ProgramRaise(
              "AttributeError",
              `'${pyTypeName(funcKwargs.sort_order)}' object has no attribute 'upper'`,
            );
          }
          sortDirection = funcKwargs.sort_order.toUpperCase();
        }
        postProcessed = sortListItems(
          aggregated,
          "display_name",
          sortDirection === "DESC",
        );
      } else if (sortBy === "TIMECREATED") {
        // Matches oci-cli 3.96.3 indentation: TIMECREATED only re-sorts when sort_order is present.
        if ("sort_order" in funcKwargs && funcKwargs.sort_order !== undefined) {
          if (typeof funcKwargs.sort_order !== "string") {
            return new ProgramRaise(
              "AttributeError",
              `'${pyTypeName(funcKwargs.sort_order)}' object has no attribute 'upper'`,
            );
          }
          const sortDirection = funcKwargs.sort_order.toUpperCase();
          postProcessed = sortListItems(
            aggregated,
            "time_created",
            sortDirection === "DESC",
          );
        }
      }
    } catch (e) {
      if (e instanceof ProgramRaise) return e;
      throw e;
    }
  }

  return makeAggregatedResponse(callResult, postProcessed);
}

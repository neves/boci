// cli_util.make_dict_keys_camel_case: the keys of JSON given to a complex param, renamed
// the way parse_json_parameter renames them, by the param's declared type (ticket 19).

/** An SDK model: its attributes in attribute_map order, and how it picks a subtype. */
export type Model = {
  /** [snake_case name, swagger type, attribute_map (camelCase) name] */
  attributes: [string, string, string][];
  /** get_subtype's discriminator, or the name of the class that defines it. */
  discriminator?:
    | string
    | { field: string; values: Record<string, string>; fallback: string };
};

/** SDK models by module, then class name (MODULE_TO_TYPE_MAPPINGS, as far as reached). */
export type Models = Record<string, Record<string, Model>>;

/**
 * What the command parsing a param declares: input_params_to_complex_types as
 * `{param: "module:class"}`, and the service's models.
 */
export type KeyTypes = {
  complexTypes?: Record<string, string>;
  models?: Models;
};

/** A key get_subtype reads that the payload lacks: Python's KeyError. */
export class MissingDiscriminator extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

type TypeDef = { module: string; cls: string };

/** oci_cli.string_utils.camelize (lower first letter). */
export function camelize(s: string): string {
  if (!s) return "";
  const upper = s.replace(/(?:^|[_-])([^\n])/g, (_, c: string) =>
    c.toUpperCase(),
  );
  return (s[0] as string).toLowerCase() + upper.slice(1);
}

function lookup(keys: KeyTypes, name: string | undefined): TypeDef | undefined {
  if (name === undefined || !keys.complexTypes) return undefined;
  const wanted = camelize(name);
  for (const [param, type] of Object.entries(keys.complexTypes)) {
    if (camelize(param) === wanted) {
      const at = type.indexOf(":");
      return { module: type.slice(0, at), cls: type.slice(at + 1) };
    }
  }
  return undefined;
}

function subtype(
  keys: KeyTypes,
  def: TypeDef,
  model: Model,
  payload: Record<string, unknown>,
): Model | undefined {
  const models = keys.models?.[def.module] ?? {};
  const disc = inheritedDiscriminator(models, model);
  if (disc === undefined || typeof disc === "string") return undefined;
  const camelized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) camelized[camelize(k)] = v;
  if (!Object.hasOwn(camelized, disc.field))
    throw new MissingDiscriminator(disc.field);
  const value = camelized[disc.field];
  const name =
    typeof value === "string" && Object.hasOwn(disc.values, value)
      ? (disc.values[value] as string)
      : disc.fallback;
  return models[name];
}

/** Resolve get_subtype metadata up the model inheritance chain. */
export function inheritedDiscriminator(
  models: Record<string, Model>,
  model: Model,
): Exclude<Model["discriminator"], string | undefined> | undefined {
  let disc = model.discriminator;
  const seen = new Set<string>();
  while (typeof disc === "string" && !seen.has(disc)) {
    seen.add(disc);
    disc = models[disc]?.discriminator;
  }
  return typeof disc === "string" ? undefined : disc;
}

/** make_dict_keys_camel_case(obj, parameter_name, complex_parameter_type). */
export function camelizeKeys(
  keys: KeyTypes,
  obj: unknown,
  name?: string,
  declared?: TypeDef,
): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  const def = declared ?? lookup(keys, name);
  const model = def && keys.models?.[def.module]?.[def.cls];
  if (Array.isArray(obj)) {
    let listType: TypeDef | undefined;
    const list = def && /^list\[(.*)\]/.exec(def.cls);
    if (def && list) listType = { module: def.module, cls: list[1] as string };
    else if (def && !model) listType = def;
    return obj.map((item) => camelizeKeys(keys, item, undefined, listType));
  }
  const dict = obj as Record<string, unknown>;
  let camelizeAll =
    !def || (!def.cls.startsWith("dict(str,") && model !== undefined);
  // oci asks for the subtype per key, so an empty object never reads the discriminator.
  let instances: Model[] | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dict)) {
    const camelKey = camelize(key);
    let pass: TypeDef | undefined;
    if (def) {
      const entry = def.cls.startsWith("dict(")
        ? /^dict\(([^,]*), (.*)\)/.exec(def.cls)
        : null;
      if (entry) pass = { module: def.module, cls: entry[2] as string };
      else if (!model) pass = def;
      else {
        if (!instances) {
          const sub = subtype(keys, def, model, dict);
          instances = sub ? [model, sub] : [model];
        }
        for (const instance of instances) {
          for (const [snake, type, camel] of instance.attributes) {
            if (camelKey === camel) {
              pass = { module: def.module, cls: type };
              break;
            } else if (key === snake) {
              camelizeAll = false;
              pass = { module: def.module, cls: type };
              break;
            }
          }
        }
      }
    }
    // Like a Python dict, "__proto__" is an ordinary key.
    Object.defineProperty(out, camelizeAll ? camelKey : key, {
      value: camelizeKeys(keys, value, key, pass),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

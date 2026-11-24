// PyYAML-compatible block YAML serializer (`default_flow_style=False`, `sort_keys=True`,
// `allow_unicode=False`), matching `yaml.dump(..., encoding='utf-8')`.

const YAML_1_1_KEYWORDS = new Set([
  "~",
  "null",
  "Null",
  "NULL",
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "true",
  "True",
  "TRUE",
  "false",
  "False",
  "FALSE",
  "on",
  "On",
  "ON",
  "off",
  "Off",
  "OFF",
  "<<",
  "=",
]);

const YAML_1_1_NUMBER_OR_DATE = [
  /^[-+]?(?:0|[1-9][0-9_]*)$/,
  /^[-+]?0x[0-9a-fA-F_]+$/,
  /^[-+]?0o?[0-7_]+$/,
  /^[-+]?0b[01_]+$/,
  /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?[0-9][0-9_]*[eE][-+]?[0-9]+$/,
  /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
  /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]|$)/,
];

const PLAIN_FORBIDDEN_LEADING = new Set([
  ",",
  "[",
  "]",
  "{",
  "}",
  "#",
  "&",
  "*",
  "!",
  "|",
  ">",
  "'",
  '"',
  "%",
  "@",
  "`",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needsDoubleQuotes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x0a) continue;
    if (code < 0x20 || code >= 0x7f) return true;
  }
  return false;
}

function formatDoubleQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\0":
        out += "\\0";
        break;
      case "\x07":
        out += "\\a";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\x0b":
        out += "\\v";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\x1b":
        out += "\\e";
        break;
      default:
        if (cp >= 0x20 && cp <= 0x7e) {
          out += ch;
        } else if (cp <= 0xff) {
          out += `\\x${cp.toString(16).toUpperCase().padStart(2, "0")}`;
        } else if (cp <= 0xffff) {
          out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
        } else {
          out += `\\U${cp.toString(16).toUpperCase().padStart(8, "0")}`;
        }
        break;
    }
  }
  return `${out}"`;
}

function canBePlainScalar(s: string): boolean {
  if (s.length === 0) return false;
  if (s.trim() !== s) return false;
  if (s.includes("\n")) return false;
  if (s === "-" || s === "?" || s === ":") return false;
  if (s.startsWith("- ") || s.startsWith("? ") || s.startsWith(": "))
    return false;
  if (PLAIN_FORBIDDEN_LEADING.has(s[0] as string)) return false;
  if (s.endsWith(":") || s.includes(": ") || s.includes(" #")) return false;
  if (YAML_1_1_KEYWORDS.has(s)) return false;
  for (const re of YAML_1_1_NUMBER_OR_DATE) {
    if (re.test(s)) return false;
  }
  return true;
}

function formatSingleQuoted(s: string, indent: number): string {
  const escaped = s.replaceAll("'", "''");
  if (!escaped.includes("\n")) return `'${escaped}'`;
  const pad = " ".repeat(indent + 2);
  const folded = escaped.replaceAll("\n", `\n\n${pad}`);
  return `'${folded}'`;
}

function formatScalar(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (value === Infinity) return ".inf";
    if (value === -Infinity) return "-.inf";
    return String(value);
  }
  const s = String(value);
  if (needsDoubleQuotes(s)) return formatDoubleQuoted(s);
  if (canBePlainScalar(s)) return s;
  return formatSingleQuoted(s, indent);
}

function formatInline(value: unknown, indent: number): string {
  if (Array.isArray(value)) return "[]";
  if (isPlainObject(value)) return "{}";
  return formatScalar(value, indent);
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function emitMapping(
  obj: Record<string, unknown>,
  indent: number,
  inlineFirst: boolean,
): string {
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pad = " ".repeat(indent);
  let out = "";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    const val = obj[key];
    const prefix = inlineFirst && i === 0 ? "" : pad;
    const renderedKey = formatScalar(key, indent);
    if (isNonEmptyObject(val)) {
      out += `${prefix}${renderedKey}:\n${emitMapping(val, indent + 2, false)}`;
    } else if (isNonEmptyArray(val)) {
      out += `${prefix}${renderedKey}:\n${emitSequence(val, indent, false)}`;
    } else {
      out += `${prefix}${renderedKey}: ${formatInline(val, indent)}\n`;
    }
  }
  return out;
}

function emitSequence(
  arr: unknown[],
  indent: number,
  inlineFirst: boolean,
): string {
  const pad = " ".repeat(indent);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const prefix = inlineFirst && i === 0 ? "" : pad;
    if (isNonEmptyObject(item)) {
      out += `${prefix}- ${emitMapping(item, indent + 2, true)}`;
    } else if (isNonEmptyArray(item)) {
      out += `${prefix}- ${emitSequence(item, indent + 2, true)}`;
    } else {
      out += `${prefix}- ${formatInline(item, indent)}\n`;
    }
  }
  return out;
}

/** Serialize a JS value to PyYAML-compatible block YAML (matching `yaml.dump`). */
export function dumpYaml(value: unknown): string {
  if (isNonEmptyObject(value)) return emitMapping(value, 0, false);
  if (isNonEmptyArray(value)) return emitSequence(value, 0, false);
  if (isPlainObject(value)) return "{}\n";
  if (Array.isArray(value)) return "[]\n";
  return `${formatScalar(value, 0)}\n...\n`;
}

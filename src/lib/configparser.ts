// Port of CPython 3.12 configparser.ConfigParser(interpolation=None) reading: the parser
// oci uses for ~/.oci/config and oci_cli_rc. Defaults: delimiters "=" ":", full-line
// comments "#" ";", no inline comments, strict, empty lines in values, keys lower-cased.
import { pyRepr } from "../core/convert.ts";

export class ConfigParserError extends Error {
  constructor(
    message: string,
    public type:
      | "MissingSectionHeaderError"
      | "DuplicateSectionError"
      | "DuplicateOptionError"
      | "ParsingError",
  ) {
    super(message);
  }
}

export type ParsedConfig = {
  defaults: Map<string, string | null>;
  sections: Map<string, Map<string, string | null>>;
};

const DEFAULT_SECTION = "DEFAULT";
const SECTCRE = /^\[(?<header>.+)\]/;
// (?P<option>(?:(?!{delim})\S)*(?:(?:(?!{delim})\s)+(?:(?!{delim})\S)+)*)\s*(?P<vi>{delim})\s*(?P<value>.*)$
const OPTCRE =
  /^(?<option>(?:(?![=:])\S)*(?:(?:(?![=:])\s)+(?:(?![=:])\S)+)*)\s*(?<vi>[=:])\s*(?<value>.*)$/s;

/** Python str.strip() whitespace. */
export const pyStrip = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");

export function parseConfig(
  text: string,
  fpname: string,
  defaultSection = DEFAULT_SECTION,
  optionTransform = (option: string) => option.toLowerCase(),
): ParsedConfig {
  const defaults = new Map<string, string[] | null>();
  const sections = new Map<string, Map<string, string[] | null>>();
  const added = new Set<string>();
  let cursect: Map<string, string[] | null> | null = null;
  let sectname: string | null = null;
  let optname: string | null = null;
  let indentLevel = 0;
  let parsingError: ConfigParserError | null = null;

  // Universal newlines, keeping the terminator on each line like file iteration does.
  const lines = text.replace(/\r\n?/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const finish = () => join(defaults, sections);
  try {
    lines.forEach((line, i) => {
      const lineno = i + 1;
      let commentStart: number | null = null;
      for (const prefix of ["#", ";"]) {
        if (pyStrip(line).startsWith(prefix)) {
          commentStart = 0;
          break;
        }
      }
      const value = pyStrip(
        commentStart === null ? line : line.slice(0, commentStart),
      );
      if (!value) {
        if (
          commentStart === null &&
          cursect &&
          optname &&
          cursect.get(optname) != null
        ) {
          (cursect.get(optname) as string[]).push("");
        }
        return;
      }
      const firstNonSpace = line.search(/\S/u);
      const curIndent = firstNonSpace === -1 ? 0 : firstNonSpace;
      if (cursect && optname && curIndent > indentLevel) {
        (cursect.get(optname) as string[] | null)?.push(value);
        return;
      }
      indentLevel = curIndent;
      const header = SECTCRE.exec(value);
      if (header) {
        sectname = header.groups?.header as string;
        if (sections.has(sectname)) {
          if (added.has(sectname)) {
            throw new ConfigParserError(
              `While reading from ${pyRepr(fpname)} [line ${String(lineno).padStart(2)}]: section ${pyRepr(sectname)} already exists`,
              "DuplicateSectionError",
            );
          }
          cursect = sections.get(sectname) as Map<string, string[] | null>;
          added.add(sectname);
        } else if (sectname === defaultSection) {
          cursect = defaults;
        } else {
          cursect = new Map();
          sections.set(sectname, cursect);
          added.add(sectname);
        }
        optname = null;
        return;
      }
      if (!cursect) {
        throw new ConfigParserError(
          `File contains no section headers.\nfile: ${pyRepr(fpname)}, line: ${lineno}\n${pyRepr(line)}`,
          "MissingSectionHeaderError",
        );
      }
      const opt = OPTCRE.exec(value);
      if (opt) {
        const raw = opt.groups?.option as string;
        if (!raw) parsingError = addError(parsingError, fpname, lineno, line);
        optname = optionTransform(raw.replace(/\s+$/u, ""));
        const key = `${sectname}\u0000${optname}`;
        if (added.has(key)) {
          throw new ConfigParserError(
            `While reading from ${pyRepr(fpname)} [line ${String(lineno).padStart(2)}]: option ${pyRepr(optname)} in section ${pyRepr(sectname as string)} already exists`,
            "DuplicateOptionError",
          );
        }
        added.add(key);
        cursect.set(optname, [pyStrip(opt.groups?.value ?? "")]);
      } else {
        parsingError = addError(parsingError, fpname, lineno, line);
      }
    });
  } finally {
    // Python joins multiline values even when it raises.
  }
  if (parsingError) throw parsingError;
  return finish();
}

function addError(
  e: ConfigParserError | null,
  fpname: string,
  lineno: number,
  line: string,
): ConfigParserError {
  const err =
    e ??
    new ConfigParserError(
      `Source contains parsing errors: ${pyRepr(fpname)}`,
      "ParsingError",
    );
  err.message += `\n\t[line ${String(lineno).padStart(2)}]: ${pyRepr(line)}`;
  return err;
}

function join(
  defaults: Map<string, string[] | null>,
  sections: Map<string, Map<string, string[] | null>>,
): ParsedConfig {
  const fix = (m: Map<string, string[] | null>) =>
    new Map(
      [...m].map(([k, v]) => [
        k,
        v === null ? null : v.join("\n").replace(/\s+$/u, ""),
      ]),
    );
  return {
    defaults: fix(defaults),
    sections: new Map([...sections].map(([k, v]) => [k, fix(v)])),
  };
}

/** parser[name] as a dict: the section's options over DEFAULT's (DEFAULT keys first). */
export function sectionItems(
  cfg: ParsedConfig,
  name: string,
): Map<string, string | null> | undefined {
  if (name === DEFAULT_SECTION) return new Map(cfg.defaults);
  const section = cfg.sections.get(name);
  if (!section) return undefined;
  const merged = new Map(cfg.defaults);
  for (const [k, v] of section) merged.set(k, v);
  // Python's ChainMap-based SectionProxy iterates section keys first, then defaults.
  return new Map(
    [
      ...section.keys(),
      ...[...cfg.defaults.keys()].filter((k) => !section.has(k)),
    ].map((k) => [k, merged.get(k) ?? null]),
  );
}

function formatConfigValue(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\n\t");
}

/** Port of CPython `ConfigParser.write` (default `space_around_delimiters=True`). */
export function formatParsedConfig(
  cfg: ParsedConfig,
  defaultSection = DEFAULT_SECTION,
): string {
  let out = "";
  if (cfg.defaults.size > 0) {
    out += `[${defaultSection}]\n`;
    for (const [key, value] of cfg.defaults) {
      out +=
        value === null ? `${key}\n` : `${key} = ${formatConfigValue(value)}\n`;
    }
    out += "\n";
  }
  for (const [section, entries] of cfg.sections) {
    out += `[${section}]\n`;
    for (const [key, value] of entries) {
      out +=
        value === null ? `${key}\n` : `${key} = ${formatConfigValue(value)}\n`;
    }
    out += "\n";
  }
  return out;
}

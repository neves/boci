// JSON-valued parameter input (cli_util.parse_json_parameter and its file:// loading),
// shared by --from-json, complex-type parameters and request-body bindings.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandUser } from "./config.ts";
import { Exit, type Invocation } from "../lib/io.ts";
import { expandVars } from "./rc.ts";
import {
  camelizeKeys,
  type KeyTypes,
  MissingDiscriminator,
} from "./camelize.ts";

/** Python's repr() of a str, as Click and oci quote names in messages. */
export const repr = (s: string) =>
  s.includes("'") && !s.includes('"')
    ? `"${s}"`
    : `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** A `file://` value's contents (null for any other value); a missing file exits 1. */
export function loadFileContents(io: Invocation, path: string): string | null {
  if (path.toLowerCase().startsWith("file://")) {
    const filePath = expandVars(
      expandUser(path.slice("file://".length), io.env),
      io.env,
    );
    if (!existsSync(resolve(io.cwd, filePath))) {
      io.err(
        `The specified file '${path}' did not exist  (Resolved to path: '${filePath}')\n`,
      );
      throw new Exit(1);
    }
    return readFileSync(resolve(io.cwd, filePath), "utf8");
  }
  return null;
}

/**
 * A string (or `file://` reference) parsed as JSON; anything else passes through. Given
 * the parsing command's `keys`, its keys are camelized as oci does (ticket 19).
 */
export function parseJsonParameter(
  io: Invocation,
  parameterName: string,
  parameterValue: unknown,
  keys?: KeyTypes,
): unknown {
  if (parameterValue === undefined || parameterValue === null)
    return parameterValue;
  if (typeof parameterValue !== "string") return parameterValue;
  const jsonToParse = loadFileContents(io, parameterValue) ?? parameterValue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonToParse) as unknown;
  } catch {
    io.err(
      `Parameter ${repr(parameterName)} must be in JSON format.\nFor help with formatting JSON input see our documentation here: https://docs.cloud.oracle.com/iaas/Content/API/SDKDocs/cliusing.htm#ManagingCLIInputandOutput\n`,
    );
    throw new Exit(1);
  }
  if (!keys) return parsed;
  try {
    return camelizeKeys(keys, parsed, parameterName);
  } catch (e) {
    // get_subtype reads its discriminator; the json_skeleton handler reports the KeyError.
    if (!(e instanceof MissingDiscriminator)) throw e;
    io.err(`KeyError: ${repr(e.field)}\n`);
    throw new Exit(1);
  }
}

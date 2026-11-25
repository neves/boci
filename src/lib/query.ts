import { Exit, type Invocation } from "./io.ts";
import {
  type CompiledExpression,
  JMESPathError,
  LexerError,
  compile,
} from "../utils/jmespath.ts";

export {
  type CompiledExpression,
  JMESPathError,
  LexerError,
} from "../utils/jmespath.ts";

function rewriteCustomQuery(expression: string): string {
  // OCI's query() helper accepts an array and a field name, returning that field from each item.
  return expression.replace(
    /\bquery\(([^,()]+),\s*(['"])([^'"]+)\2\)/g,
    "$1[].$3",
  );
}

/** Compile a JMESPath query expression (supporting OCI's custom query() helper). */
export function compileQuery(expression: string): CompiledExpression {
  return compile(rewriteCustomQuery(expression));
}

/** Apply OCI CLI's JMESPath query helpers and the standard JMESPath functions. */
export function applyQuery(value: unknown, expression: string): unknown {
  return compileQuery(expression).search(value);
}

/**
 * Print a JMESPath error to stderr identically to `oci_cli.cli_util.build_query_expression`
 * + `wrap_exceptions` and exit with code 1.
 */
export function writeJmespathError(io: Invocation, err: JMESPathError): never {
  if (err instanceof LexerError && err.lexerMessage.includes("Unknown token")) {
    io.err(
      "If a key name has any characters besides [a-z, A-Z, 0-9, _], it needs to be escaped.\n" +
        'In bash or similar "NIX" based shells used in "NIX" environment, escaping can be done byusing double quotes inside single quotes.\n' +
        "e.g. --query 'data[*].\"display-name\"'\n" +
        "If using PowerShell in Windows environment, escaping can be done by using double quoteswith double escape character `.\n" +
        'e.g. --query data[*].`"display-name`"\n',
    );
  }
  io.err(`${err.pythonName}: ${err.message}\n`);
  throw new Exit(1);
}

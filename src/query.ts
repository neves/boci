import jmespath from "jmespath";

/** Apply OCI CLI's JMESPath query helpers and the standard JMESPath functions. */
export function applyQuery(value: unknown, expression: string): unknown {
  // OCI's query() accepts an array and a field name, returning that field from each item.
  // Rewrite the custom function into the standard projection supported by jmespath 0.16.
  const custom = expression.replace(
    /\bquery\(([^,()]+),\s*(['"])([^'"]+)\2\)/g,
    "$1[].$3",
  );
  return jmespath.search(value, custom);
}

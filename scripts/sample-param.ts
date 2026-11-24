export function sample(
  param: Record<string, unknown>,
  fallback = "test-value",
): string {
  if (param.name === "shape_availabilities") return '{"shapes":[]}';
  const choices = param.choices;
  if (Array.isArray(choices) && choices.length) return String(choices[0]);
  switch (param.type) {
    case "integer":
      return "1";
    case "float":
      return "1.5";
    case "boolean":
      return "true";
    case "complex":
    case "json":
    case "complex type":
      return "{}";
    default:
      return fallback;
  }
}

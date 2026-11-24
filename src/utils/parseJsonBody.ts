/** Parse a JSON response body, returning undefined on invalid JSON. */
export function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

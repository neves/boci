/** Python's UTF-8 decoder is strict and preserves an initial BOM as U+FEFF. */
export function decodePythonUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    data,
  );
}

/**
 * ZIP archive detection matching Python's `zipfile.is_zipfile` (`_EndRecData`).
 * Checks for a valid End-Of-Central-Directory (EOCD) record (`PK\x05\x06`) with
 * a comment length matching the trailing byte count.
 */
export function isZipBuffer(buf: Uint8Array): boolean {
  const size = buf.length;
  if (size < 22) return false;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Fast path: no archive comment, EOCD sits in the last 22 bytes.
  if (
    buf[size - 22] === 0x50 &&
    buf[size - 21] === 0x4b &&
    buf[size - 20] === 0x05 &&
    buf[size - 19] === 0x06 &&
    view.getUint16(size - 2, true) === 0
  ) {
    return true;
  }
  // Archive with comment: search backwards up to 64 KiB + 22 bytes from EOF.
  const start = Math.max(0, size - (0xffff + 22));
  for (let i = size - 22; i >= start; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      const commentLen = view.getUint16(i + 20, true);
      if (commentLen === size - i - 22) return true;
    }
  }
  return false;
}

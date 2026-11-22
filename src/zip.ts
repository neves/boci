// Minimal, zero-dependency ZIP archive reader and writer (DEFLATE + STORED).
import { writeFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntryInput = {
  name: string;
  data: Uint8Array;
  /** Unix st_mode (e.g. 0o100600). Defaults to 0o100644. */
  mode?: number;
  mtime?: Date;
};

export type ZipEntry = {
  name: string;
  data: Buffer;
  mode: number;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/** Build a ZIP archive buffer using DEFLATE compression (matching Python zipfile.ZIP_DEFLATED). */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw =
      entry.data instanceof Buffer ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(raw);
    const crc = Bun.hash.crc32(raw) >>> 0;
    const flags = isAscii(entry.name) ? 0 : FLAG_UTF8;
    const { dosTime, dosDate } = dosDateTime(entry.mtime ?? new Date());
    const mode = entry.mode ?? 0o100644;

    const local = Buffer.allocUnsafe(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const central = Buffer.allocUnsafe(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix, version 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, compressed);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export function writeZipFile(path: string, entries: ZipEntryInput[]): void {
  writeFileSync(path, buildZip(entries));
}

/** Read all entries from a ZIP archive buffer (supports STORED and DEFLATE). */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  let eocdPos = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error("File is not a zip file");
  }
  const entryCount = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error("Invalid ZIP central directory header");
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttr = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error("Invalid ZIP local file header");
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === METHOD_STORED) {
      data = Buffer.from(rawSlice);
    } else if (method === METHOD_DEFLATE) {
      data = inflateRawSync(rawSlice);
    } else {
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
    if (Bun.hash.crc32(data) >>> 0 !== crc) {
      throw new Error(`CRC-32 mismatch for ZIP entry: ${name}`);
    }
    entries.push({
      name,
      data,
      mode: (externalAttr >>> 16) & 0xffff,
    });
  }
  return entries;
}

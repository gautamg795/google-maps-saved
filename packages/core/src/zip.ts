/** One file to store in a ZIP archive. `name` uses forward slashes. */
export type ZipEntry = { name: string; data: Uint8Array };

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const VERSION = 20;
const UTF8_NAMES_FLAG = 0x0800;
const METHOD_STORED = 0;
const MAX_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 0xffff;
const MAX_32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS time and date fields. The date is read in UTC. */
function dosDateTime(date: Date): { time: number; date: number } {
  if (Number.isNaN(date.getTime())) {
    throw new Error("ZIP date is not a valid date.");
  }
  if (date.getUTCFullYear() < 1980) {
    return { time: 0, date: (1 << 5) | 1 };
  }
  const year = Math.min(date.getUTCFullYear(), 2107) - 1980;
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: (year << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function checkName(name: string): void {
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").includes("..")
  ) {
    throw new Error(`Invalid ZIP entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * Build a ZIP archive with no compression (method 0).
 * Names are stored as UTF-8 with general-purpose bit 11 set.
 * Timestamps come from `options.date` in UTC (default: now). Years before 1980
 * become 1980-01-01 00:00:00.
 * Throws if a name is empty, absolute, contains `\` or a `..` segment, or if
 * the archive needs ZIP64 (more than 65535 entries, or a size or offset of
 * 0xFFFFFFFF or more).
 */
export function createStoredZip(
  entries: readonly ZipEntry[],
  options?: { date?: Date },
): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP has more than ${MAX_ENTRIES} entries.`);
  }
  const stamp = dosDateTime(options?.date ?? new Date());
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    checkName(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > MAX_NAME_BYTES) {
      throw new Error(`ZIP entry name is too long: ${entry.name}`);
    }
    if (entry.data.length >= MAX_32) {
      throw new Error(`ZIP entry is too large: ${entry.name}`);
    }
    return { name, data: entry.data, crc: crc32(entry.data), offset: 0 };
  });

  let offset = 0;
  for (const entry of prepared) {
    if (offset >= MAX_32) {
      throw new Error("ZIP offset exceeds 32 bits.");
    }
    entry.offset = offset;
    offset += LOCAL_HEADER_BYTES + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of prepared) {
    centralSize += CENTRAL_HEADER_BYTES + entry.name.length;
  }
  if (centralOffset >= MAX_32 || centralSize >= MAX_32) {
    throw new Error("ZIP central directory exceeds 32 bits.");
  }

  const out = new Uint8Array(
    centralOffset + centralSize + END_OF_CENTRAL_DIRECTORY_BYTES,
  );
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (value: number) => {
    view.setUint16(p, value, true);
    p += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(p, value, true);
    p += 4;
  };
  const bytes = (value: Uint8Array) => {
    out.set(value, p);
    p += value.length;
  };

  for (const entry of prepared) {
    u32(LOCAL_HEADER_SIGNATURE);
    u16(VERSION);
    u16(UTF8_NAMES_FLAG);
    u16(METHOD_STORED);
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0);
    bytes(entry.name);
    bytes(entry.data);
  }
  for (const entry of prepared) {
    u32(CENTRAL_HEADER_SIGNATURE);
    u16(VERSION);
    u16(VERSION);
    u16(UTF8_NAMES_FLAG);
    u16(METHOD_STORED);
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(entry.offset);
    bytes(entry.name);
  }
  u32(END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  u16(0);
  u16(0);
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSize);
  u32(centralOffset);
  u16(0);
  return out;
}

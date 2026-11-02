/**
 * Minimal, dependency-free ZIP writer and reader used to package the extension.
 *
 * The writer is deterministic: entries are sorted, every timestamp is fixed to the DOS epoch and
 * no platform attributes are recorded, so packaging the same `dist/` twice yields byte-identical
 * archives and a stable SHA-256. Only the subset of the format Chrome needs (deflate, no
 * directory entries, no ZIP64) is implemented.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_EPOCH_DATE = 0x0021; // 1980-01-01
const DOS_EPOCH_TIME = 0x0000; // 00:00:00
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

/**
 * Lists regular files under `dir` as sorted archive paths (forward slashes).
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Builds a ZIP archive from `{ archivePath: Buffer }` entries, sorted by path.
 * @param {Record<string, Buffer>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const names = Object.keys(entries).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of names) {
    const data = entries[name];
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_EPOCH_TIME, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Zips every file under `dir`, with archive paths relative to it.
 * @param {string} dir
 * @returns {Buffer}
 */
export function zipDirectory(dir) {
  const entries = {};
  for (const path of listFiles(dir)) {
    const full = join(dir, ...path.split('/'));
    if (!statSync(full).isFile()) continue;
    entries[path] = readFileSync(full);
  }
  return createZip(entries);
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} size
 * @property {number} localOffset
 */

/**
 * Reads the central directory of a ZIP buffer.
 * @param {Buffer} zip
 * @returns {ZipEntry[]}
 */
export function readZipEntries(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let pointer = zip.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pointer) !== 0x02014b50) throw new Error('corrupt ZIP: bad central directory entry');
    const method = zip.readUInt16LE(pointer + 10);
    const crc = zip.readUInt32LE(pointer + 16);
    const compressedSize = zip.readUInt32LE(pointer + 20);
    const size = zip.readUInt32LE(pointer + 24);
    const nameLength = zip.readUInt16LE(pointer + 28);
    const extraLength = zip.readUInt16LE(pointer + 30);
    const commentLength = zip.readUInt16LE(pointer + 32);
    const localOffset = zip.readUInt32LE(pointer + 42);
    const name = zip.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    entries.push({ name, method, crc, compressedSize, size, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extracts one entry's bytes, verifying its CRC.
 * @param {Buffer} zip
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
export function readZipEntry(zip, entry) {
  const header = entry.localOffset;
  if (zip.readUInt32LE(header) !== 0x04034b50) throw new Error(`corrupt ZIP: bad local header for ${entry.name}`);
  const nameLength = zip.readUInt16LE(header + 26);
  const extraLength = zip.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const payload = zip.subarray(start, start + entry.compressedSize);
  const data = entry.method === METHOD_DEFLATE ? inflateRawSync(payload) : entry.method === METHOD_STORE ? Buffer.from(payload) : null;
  if (!data) throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`corrupt ZIP: ${entry.name} failed its integrity check`);
  return data;
}

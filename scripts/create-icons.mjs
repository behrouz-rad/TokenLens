/**
 * Generates the extension icons (16, 48, 128 px) without any image dependency: a dark rounded
 * tile with an accent-coloured lens ring and a key-dot, matching the panel palette.
 * Run: node scripts/create-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets');
mkdirSync(outDir, { recursive: true });

const BG = [0x1e, 0x1e, 0x2e];
const ACCENT = [0x89, 0xb4, 0xfa];
const LIGHT = [0xcd, 0xd6, 0xf4];

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function coverage(sample, x, y) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (sample(x - 0.375 + sx * 0.25, y - 0.375 + sy * 0.25)) hits++;
  return hits / 16;
}

function mix(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function makeIcon(size) {
  const radius = size * 0.22;
  const center = size / 2;
  const lensCx = size * 0.44;
  const lensCy = size * 0.44;
  const lensOuter = size * 0.27;
  const lensInner = size * 0.18;
  const handleWidth = size * 0.1;

  const inTile = (x, y) => {
    const dx = Math.max(Math.abs(x - center) - (center - radius), 0);
    const dy = Math.max(Math.abs(y - center) - (center - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  const inRing = (x, y) => {
    const d = Math.hypot(x - lensCx, y - lensCy);
    return d <= lensOuter && d >= lensInner;
  };
  const inHandle = (x, y) => {
    const ux = (x - lensCx) / Math.SQRT2 + (y - lensCy) / Math.SQRT2;
    const vx = -(x - lensCx) / Math.SQRT2 + (y - lensCy) / Math.SQRT2;
    return ux >= lensOuter - 1 && ux <= size * 0.62 && Math.abs(vx) <= handleWidth / 2;
  };
  const inDot = (x, y) => Math.hypot(x - lensCx, y - lensCy) <= size * 0.07;

  return encodePng(size, (x, y) => {
    const tile = coverage(inTile, x, y);
    if (tile === 0) return [0, 0, 0, 0];
    let color = BG;
    const ring = coverage((px, py) => inRing(px, py) || inHandle(px, py), x, y);
    if (ring > 0) color = mix(color, ACCENT, ring);
    const dot = coverage(inDot, x, y);
    if (dot > 0) color = mix(color, LIGHT, dot);
    return [...color, Math.round(tile * 255)];
  });
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon-${size}.png`), makeIcon(size));
}
console.log(`Icons written to ${outDir}`);

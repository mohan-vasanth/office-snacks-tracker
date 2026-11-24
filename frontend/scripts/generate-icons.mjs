// Generates the PWA icons (dependency-free PNG encoder). Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
const BG = [0x17, 0x25, 0x54], FG = [0xff, 0xff, 0xff], ACCENT = [0x25, 0x63, 0xeb];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
const png = (size, rgba) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

// scale = share of the canvas used by the glyph (maskable keeps it inside the 80% safe zone); radius = corner rounding (0 = full bleed)
function render(size, { scale, radius }) {
  const SS = 3, buf = Buffer.alloc(size * size * 4), c = size / 2, R = (size * scale) / 2, ring = R * 0.26;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let inside = true;
      if (radius) { const rr = size * radius, dx = Math.max(rr - px, 0, px - (size - rr)), dy = Math.max(rr - py, 0, py - (size - rr)); inside = dx * dx + dy * dy <= rr * rr; }
      if (!inside) continue;
      const d = Math.hypot(px - c, py - c);
      const dot = Math.hypot(px - (c + R * 0.62), py - (c - R * 0.62)) <= R * 0.2;
      const col = dot ? ACCENT : d <= R && d >= R - ring ? FG : BG;
      r += col[0]; g += col[1]; b += col[2]; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4, cnt = a / 255;
    if (cnt) { buf[i] = Math.round(r / cnt); buf[i + 1] = Math.round(g / cnt); buf[i + 2] = Math.round(b / cnt); buf[i + 3] = Math.round(a / n); }
  }
  return png(size, buf);
}

const files = {
  'icon-192.png': [192, { scale: 0.62, radius: 0.22 }],
  'icon-512.png': [512, { scale: 0.62, radius: 0.22 }],
  'icon-maskable-192.png': [192, { scale: 0.5, radius: 0 }],
  'icon-maskable-512.png': [512, { scale: 0.5, radius: 0 }],
  'apple-touch-icon.png': [180, { scale: 0.58, radius: 0 }],
  'favicon-32.png': [32, { scale: 0.7, radius: 0.22 }],
};
for (const [name, [size, opts]] of Object.entries(files)) writeFileSync(join(out, name), render(size, opts));
console.log('Generated', Object.keys(files).join(', '));

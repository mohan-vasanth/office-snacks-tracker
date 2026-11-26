// Generates the PWA icons (dependency-free PNG encoder). Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
const BG = [0x17, 0x25, 0x54], FG = [0xff, 0xff, 0xff];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
const png = (size, rgba) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

// Coffee-cup glyph in a 24-unit space (same geometry as BrandIcon in App.jsx): cup, handle, saucer, two steam lines.
const dSeg = (px, py, ax, ay, bx, by) => { const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy))); return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)); };
const bez = (p0, p1, p2, p3) => Array.from({ length: 25 }, (_, i) => { const t = i / 24, m = 1 - t; return [0, 1].map((k) => m * m * m * p0[k] + 3 * m * m * t * p1[k] + 3 * m * t * t * p2[k] + t * t * t * p3[k]); });
const STEAM = [bez([9, 2.5], [8, 3.7], [10, 4.7], [9, 6.1]), bez([13, 2.5], [12, 3.7], [14, 4.7], [13, 6.1])];
const dPoly = (px, py, pts) => Math.min(...pts.slice(1).map((q, i) => dSeg(px, py, pts[i][0], pts[i][1], q[0], q[1])));
// returns coverage colour weight: 0 none, 0.75 steam, 1 solid
function glyph(u, v) {
  if (u >= 5 && u <= 17 && v >= 9 && v <= 13.5) return 1;
  if (v > 13.5 && u >= 5 && u <= 17 && Math.hypot(u - Math.max(10, Math.min(12, u)), v - 13.5) <= 5) return 1;
  if (dSeg(u, v, 4.8, 21, 17.2, 21) <= 0.8) return 1;
  const handle = u >= 18.2 ? Math.abs(Math.hypot(u - 18.2, v - 12.8) - 2.3) : Math.min(dSeg(u, v, 17, 10.5, 18.2, 10.5), dSeg(u, v, 18.2, 15.1, 16.5, 15.1));
  if (handle <= 0.8) return 1;
  if (STEAM.some((s) => dPoly(u, v, s) <= 0.65)) return 0.75;
  return 0;
}
// scale = share of the canvas height used by the glyph (maskable keeps it inside the 80% safe zone); radius = corner rounding (0 = full bleed)
function render(size, { scale, radius }) {
  const SS = 4, buf = Buffer.alloc(size * size * 4), unit = (size * scale) / 19.3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let inside = true;
      if (radius) { const rr = size * radius, dx = Math.max(rr - px, 0, px - (size - rr)), dy = Math.max(rr - py, 0, py - (size - rr)); inside = dx * dx + dy * dy <= rr * rr; }
      if (!inside) continue;
      const w = glyph(12.25 + (px - size / 2) / unit, 12.15 + (py - size / 2) / unit);
      r += BG[0] + (FG[0] - BG[0]) * w; g += BG[1] + (FG[1] - BG[1]) * w; b += BG[2] + (FG[2] - BG[2]) * w; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4, cnt = a / 255;
    if (cnt) { buf[i] = Math.round(r / cnt); buf[i + 1] = Math.round(g / cnt); buf[i + 2] = Math.round(b / cnt); buf[i + 3] = Math.round(a / n); }
  }
  return png(size, buf);
}

const files = {
  'icon-192.png': [192, { scale: 0.56, radius: 0.22 }],
  'icon-512.png': [512, { scale: 0.56, radius: 0.22 }],
  'icon-maskable-192.png': [192, { scale: 0.46, radius: 0 }],
  'icon-maskable-512.png': [512, { scale: 0.46, radius: 0 }],
  'apple-touch-icon.png': [180, { scale: 0.54, radius: 0 }],
  'favicon-32.png': [32, { scale: 0.66, radius: 0.22 }],
};
for (const [name, [size, opts]] of Object.entries(files)) writeFileSync(join(out, name), render(size, opts));
console.log('Generated', Object.keys(files).join(', '));

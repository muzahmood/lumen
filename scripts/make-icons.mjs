// Renders the Lumen app icon to PNG without image libraries (run: node scripts/make-icons.mjs).
// Full-bleed background so it works as a maskable icon; artwork sits inside the safe zone.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Same drawing as public/icon.svg: an open notebook with a red ribbon marking your place, on lapis.
const LAPIS = hex('#22346E'); // the tile, and the fold between the pages
const PAGE_LEFT = hex('#F4F0E8'); // the left page, facing the light
const PAGE_RIGHT = hex('#DCD3C2'); // the right page, a shade darker
const RIBBON = hex('#B3261E'); // the ribbon marker

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Points along a cubic Bezier from p0 to p3 (p0 itself left out). */
function cubic(p0, p1, p2, p3, steps = 24) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Even-odd point-in-polygon. */
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// The pages, as in icon.svg: a curved top edge, a straight outer edge, a curved bottom edge meeting
// at the fold (x 16).
const LEFT = [[16, 9.6], ...cubic([16, 9.6], [13, 7.7], [9.6, 7.3], [6.4, 7.9]), [6.4, 22.5], ...cubic([6.4, 22.5], [9.6, 21.9], [13, 22.3], [16, 24.3])];
const RIGHT = [[16, 9.6], ...cubic([16, 9.6], [19, 7.7], [22.4, 7.3], [25.6, 7.9]), [25.6, 22.5], ...cubic([25.6, 22.5], [22.4, 21.9], [19, 22.3], [16, 24.3])];
// The ribbon: from under the right page's top edge down past the book, with a notched end.
const RIBBON_SHAPE = [[19.6, 8.7], [22.4, 8.15], [22.4, 26.4], [21, 24.9], [19.6, 26.4]];

// x, y in a 32-unit square covering the whole icon.
function shade(x, y) {
  // Map into artwork space. k = 1.05 keeps the farthest corner (a page's top outer corner, 12.6
  // units from the middle) inside the maskable safe circle (radius 12.8 of 32), with a little room.
  const k = 1.05;
  const ax = (x - 16) * k + 16;
  const ay = (y - 16) * k + 16;
  let color = LAPIS;
  if (inside(LEFT, ax, ay)) color = PAGE_LEFT;
  else if (inside(RIGHT, ax, ay)) color = PAGE_RIGHT;
  // The fold: a faint lapis line down the middle of the book.
  if (Math.abs(ax - 16) <= 0.35 && ay >= 9.6 && ay <= 24.3) color = mix(color, LAPIS, 0.35);
  if (inside(RIBBON_SHAPE, ax, ay)) color = RIBBON;
  return color;
}

function render(size) {
  const ss = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade(((px + (sx + 0.5) / ss) / size) * 32, ((py + (sy + 0.5) / ss) / size) * 32);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = ss * ss;
      const o = 1 + px * 4;
      row[o] = Math.round(r / n);
      row[o + 1] = Math.round(g / n);
      row[o + 2] = Math.round(b / n);
      row[o + 3] = 255;
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), render(size));
  console.log(`wrote public/icon-${size}.png`);
}

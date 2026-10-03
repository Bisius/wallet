// Renders the PWA icons from pwa/icon.svg into public/icons/. Run it with `npm run icons -w @wallet/frontend`
// after changing the SVG, and commit the PNGs.
//
// Node built-ins only: there is no SVG rasterizer in the repo, and the glyph is just rounded
// rectangles and circles, so this reads those two elements from the SVG and paints them itself
// (4x4 supersampling for smooth edges) before writing the PNG with node:zlib.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
const svg = readFileSync(join(here, 'icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
if (!viewBox || viewBox[1] !== viewBox[2])
  throw new Error('icon.svg needs a square viewBox "0 0 N N"');
const unit = Number(viewBox[1]);

/** Shapes in paint order. The first rect is the tile. */
const shapes = [...svg.matchAll(/<(rect|circle)\b([^>]*)>/g)].map(([, kind, rest]) => {
  const attr = Object.fromEntries(
    [...rest.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  const num = (name) => Number(attr[name] ?? 0);
  const fill = /^#([0-9a-f]{6})$/i.exec(attr.fill ?? '');
  if (!fill) throw new Error(`<${kind}> needs a fill like #1d4ed8`);
  const rgb = [0, 2, 4].map((at) => parseInt(fill[1].slice(at, at + 2), 16));
  return kind === 'circle'
    ? { kind, cx: num('cx'), cy: num('cy'), r: num('r'), rgb }
    : { kind, x: num('x'), y: num('y'), w: num('width'), h: num('height'), rx: num('rx'), rgb };
});
if (shapes[0]?.kind !== 'rect')
  throw new Error('the first element of icon.svg must be the tile rect');

function covers(shape, px, py, roundTile) {
  if (shape.kind === 'circle') return (px - shape.cx) ** 2 + (py - shape.cy) ** 2 <= shape.r ** 2;
  const r = shape === shapes[0] && !roundTile ? 0 : Math.min(shape.rx, shape.w / 2, shape.h / 2);
  const dx = Math.max(Math.abs(px - (shape.x + shape.w / 2)) - (shape.w / 2 - r), 0);
  const dy = Math.max(Math.abs(py - (shape.y + shape.h / 2)) - (shape.h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

const SAMPLES = 4;

/** RGBA pixels of the icon at `size` px. `roundTile` rounds the tile (transparent corners). */
function render(size, roundTile) {
  const scale = unit / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          const top = shapes.findLast((shape) => covers(shape, x, y, roundTile));
          if (!top) continue;
          hits++;
          for (let c = 0; c < 3; c++) sum[c] += top.rgb[c];
        }
      }
      const at = (py * size + px) * 4;
      if (hits > 0) for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(sum[c] / hits);
      pixels[at + 3] = Math.round((hits / SAMPLES ** 2) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter, not interlaced
  const rows = Buffer.alloc(size * (size * 4 + 1)); // every row starts with filter type 0 (none)
  for (let row = 0; row < size; row++) {
    pixels.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * "any" icons keep the rounded tile. The maskable icon and the Apple touch icon are full bleed: the
 * system applies its own mask (Android) or rounded corners (iOS, which paints transparency black).
 */
const icons = [
  { file: 'icon-192x192.png', size: 192, roundTile: true },
  { file: 'icon-512x512.png', size: 512, roundTile: true },
  { file: 'icon-maskable-512x512.png', size: 512, roundTile: false },
  { file: 'apple-touch-icon-180x180.png', size: 180, roundTile: false },
];

mkdirSync(outDir, { recursive: true });
for (const { file, size, roundTile } of icons) {
  writeFileSync(join(outDir, file), png(size, render(size, roundTile)));
  console.log(`public/icons/${file}`);
}

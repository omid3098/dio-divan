// Divan's mark, the seal (approved by Omid, 2026-10-12): every brand file comes from the one geometry here.
// Five members, each one half of a yin and yang, turn round the chairman's disc. Their outer edges lie on one circle,
// so the mark reads as a round seal; each inner edge swings in an S into a round head. Each comma is ONE closed outline
// (rim arc, head, S curve, tail cap) whose joins are tangent: pure fills, no stroke, no mask, no overlap.
//
// Writes brand/*.svg, web/public/favicon.svg and web/src/components/divan-mark-paths.ts, then renders brand/*.png and
// brand/favicon.ico with a headless Chrome of its own (no window, no focus). Run: node scripts/brand.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'brand');
const C = 128;
const TOP = -Math.PI / 2;
const rad = (deg) => (deg * Math.PI) / 180;
const num = (v) => String(Number(v.toFixed(2)));
const pt = (r, t) => [C + r * Math.cos(t), C + r * Math.sin(t)];
const xy = ([x, y]) => `${num(x)} ${num(y)}`;

/** One member: its head centred on angle h, its tail `span` radians behind it. */
function comma(h, rim, head, tail, span) {
  const t = h - span;
  const smooth = (s) => s * s * (3 - 2 * s); // flat at both ends: the S of a yin and yang
  const inner = (s) => rim - 2 * tail - (2 * head - 2 * tail) * smooth(s);
  const n = 8;
  const pts = Array.from({ length: n + 1 }, (_, k) => pt(inner(1 - k / n), h - span * (k / n)));
  let s = '';
  for (let k = 0; k < n; k++) {
    // Catmull-Rom through the samples, as cubic Béziers; the ends mirror their neighbour
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p0 = k === 0 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : pts[k - 1];
    const p3 = k === n - 1 ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : pts[k + 2];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    s += `C${xy(c1)} ${xy(c2)} ${xy(p2)}`;
  }
  return (
    `M${xy(pt(rim, t))}` +
    `A${num(rim)} ${num(rim)} 0 0 1 ${xy(pt(rim, h))}` + // the rim, clockwise to the head
    `A${num(head)} ${num(head)} 0 0 1 ${xy(pt(rim - 2 * head, h))}` + // round the head to its inner point
    s + // the S back to the tail
    `A${num(tail)} ${num(tail)} 0 0 1 ${xy(pt(rim, t))}Z` // round the tail cap to the rim
  );
}

const disc = (r) =>
  `M${num(C - r)} ${C}a${num(r)} ${num(r)} 0 1 0 ${num(2 * r)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-2 * r)} 0Z`;

function mark({ rim, head, tail, span, chair }) {
  const heads = [0, 1, 2, 3, 4].map((i) => TOP + rad(18 + i * 72));
  return heads.map((h) => comma(h, rim, head, tail, rad(span))).join('') + disc(chair);
}

const MARK = mark({ rim: 108, head: 28, tail: 7, span: 44, chair: 32 });
// 16 to 24 px: shorter tails so the gaps stay open, bigger heads and chair
const MARK_SMALL = mark({ rim: 110, head: 30, tail: 9, span: 36, chair: 35 });

// Dio Docs' glow stops (light, dark), from the upper right to the lower left
const LIGHT = ['#06B6D4', '#6366F1', '#C026D3'];
const DARK = ['#67E8F9', '#8B9CFF', '#D8A6FF'];
const gradient = (stops, id = 'g') =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="164" y1="20" x2="92" y2="236">${stops
    .map((c, i) => `<stop offset="${[0, 0.5, 1][i]}" stop-color="${c}"/>`)
    .join('')}</linearGradient>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${body}</svg>\n`;
const filled = (d, stops) => svg(`<defs>${gradient(stops)}</defs><path fill="url(#g)" d="${d}"/>`);
const flat = (d, colour) => svg(`<path fill="${colour}" d="${d}"/>`);

const files = {
  'divan-mark.svg': filled(MARK, LIGHT),
  'divan-mark-dark.svg': filled(MARK, DARK),
  'divan-mark-small.svg': filled(MARK_SMALL, LIGHT),
  'divan-mark-black.svg': flat(MARK, '#000'),
  'divan-mark-white.svg': flat(MARK, '#FFF'),
  'divan-mark-mono.svg': flat(MARK, '#6366F1'),
  'divan-mark-small-black.svg': flat(MARK_SMALL, '#000'),
  // the mark on Dio's dark tile, corner radius 22.5%
  'app-icon.svg': svg(
    '<defs><radialGradient id="t" gradientUnits="userSpaceOnUse" cx="72" cy="46" r="282">' +
      '<stop offset="0" stop-color="#1B2344"/><stop offset=".7" stop-color="#070A14"/></radialGradient>' +
      `${gradient(DARK)}</defs><rect width="256" height="256" rx="57.6" fill="url(#t)"/>` +
      `<path fill="url(#g)" transform="translate(128 128) scale(.74) translate(-128 -128)" d="${MARK}"/>`,
  ),
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(BRAND, name), body);

// the small cut with fixed stops and a colour-scheme switch inside the file, as Dio's own favicon
writeFileSync(
  join(ROOT, 'web/public/favicon.svg'),
  svg(
    '<style>.a{stop-color:#06B6D4}.b{stop-color:#6366F1}.c{stop-color:#C026D3}' +
      '@media (prefers-color-scheme:dark){.a{stop-color:#67E8F9}.b{stop-color:#8B9CFF}.c{stop-color:#D8A6FF}}</style>' +
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="164" y1="20" x2="92" y2="236">' +
      '<stop offset="0" class="a"/><stop offset=".5" class="b"/><stop offset="1" class="c"/></linearGradient></defs>' +
      `<path fill="url(#g)" d="${MARK_SMALL}"/>`,
  ),
);

writeFileSync(
  join(ROOT, 'web/src/components/divan-mark-paths.ts'),
  `// Generated by scripts/brand.mjs from the mark's geometry; do not edit by hand.\n\nexport const MARK =\n  '${MARK}';\n\nexport const MARK_SMALL =\n  '${MARK_SMALL}';\n`,
);

/** An .ico of PNG images (Windows Vista and later read PNG entries). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size % 256, o);
    head.writeUInt8(size % 256, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((image) => image.data)]);
}

const CHROME = [
  process.env.DIVAN_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((path) => path && existsSync(path));
if (!CHROME) {
  console.error(
    'no Chrome or Edge found (set DIVAN_CHROME): the SVGs are written, the PNGs and the .ico are not',
  );
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'],
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (file, size) => {
    const src = `data:image/svg+xml;base64,${readFileSync(join(BRAND, file)).toString('base64')}`;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
    );
    await page.waitForFunction(() => document.images[0].complete);
    return page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
  };
  for (const size of [512, 1024])
    writeFileSync(join(BRAND, `app-icon-${size}.png`), await render('app-icon.svg', size));
  writeFileSync(join(BRAND, 'divan-mark-1024.png'), await render('divan-mark.svg', 1024));
  const small = [];
  for (const size of [16, 24, 32, 48])
    small.push({ size, data: await render('divan-mark-small.svg', size) });
  writeFileSync(join(BRAND, 'favicon.ico'), ico(small));
} finally {
  await browser.close();
}
console.log('brand files written');

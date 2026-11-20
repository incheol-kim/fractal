// Review gate 4a (the test exports, before the full export): the stills of docs/review/gate4a/, made
// from the exported test files themselves, for the owner's three decisions: smoothing edges with the
// sub-pixel jitter, motion blur, and x264's grain tuning. The page, index.html, is written by hand.
//
//   node tools/gate4a.mjs [--out=gate4a]
//
// Reads the 4K files of the test exports in <VIDEO>/tests/ (tools/paths.mjs): test_<a|b>_<variant>_4K.mov
// for the four variants (plain: --sub=1; aa: --sub=16 --shutter=0 --jitter=1; blur: --sub=16
// --shutter=0.5 --jitter=0; aa_blur: --sub=16 --shutter=0.5 --jitter=1) of passage a (29.5-42 s) and
// b (43.5 s to the end), and test_a_plain_grain_4K.mov (the same frames as test_a_plain, encoded with
// --tune=grain). Each file's side file gives its first frame and must name the variant's sub-frames
// and tune, or the tool stops. Frames are decoded as a player shows them (tools/video_io.mjs).
//
// Writes, as JPEG (quality 95, 4:4:4, Pillow from .venv's Python, as tools/gate3.mjs) into
// docs/review/<out>/ (refused if it already holds pictures: a shown bundle is never overwritten):
//   <moment>_<frame>_<place>_<variant>.jpg     a part of the 4K frame at its own pixels
//   <moment>_<frame>_<place>_<variant>_x3.jpg  a smaller part inside it, enlarged 3x (each pixel a 3x3
//                                              block: the pixels as they are, nothing smoothed)
//   <moment>_<frame>_where.jpg                 the plain variant's whole frame at 960x540, the parts
//                                              outlined (the 1x part yellow, the 3x part cyan;
//                                              not for a black frame or the end card)
//   enc_<frame>_<place>_<source>[_x3].jpg      the encoder comparison: the frame the page draws
//                                              (source page: a fresh headless Edge at 4K, renderFrame at
//                                              k / 60, as the export draws it with --sub=1), test_a_plain
//                                              (crf14) and test_a_plain_grain (grain); and enc_<frame>_where.jpg
// Everything is written into <TEMP>/gate4a_tmp/<out>/ first and moved in only when every file
// exists. Prints, for each part, how far each variant is from plain (mean absolute difference, in
// levels) and how much of plain's finest detail it keeps (mean absolute Laplacian, as a share); for
// the encoder comparison the PSNR of each file against the page's frame (whole frame and each part),
// and the files' sizes. The Vite server for the page runs on port 5199 (tools/browser.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, arg, startServer, grab, toRGB, writePNG, PORT } from './browser.mjs';
import { decodeFrames, resizeRGB } from './video_io.mjs';
import { frameError, sideFile } from './export_lib.mjs';
import { TEMP, VIDEO } from './paths.mjs';

const [W, H] = [3840, 2160];
const WHERE = [960, 540]; // the overview of a frame
const ZOOM = 3;
const JPEG_QUALITY = 95; // with chroma subsampling off (4:4:4)
const PY = path.join(root, '.venv', 'Scripts', 'python.exe');
const TESTS = path.join(VIDEO, 'tests');

// the variants as the side files name them
const VARIANTS = [
  { key: 'plain', sub: 1, shutter: 0, jitter: false },
  { key: 'aa', sub: 16, shutter: 0, jitter: true },
  { key: 'blur', sub: 16, shutter: 0.5, jitter: false },
  { key: 'aa_blur', sub: 16, shutter: 0.5, jitter: true },
];

// The moments: the passage, the frames (k, the video's frame number) and the places, each a part of
// the 4K frame at its own pixels (crop: x, y, w, h) and a smaller part enlarged 3x (zoom); noOverview:
// the frames shown without the whole frame (a black frame; the end card, whose name line is a
// person's name, which the bundle does not show). Chosen by looking at the frames of the test exports
// (Task 5's report says what each shows).
//   sky    the sky arriving as blue halftone ink, sliding in: 1819 (with shutter 0.5 already in the
//          frame: 30.3183 s lies 0.098 of a frame after 1819's time) and 1820 (in every variant)
//   strike the frame after the strike: with blur a piece that arrives 2.3 ms into the 8.3 ms window
//          shows at about 75 % over the yellow halftone it covers
//   fold   the middle of the fold, the blue and red halftone panels rising
//   press  the press chord: the base houses slam in as dark halftone ink
//   still  a passage where little moves: a photograph of wires with thin drawn lines, and pencil lines
//          on paper (the jitter's softening and its more even stairs)
//   clouds the clouds near the end (46.5 s), where a wire crosses the drifting cloud's edge
//   cut    the picture's last frame (2824) and the first black one (2825)
//   card   the end card's title (the name line below it is left out)
const MOMENTS = [
  { name: 'sky', passage: 'a', frames: [1819, 1820], places: [
    { name: 'left', crop: [0, 960, 480, 300], zoom: [120, 1100, 160, 100] },
    { name: 'right', crop: [3000, 700, 480, 300], zoom: [3120, 860, 160, 100] },
  ] },
  { name: 'strike', passage: 'a', frames: [2045], places: [
    { name: 'centre', crop: [1440, 560, 480, 300], zoom: [1500, 600, 160, 100] },
  ] },
  { name: 'fold', passage: 'a', frames: [2273], places: [
    { name: 'blue', crop: [2380, 380, 480, 300], zoom: [2600, 420, 160, 100] },
    { name: 'red', crop: [660, 1100, 480, 300], zoom: [720, 1180, 160, 100] },
  ] },
  { name: 'press', passage: 'a', frames: [2490], places: [
    { name: 'houses', crop: [2840, 1840, 480, 300], zoom: [2880, 2020, 160, 100] },
  ] },
  { name: 'still', passage: 'a', frames: [1790], places: [
    { name: 'photo', crop: [900, 560, 480, 300], zoom: [1200, 620, 160, 100] },
    { name: 'pencil', crop: [3240, 1560, 480, 300], zoom: [3420, 1620, 160, 100] },
  ] },
  { name: 'clouds', passage: 'b', frames: [2790], places: [
    { name: 'edge', crop: [3000, 1100, 480, 300], zoom: [3140, 1200, 160, 100] },
  ] },
  { name: 'cut', passage: 'b', frames: [2824, 2825], noOverview: [2825], places: [
    { name: 'tree', crop: [1600, 1440, 480, 300], zoom: [1760, 1540, 160, 100] },
  ] },
  { name: 'card', passage: 'b', frames: [2950], noOverview: [2950], places: [
    { name: 'title', crop: [1590, 880, 660, 240], zoom: [1612, 925, 160, 110] },
  ] },
];

// The encoder comparison: one frame of passage a drawn by the page and decoded from the two encodes of
// the same render; a part with paper grain and pencil lines, and one of the sky's halftone ink
const ENC = { frame: 1822, places: [
  { name: 'paper', crop: [3240, 1560, 480, 300], zoom: [3420, 1620, 160, 100] },
  { name: 'halftone', crop: [480, 60, 480, 300], zoom: [560, 120, 160, 100] },
] };

const OUT_NAME = arg('out', 'gate4a');
if (!/^[\w.-]+$/.test(OUT_NAME) || OUT_NAME.startsWith('.')) throw new Error(`bad --out name: ${OUT_NAME}`);
const OUT_DIR = path.join(root, 'docs', 'review', OUT_NAME);
const TMP_DIR = path.join(TEMP, 'gate4a_tmp', OUT_NAME);
const show = (p) => path.relative(root, p).split(path.sep).join('/');
const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

// A test file and its first frame; its side file must say it is that variant with that tune
function testFile(passage, v, tune = 'none') {
  const file = path.join(TESTS, `test_${passage}_${v.key}${tune === 'grain' ? '_grain' : ''}_4K.mov`);
  const sf = sideFile(file);
  if (!fs.existsSync(file) || !fs.existsSync(sf)) throw new Error(`missing ${show(file)} or its side file (make the test exports first)`);
  const side = JSON.parse(fs.readFileSync(sf, 'utf8'));
  if (side.sub !== v.sub || side.shutter !== v.shutter || side.jitter !== v.jitter || side.tune !== tune) {
    throw new Error(`${show(sf)} says sub ${side.sub} shutter ${side.shutter} jitter ${side.jitter} tune ${side.tune}, wanted ${v.key} (sub ${v.sub} shutter ${v.shutter} jitter ${v.jitter}) tune ${tune}`);
  }
  return { file, k0: side.k0, frames: side.frames };
}

// frame k of a test file, decoded -> RGB (3 bytes a pixel, rows top first)
async function frameOf(t, k) {
  if (k < t.k0 || k >= t.k0 + t.frames) throw new Error(`${show(t.file)} holds frames ${t.k0}..${t.k0 + t.frames - 1}, not ${k}`);
  const [rgb] = await decodeFrames(t.file, k - t.k0, 1);
  return rgb;
}

// the part [x, y, w, h] of a 4K RGB frame -> Buffer
function crop(rgb, [x, y, w, h]) {
  if (!(x >= 0 && y >= 0 && x + w <= W && y + h <= H)) throw new Error(`part ${x},${y},${w},${h} is not inside the frame`);
  const out = Buffer.alloc(w * h * 3);
  for (let r = 0; r < h; r++) rgb.copy(out, r * w * 3, ((y + r) * W + x) * 3, ((y + r) * W + x + w) * 3);
  return out;
}

// RGB of w x h, each pixel made an n x n block -> Buffer of (w n) x (h n)
function enlarge(rgb, w, h, n) {
  const out = Buffer.alloc(w * n * h * n * 3);
  for (let y = 0; y < h * n; y++) {
    const sy = Math.floor(y / n);
    for (let x = 0; x < w * n; x++) rgb.copy(out, (y * w * n + x) * 3, (sy * w + Math.floor(x / n)) * 3, (sy * w + Math.floor(x / n)) * 3 + 3);
  }
  return out;
}

// an outline of the 4K part [x, y, w, h] on an overview of WHERE's size, 2 px wide
function outline(rgb, [x, y, w, h], colour) {
  const s = WHERE[0] / W;
  const [x0, y0] = [Math.round(x * s), Math.round(y * s)];
  const [x1, y1] = [Math.min(WHERE[0] - 1, Math.round((x + w) * s)), Math.min(WHERE[1] - 1, Math.round((y + h) * s))];
  const dot = (px, py) => {
    if (px < 0 || py < 0 || px >= WHERE[0] || py >= WHERE[1]) return;
    const i = (py * WHERE[0] + px) * 3;
    [rgb[i], rgb[i + 1], rgb[i + 2]] = colour;
  };
  for (let d = 0; d < 2; d++) {
    for (let px = x0; px <= x1; px++) dot(px, y0 + d), dot(px, y1 - d);
    for (let py = y0; py <= y1; py++) dot(x0 + d, py), dot(x1 - d, py);
  }
}
const YELLOW = [255, 220, 0];
const CYAN = [0, 220, 255];

async function overview(rgb, places, file) {
  const small = await resizeRGB(rgb, [W, H], WHERE);
  for (const p of places) outline(small, p.crop, YELLOW), outline(small, p.zoom, CYAN);
  writePNG(file, small, ...WHERE);
}

// mean absolute difference of two RGB buffers of one size, in levels (all channels)
function meanAbs(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// the finest detail of an RGB part of w x h: the mean absolute 4-neighbour Laplacian over every channel
// of the inner pixels (the measure of tools/README.md "하위 프레임": the jitter keeps 88-92 % of it)
function detail(rgb, w, h) {
  let s = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 3 + c;
        s += Math.abs(4 * rgb[i] - rgb[i - 3] - rgb[i + 3] - rgb[i - w * 3] - rgb[i + w * 3]);
        n++;
      }
    }
  }
  return s / n;
}

// Each PNG -> a JPEG of the same name (quality JPEG_QUALITY, 4:4:4) next to it; the PNG is removed.
// Pillow from .venv (Node has no JPEG encoder here), as tools/gate3.mjs.
function toJPEG(pngs) {
  const code = [
    'import os, sys',
    'from PIL import Image',
    'q = int(sys.argv[1])',
    'for p in sys.argv[2:]:',
    '    with Image.open(p) as im:',
    '        im.convert("RGB").save(p[:-4] + ".jpg", "JPEG", quality=q, subsampling=0, optimize=True)',
    '    os.remove(p)',
  ].join('\n');
  const r = spawnSync(PY, ['-c', code, String(JPEG_QUALITY), ...pngs], { encoding: 'utf8' });
  if (r.error) throw new Error(`could not run ${show(PY)}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the JPEG conversion (Pillow) failed:\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
}

// a part and its 3x enlargement as PNGs in TMP_DIR -> the two names
function writePart(rgb, p, base) {
  const [, , w, h] = p.crop;
  const [, , zw, zh] = p.zoom;
  writePNG(path.join(TMP_DIR, `${base}.png`), crop(rgb, p.crop), w, h);
  writePNG(path.join(TMP_DIR, `${base}_x3.png`), enlarge(crop(rgb, p.zoom), zw, zh, ZOOM), zw * ZOOM, zh * ZOOM);
  return [`${base}.png`, `${base}_x3.png`];
}

async function moments(files) {
  console.log('part: each variant against plain, mean |difference| in levels / share of plain\'s finest detail (mean |Laplacian|) kept, in the 1x part and the 3x part');
  for (const m of MOMENTS) {
    const tests = VARIANTS.map((v) => testFile(m.passage, v));
    for (const k of m.frames) {
      const frames = [];
      for (const t of tests) frames.push(await frameOf(t, k));
      if (!m.noOverview?.includes(k)) {
        const where = `${m.name}_${k}_where.png`;
        await overview(frames[0], m.places, path.join(TMP_DIR, where));
        files.push(where);
      }
      for (const p of m.places) {
        const base = `${m.name}_${k}_${p.name}`;
        VARIANTS.forEach((v, i) => files.push(...writePart(frames[i], p, `${base}_${v.key}`)));
        const say = (part) => {
          const [, , w, h] = part;
          const ref = crop(frames[0], part);
          const d0 = detail(ref, w, h);
          return VARIANTS.slice(1).map((v, i) => {
            const c = crop(frames[i + 1], part);
            return `${v.key} ${meanAbs(ref, c).toFixed(2)} / ${d0 ? `${((100 * detail(c, w, h)) / d0).toFixed(1)} %` : '-'}`;
          }).join(', ');
        };
        console.log(`${base}  1x ${p.crop.join(',')}: ${say(p.crop)}  |  3x ${p.zoom.join(',')}: ${say(p.zoom)}`);
      }
    }
  }
}

// the encoder comparison: the page's frame (a fresh browser) against the two encodes of test_a_plain
async function encoders(files) {
  const plain = VARIANTS[0];
  const sources = [
    { key: 'crf14', test: testFile('a', plain, 'none') },
    { key: 'grain', test: testFile('a', plain, 'grain') },
  ];
  const k = ENC.frame;
  const server = await startServer(PORT);
  let page;
  try {
    // the export's frame with --sub=1: renderFrame(k / 60) without options (k / 60 prints as the
    // shortest text that reads back as the same number, so the page draws exactly that time)
    const g = await grab('', k / 60, [W, H]);
    page = toRGB(g.px);
    console.log(`encoder comparison, frame ${k} (renderFrame(${k} / 60) in a fresh headless Edge at 4K; GPU ${g.gpu})`);
  } finally {
    await server.close();
  }
  const rgbs = { page };
  for (const s of sources) rgbs[s.key] = await frameOf(s.test, k);
  const where = `enc_${k}_where.png`;
  await overview(page, ENC.places, path.join(TMP_DIR, where));
  files.push(where);
  for (const p of ENC.places) for (const key of ['page', ...sources.map((s) => s.key)]) files.push(...writePart(rgbs[key], p, `enc_${k}_${p.name}_${key}`));
  const db = (e) => `${e.psnr.toFixed(2)} dB (mean |error| ${(e.mae.reduce((a, b) => a + b) / 3).toFixed(2)})`;
  for (const s of sources) {
    const parts = ENC.places.map((p) => `${p.name} ${db(frameError(crop(page, p.crop), crop(rgbs[s.key], p.crop)))}, its 3x part ${db(frameError(crop(page, p.zoom), crop(rgbs[s.key], p.zoom)))}`);
    const d = ENC.places.map((p) => `${p.name} ${((100 * detail(crop(rgbs[s.key], p.crop), p.crop[2], p.crop[3])) / detail(crop(page, p.crop), p.crop[2], p.crop[3])).toFixed(1)} %`);
    console.log(`  ${s.key} (${show(s.test.file)}) against the page: whole frame ${db(frameError(page, rgbs[s.key]))}; ${parts.join('; ')}; finest detail kept: ${d.join(', ')}`);
  }
  for (const s of sources) {
    const four = s.test.file;
    const ten = four.replace(/_4K\.mov$/, '_1080p.mov');
    console.log(`  ${s.key}: ${show(four)} ${fs.statSync(four).size} bytes (${mib(fs.statSync(four).size)}), ${show(ten)} ${fs.statSync(ten).size} bytes (${mib(fs.statSync(ten).size)})`);
  }
}

async function main() {
  if (fs.existsSync(OUT_DIR) && fs.readdirSync(OUT_DIR).some((f) => /\.(png|webp|jpe?g)$/i.test(f))) {
    throw new Error(`${show(OUT_DIR)} already holds pictures; a review bundle is never overwritten`);
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true }); // left over from a stopped run
  fs.mkdirSync(TMP_DIR, { recursive: true });
  let done = false;
  try {
    const files = [];
    await moments(files);
    await encoders(files);
    toJPEG(files.map((f) => path.join(TMP_DIR, f)));
    const jpgs = files.map((f) => f.replace(/\.png$/, '.jpg'));
    const total = jpgs.reduce((n, f) => n + fs.statSync(path.join(TMP_DIR, f)).size, 0);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of jpgs) fs.renameSync(path.join(TMP_DIR, f), path.join(OUT_DIR, f));
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    done = true;
    console.log(`${jpgs.length} JPEG files (quality ${JPEG_QUALITY}, 4:4:4), ${total} bytes (${mib(total)}), in ${show(OUT_DIR)}`);
  } finally {
    if (!done) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}

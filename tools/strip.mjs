// A strip of frames around one time, from one browser, and a contact sheet of them.
//
//   node tools/strip.mjs --t=<s> --frames=<-2,0,1,…> --out=<folder> [--w=1920] [--h=1080] [--q="…"]
//                        [--clip=x,y,w,h] [--cols=5] [--cell=640]
//
// Starts its own Vite dev server on port 5199 and one headless Edge on the page at
// ?w=&h=&<q>#t=<t> (canvas fixed to w x h, window the same size, device scale 1), then draws
// renderFrame(t + f / 60) for each frame offset f in the given order (whole frames at 60 fps, before
// or after t) and saves each frame's canvas pixels (readCanvas in tools/browser.mjs: gl.readPixels)
// as <folder>/f<sign><three digits>.png (f-002.png, f+000.png, f+012.png). --clip keeps only that
// part of each frame (canvas pixels, x, y from the top left, as tools/shot.mjs). Then
// <folder>/sheet.jpg: the frames in the given order, cols to a row, each cell the frame scaled down
// to at most cell px wide (never up) and labelled with its offset and time, "+3 (37.865)"; JPEG
// quality 95, 4:4:4, made with Pillow from .venv's Python (as tools/gate2b.mjs). The folder must be
// under local-only/temp/ (not in git); frames and a sheet of an earlier run there are removed first.
//
// renderFrames and writeSheet are exported for other tools (importing this file runs nothing).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, arg, startServer, openBrowser, readCanvas, toRGB, writePNG, PORT } from './browser.mjs';
import { inTemp } from './paths.mjs';

const PY = path.join(root, '.venv', 'Scripts', 'python.exe');
const JPEG_QUALITY = 95; // with chroma subsampling off (4:4:4)
const FRAME_FILE = /^f[+-]\d{3}\.png$/;

// a frame offset as a file name: -2 -> f-002.png, 0 -> f+000.png
const frameFile = (offset) => `f${offset < 0 ? '-' : '+'}${String(Math.abs(offset)).padStart(3, '0')}.png`;

// a frame's label on the sheet: +3 (37.865)
const label = (f) => `${f.offset < 0 ? '-' : '+'}${Math.abs(f.offset)} (${f.t.toFixed(3)})`;

// The frames at t + offset / 60 for each offset, in order, in the page open in B (renderFrame, then
// the canvas pixels), each cut to clip ([x, y, w, h] in canvas pixels) when given.
// -> [{ offset, t (the time drawn, as renderFrame returns it), rgb (Buffer, rows top first), w, h }]
export async function renderFrames(B, t, offsets, clip = null) {
  const out = [];
  for (const offset of offsets) {
    const drawn = await B.ev(`renderFrame(${t + offset / 60})`, 60000);
    const img = await readCanvas(B, `t=${drawn} (${offset >= 0 ? '+' : ''}${offset})`);
    let rgb = toRGB(img.px);
    let [w, h] = [img.w, img.h];
    if (clip) {
      const [x0, y0, cw, ch] = clip;
      if (x0 < 0 || y0 < 0 || x0 + cw > w || y0 + ch > h) throw new Error(`clip ${clip.join(',')} is not inside the ${w}x${h} frame`);
      const part = Buffer.alloc(cw * ch * 3);
      for (let y = 0; y < ch; y++) rgb.copy(part, y * cw * 3, ((y0 + y) * w + x0) * 3, ((y0 + y) * w + x0 + cw) * 3);
      [rgb, w, h] = [part, cw, ch];
    }
    out.push({ offset, t: drawn, rgb, w, h });
  }
  return out;
}

// The frames (renderFrames' { offset, t, rgb, w, h }) on one JPEG sheet: cols to a row in their
// order, each scaled down (Lanczos) to at most cell px wide and labelled under it with its offset
// and time. Pillow from .venv gets the pixels on its stdin. -> { w, h } of the sheet
export function writeSheet(frames, file, { cols = 5, cell = 640 } = {}) {
  if (!frames.length) throw new Error('writeSheet: no frames');
  if (!(Number.isInteger(cols) && cols > 0 && Number.isInteger(cell) && cell > 0)) throw new Error(`writeSheet: cols ${cols} and cell ${cell} must be whole numbers above 0`);
  const code = String.raw`
import json, sys
from PIL import Image, ImageDraw, ImageFont
file, quality, cols, cell, meta = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), json.loads(sys.argv[5])
data = sys.stdin.buffer.read()
font = ImageFont.load_default(size=18)
GAP, LABEL = 6, 26
cells, off = [], 0
for m in meta:
    n = m["w"] * m["h"] * 3
    im = Image.frombytes("RGB", (m["w"], m["h"]), data[off:off + n])
    off += n
    if im.width > cell:
        im = im.resize((cell, max(1, round(im.height * cell / im.width))), Image.LANCZOS)
    cells.append((im, m["label"]))
assert off == len(data), "%d bytes of pixels, %d read" % (len(data), off)
cw = max(im.width for im, _ in cells)
ch = max(im.height for im, _ in cells) + LABEL
ncol = min(cols, len(cells))
nrow = (len(cells) + ncol - 1) // ncol
sheet = Image.new("RGB", (GAP + ncol * (cw + GAP), GAP + nrow * (ch + GAP)), (24, 22, 20))
draw = ImageDraw.Draw(sheet)
for i, (im, text) in enumerate(cells):
    x = GAP + (i % ncol) * (cw + GAP)
    y = GAP + (i // ncol) * (ch + GAP)
    sheet.paste(im, (x, y))
    draw.text((x + 4, y + im.height + 3), text, fill=(240, 236, 228), font=font)
sheet.save(file, "JPEG", quality=quality, subsampling=0, optimize=True)
print(json.dumps([sheet.width, sheet.height]))
`;
  const meta = frames.map((f) => ({ w: f.w, h: f.h, label: label(f) }));
  for (const f of frames) {
    if (f.rgb.length !== f.w * f.h * 3) throw new Error(`writeSheet: frame ${label(f)} has ${f.rgb.length} bytes, not ${f.w}x${f.h}x3`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync(PY, ['-c', code, file, String(JPEG_QUALITY), String(cols), String(cell), JSON.stringify(meta)], {
    input: Buffer.concat(frames.map((f) => f.rgb)),
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  if (r.error) throw new Error(`could not run ${PY}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the sheet (Pillow) failed:\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
  const [w, h] = JSON.parse(r.stdout.trim().split('\n').pop());
  return { w, h };
}

const USAGE = 'usage: node tools/strip.mjs --t=<s> --frames=<-2,0,1,…> --out=<folder under local-only/temp/> [--w=1920] [--h=1080] [--q="…"] [--clip=x,y,w,h] [--cols=5] [--cell=640]';

async function main() {
  const T = Number(arg('t'));
  const FRAMES = String(arg('frames', '')).split(',').filter((s) => s.trim() !== '').map(Number);
  const OUT = arg('out');
  const W = Math.round(Number(arg('w', 1920)));
  const H = Math.round(Number(arg('h', 1080)));
  const Q = arg('q', '').replace(/^[?&]/, '');
  const CLIP = arg('clip') ? arg('clip').split(',').map(Number) : null;
  const COLS = Number(arg('cols', 5));
  const CELL = Number(arg('cell', 640));
  const clipOK = (c) => c.length === 4 && c.every(Number.isInteger) && c[0] >= 0 && c[1] >= 0 && c[2] > 0 && c[3] > 0 && c[0] + c[2] <= W && c[1] + c[3] <= H;
  const problems = [];
  if (!Number.isFinite(T)) problems.push('--t: a time in seconds');
  if (!FRAMES.length || !FRAMES.every((f) => Number.isInteger(f) && Math.abs(f) <= 999)) problems.push('--frames: whole frame offsets, -999..999, comma separated');
  else if (new Set(FRAMES).size !== FRAMES.length) problems.push('--frames: an offset twice');
  if (!(W > 0 && H > 0)) problems.push('--w, --h: the canvas size in pixels');
  if (CLIP && !clipOK(CLIP)) problems.push('--clip: whole pixels inside the frame');
  if (!(Number.isInteger(COLS) && COLS > 0)) problems.push('--cols: a whole number above 0');
  if (!(Number.isInteger(CELL) && CELL > 0)) problems.push('--cell: a whole number of pixels above 0');
  if (!OUT) problems.push('--out: the folder');
  if (problems.length) {
    console.error(USAGE);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(2);
  }
  const out = path.resolve(root, OUT);
  if (!inTemp(out)) {
    console.error(`--out must be a folder under local-only/temp/ (not in git), not ${OUT}`);
    process.exit(2);
  }

  const server = await startServer(PORT);
  let B = null;
  let code = 0;
  try {
    const query = `?w=${W}&h=${H}${Q ? '&' + Q : ''}`;
    B = await openBrowser(`http://localhost:${PORT}/${query}#t=${T + FRAMES[0] / 60}`, { w: W, h: H });
    const info = await B.ev('window.FR_INFO()');
    if (info.width !== W || info.height !== H) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${W}x${H}`);
    const frames = await renderFrames(B, T, FRAMES, CLIP);
    if (B.logs.length) console.log('page messages:\n  ' + B.logs.join('\n  '));
    // this folder holds one run: the frames and the sheet of an earlier one go first
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) if (FRAME_FILE.test(f) || f === 'sheet.jpg') fs.rmSync(path.join(out, f));
    for (const f of frames) writePNG(path.join(out, frameFile(f.offset)), f.rgb, f.w, f.h);
    const sheet = writeSheet(frames, path.join(out, 'sheet.jpg'), { cols: COLS, cell: CELL });
    console.log(
      `t=${T} ${W}x${H}${Q ? ' ' + Q : ''}${CLIP ? ` clip ${CLIP.join(',')}` : ''} | GPU ${info.gpu} | msaa ${info.samples} | ` +
        `collage ${info.collage.strength}`,
    );
    for (const f of frames) console.log(`  ${frameFile(f.offset)}  ${label(f)}`);
    console.log(`  sheet.jpg  ${sheet.w}x${sheet.h}, ${COLS} to a row, cells up to ${CELL} px wide -> ${path.relative(root, out)}`);
  } catch (e) {
    console.error('FAILED: ' + (e && e.stack ? e.stack : e));
    if (B && B.logs.length) console.error('page messages:\n  ' + B.logs.join('\n  '));
    code = 1;
  } finally {
    if (B) await B.close();
    await server.close();
  }
  process.exit(code);
}

// run when called as a tool (importing it, for renderFrames and writeSheet, runs nothing)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

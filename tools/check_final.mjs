// The finished frame against the key image, pixel for pixel (design 10.4).
//
//   node tools/check_final.mjs [--t=44.9,45.2]
//
// Renders ?ref=1&fx=0 (the key image through the stage fit) and each time t with ?fx=0, all at
// 2944 x 1648 (the picture's own scale, so the fit is exact), reads the canvas back with
// readPixels and compares RGB: PASS when the largest absolute difference is at most MAX_DIFF and
// the mean (over every pixel and channel) at most MEAN_DIFF, both 0..255. Writes a difference
// map per time: local-only/temp/final_diff.png for the first time, final_diff_<t>.png for the others
// (the key in dim grey; differing pixels from yellow to red, the brighter the larger).
//
// So that two equally broken frames cannot pass, it also FAILs when
// - drawing left a WebGL error (gl.getError) or the page logged an exception or a console error;
// - the reference is not the key image: its luminance must spread (REF_MIN_STD) and a grid of its
//   pixels must match assets/key_hires.png reduced 2 x 2 at the same places (the reference
//   samples the 5888 x 3296 texture's mip level 1, a 2 x 2 box at this exact fit) within MAX_DIFF.
// Browser, server and capture (grab: one fresh browser per frame, readPixels): tools/browser.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { root, arg, startServer, grab, writePNG, PORT } from './browser.mjs';
import { TEMP } from './paths.mjs';

const W = 2944;
const H = 1648;
const MAX_DIFF = 3;
const MEAN_DIFF = 0.2;
const REF_MIN_STD = 20; // the reference's luminance spread (0..255) at least this
const REF_GRID = [32, 18]; // reference pixels checked against the key image file
const KEY_FILE = path.join(root, 'assets', 'key_hires.png');
const TIMES = arg('t', '44.9,45.2').split(',').map(Number);
if (!TIMES.length || !TIMES.every(Number.isFinite)) {
  console.error('usage: node tools/check_final.mjs [--t=44.9,45.2]');
  process.exit(2);
}

// An 8-bit RGB or RGBA PNG, not interlaced -> { w, h, ch, data } (rows top first, ch bytes a pixel).
function readPNG(file) {
  const b = fs.readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const name = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (name === 'IHDR') [w, h, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`${file}: not an 8-bit RGB(A) PNG`);
  const ch = type === 2 ? 3 : 4;
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0; // left
      const u = y > 0 ? out[dst - stride + x] : 0; // up
      const c = x >= ch && y > 0 ? out[dst - stride + x - ch] : 0; // up left
      let p;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = u;
      else if (f === 3) p = (a + u) >> 1;
      else if (f === 4) {
        const pa = Math.abs(u - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + u - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
      } else throw new Error(`${file}: row ${y} has filter ${f}`);
      out[dst + x] = (raw[src + x] + p) & 255;
    }
  }
  return { w, h, ch, data: out };
}

// The reference must be the key image: its luminance spreads, and a grid of its pixels equals the
// key file reduced 2 x 2 at the same places. -> a line for the log; throws when it is not.
function checkReference(ref) {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < W * H; i++) {
    const l = 0.299 * ref[i * 4] + 0.587 * ref[i * 4 + 1] + 0.114 * ref[i * 4 + 2];
    s += l;
    s2 += l * l;
  }
  const mean = s / (W * H);
  const std = Math.sqrt(Math.max(0, s2 / (W * H) - mean * mean));
  if (!(std >= REF_MIN_STD)) throw new Error(`the reference is not a picture: luminance spread ${std.toFixed(1)} (< ${REF_MIN_STD})`);
  const key = readPNG(KEY_FILE);
  if (key.w !== 2 * W || key.h !== 2 * H) throw new Error(`${KEY_FILE} is ${key.w}x${key.h}, wanted ${2 * W}x${2 * H}`);
  let worst = 0;
  let n = 0;
  for (let j = 0; j < REF_GRID[1]; j++) {
    for (let i = 0; i < REF_GRID[0]; i++) {
      const x = Math.floor(((i + 0.5) * W) / REF_GRID[0]);
      const y = Math.floor(((j + 0.5) * H) / REF_GRID[1]);
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) v += key.data[((2 * y + dy) * key.w + 2 * x + dx) * key.ch + c];
        worst = Math.max(worst, Math.abs(ref[(y * W + x) * 4 + c] - v / 4));
      }
      n++;
    }
  }
  if (worst > MAX_DIFF) throw new Error(`the reference is not the key image: ${n} grid pixels differ from the key file by up to ${worst.toFixed(2)}`);
  return `reference is the key image: luminance spread ${std.toFixed(1)}, ${n} grid pixels within ${worst.toFixed(2)} of the key file (2x2)`;
}

// Compare two RGBA frames (RGB only) -> stats, and the difference map as RGB.
function compare(ref, img) {
  const n = W * H;
  const map = Buffer.alloc(n * 3);
  let max = 0;
  let sum = 0;
  let over = 0;
  let differ = 0;
  const worst = [];
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(ref[i * 4 + c] - img[i * 4 + c]);
      sum += d;
      if (d > m) m = d;
    }
    hist[m]++;
    if (m > 0) differ++;
    if (m > MAX_DIFF) over++;
    if (m > max) max = m;
    if (m > MAX_DIFF && worst.length < 12) worst.push([i % W, Math.floor(i / W), m]);
    const g = Math.round((0.299 * ref[i * 4] + 0.587 * ref[i * 4 + 1] + 0.114 * ref[i * 4 + 2]) * 0.3);
    if (m === 0) {
      map[i * 3] = g;
      map[i * 3 + 1] = g;
      map[i * 3 + 2] = g;
    } else {
      // 1 -> yellow, MAX_DIFF and above -> full red, past 4 x MAX_DIFF -> white hot
      const k = Math.min(1, m / MAX_DIFF);
      map[i * 3] = 255;
      map[i * 3 + 1] = Math.round(220 * (1 - k)) + (m > 4 * MAX_DIFF ? 200 : 0);
      map[i * 3 + 2] = m > 4 * MAX_DIFF ? 200 : 0;
    }
  }
  return { max, mean: sum / (n * 3), differ, over, worst, hist, map };
}

export { readPNG, checkReference, W, H };

async function main() {
  const server = await startServer(PORT);
  let code = 0;
  try {
    console.log(`reference: ?ref=1&fx=0 at ${W}x${H}`);
    const ref = await grab('ref=1&fx=0', 0, [W, H]);
    console.log(`GPU ${ref.gpu}`);
    console.log(checkReference(ref.px));
    for (const [j, t] of TIMES.entries()) {
      const img = await grab('fx=0', t, [W, H]);
      const r = compare(ref.px, img.px);
      const ok = r.max <= MAX_DIFF && r.mean <= MEAN_DIFF;
      const file = path.join(TEMP, j === 0 ? 'final_diff.png' : `final_diff_${t}.png`);
      writePNG(file, r.map, W, H);
      const hist = r.hist.map((c, d) => [d, c]).filter(([d, c]) => d > 0 && c > 0).map(([d, c]) => `${d}:${c}`).join(' ');
      console.log(
        `t=${t}: ${ok ? 'PASS' : 'FAIL'}  max ${r.max} (<= ${MAX_DIFF})  mean ${r.mean.toFixed(4)} (<= ${MEAN_DIFF})  ` +
          `pixels differing ${r.differ}, over ${MAX_DIFF}: ${r.over}  -> ${path.relative(root, file)}`,
      );
      if (hist) console.log(`  largest channel difference per pixel (difference:pixels): ${hist}`);
      if (r.worst.length) console.log(`  first pixels over ${MAX_DIFF} (x, y, diff): ${r.worst.map((w) => `(${w.join(', ')})`).join(' ')}`);
      if (!ok) code = 1;
    }
  } catch (e) {
    console.error('FAILED: ' + (e && e.stack ? e.stack : e));
    code = 1;
  } finally {
    await server.close();
  }
  console.log(code ? 'FAIL' : 'PASS');
  process.exit(code);
}

// run when called as a tool (importing it, e.g. to try checkReference, runs nothing)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

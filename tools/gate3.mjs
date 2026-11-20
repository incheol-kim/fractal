// Review gate 3 (the whole piece in the browser): fourteen 4K stills from 2.0 to 47.6 s and the
// variant sheets (1080p frames of each value of a variant on one JPEG), all in the strength the video
// is exported in (high), into docs/review/gate3/; and the frame times of the whole piece.
//
//   node tools/gate3.mjs [--out=gate3] [--png] [--stills]
//                          the stills and the variant sheets into docs/review/<out>/ (refuses if it
//                          already holds pictures, JPEG or PNG). Runs tools/make_collage.py --check
//                          first and stops unless it passes (the baked cuts must be there and current).
//                          The stills are JPEG, quality 95 with 4:4:4 chroma, made from the captured
//                          pixels with Pillow (.venv's Python), as tools/gate2b.mjs; the sheets are
//                          JPEG of the same quality (writeSheet in tools/strip.mjs). --png writes the
//                          same pictures lossless into local-only/review-lossless/<out>/ instead (not in git;
//                          refused too if it holds pictures) and nothing into docs/review/: the stills
//                          as PNG, and for each sheet its frames as PNG (<sheet>_+<offset>.png, the
//                          numbers under the sheet's cells) beside the sheet itself (a sheet is a JPEG
//                          by construction). Everything is written into local-only/temp/gate3_tmp/ first
//                          (git-ignored: a run killed half-way leaves nothing git sees) and moved in
//                          only when every file exists; on failure the temporary folder is removed.
//                          --stills makes the stills only (see "After Task 12" below).
//                          Test switch: GATE3_FAIL_AT=<n> makes capture n fail (both attempts): 0..13
//                          the stills, from 14 on the sheets' browsers in the order of SHEETS and values.
//   node tools/gate3.mjs --bench[=json]
//                          GPU-synced frame times at 1920x1080 and 3840x2160, t = 0.0..47.5 s every
//                          0.5 s, in high, as tools/gate2b.mjs --bench measures them; then the same
//                          times again with the picture in picture off (?pip=0, set by setVariant in
//                          the same page), for the windows' cost; FR_INFO().memory per size. Prints a
//                          table; --bench=<file> also writes every time as JSON.
//
// Stills: 3840 x 2160, one fresh browser per still (grab in tools/browser.mjs: canvas pixels by
// gl.readPixels), ?collage=high and no variant in the address, so every variant is at its default.
// The page must say it draws high (FR_INFO().collage.strength) with the full-size pictures.
// Sheets: 1920 x 1080, one browser per value of a variant (?collage=high&<name>=<value>; the other
// variants at their defaults) that draws t + f / 60 for each frame offset f (renderFrames in
// tools/strip.mjs; a sheet with a clip keeps that part of each frame) and lays them out with
// writeSheet, labelled with the offset and the time drawn.
// The title's sheets are on the video's own frame grid (t = 0, offsets = frame numbers at 60 fps:
// 2713 is the last frame without the title, 2714 the first with it, 2.6 ms after the beat), because
// that is what the exported video will contain; the others are at the brief's times after a note.
// Bench: one headless Edge per size; at each time one frame is drawn to warm up, then REPS frames are
// timed from renderFrame(t) to a one-pixel readPixels (which waits until the GPU has finished; under
// ANGLE gl.finish does not), and the time's median is kept; FR_INFO().calls after each time says
// whether the windows were drawn (their levels are extra passes). The tool does not know the
// machine's power mode: in a power-saving mode the times come out about twice as large, while the
// ratio with and without the windows does not change. Vite server on port 5199. Every capture has one
// retry; retries are reported.
//
// The variants: this tool carries its own list of the variants it renders (SHEETS: name, values,
// time, frames), copied from plan 3's variants table, and does not import src/variants.js. Task 12
// removes that table (with the address options and FR_INFO().variants) once the owner has chosen, and
// this tool must not break then. After Task 12: the variant sheets can only be made again on a page
// from before Task 12 (a later page has no ?<variant>= option; the tool stops and says so); the stills
// can be made again (--stills), and then show the values that were chosen.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, arg, startServer, openBrowser, grab, toRGB, writePNG, PORT } from './browser.mjs';
import { renderFrames, writeSheet } from './strip.mjs';
import { TEMP, LOSSLESS } from './paths.mjs';

const STRENGTH = 'high'; // the strength the video is exported in
const [W, H] = [3840, 2160];
const SHEET_SIZE = [1920, 1080];
const BENCH_FROM = 0.0;
const BENCH_TO = 47.5;
const BENCH_STEP = 0.5;
const BENCH_SIZES = [[1920, 1080], [3840, 2160]];
const REPS = 5; // timed frames per time; their median is kept (a lone hiccup of the headless browser is not)
const FRAME_MS = 1000 / 60;
const JPEG_QUALITY = 95; // with chroma subsampling off (4:4:4)
const PY = path.join(root, '.venv', 'Scripts', 'python.exe');

// the stills, at the plan's times (s) and names
const STILLS = [
  [2.0, 'lines'],
  [13.5, 'tower_wash'],
  [20.5, 'first_window'],
  [28.0, 'collage_windows'],
  [30.35, 'sky'],
  [34.12, 'hit'],
  [36.0, 'rooms'],
  [37.87, 'fold'],
  [40.0, 'chords'],
  [41.5, 'press'],
  [43.2, 'tree'],
  [44.9, 'finished'],
  [45.25, 'title'],
  [47.6, 'silent_end'], // after the audio (47.08 s), in the silent 0.65 s
].map(([t, name]) => ({ t, file: `t${t.toFixed(2).padStart(5, '0')}_${name}.png` }));

// The variant sheets: the variant (name, as the page's address takes it), the values drawn (the
// default first), the time t and the frame offsets f (each frame is t + f / 60), the part of the
// frame kept (clip: x, y, w, h in 1080p pixels; none: the whole frame), and the sheet's layout
// (writeSheet: cols to a row, each cell at most cell px wide). One file per value:
// sheet_<name>[_<tag>]_<value>.jpg.
//   fold   the 37.81 chord's colour blocks standing up: the landing note, +2, +4, +8 frames (the
//          plan's) and +12, where b leans back past upright (its frames 10 to 15)
//   smear  the sky sliding in at 30.32 (+1..+3; the plan's sheet) and, tagged hit, the 34.08 hit's
//          big pieces slamming in (+1..+3), where the stretch can be seen (the sky shows none), as
//          the middle of the frame at 1:1 (at half size the stretch is easily missed)
//   tape   one frame at 34.5 s at full size (the strips are small)
//   title  the video's frames 2713 (no title yet), 2714 (the first with it), 2715, 2716 and 2744
//   pip    24.0, 28.0 and 33.0 s at full size (the miniatures are small)
const SHEETS = [
  { name: 'fold', values: ['a', 'b', '0'], t: 37.8154, frames: [0, 2, 4, 8, 12], cols: 3, cell: 960 },
  { name: 'smear', values: ['1', '0'], t: 30.3183, frames: [1, 2, 3], cols: 3, cell: 960 },
  { name: 'smear', tag: 'hit', values: ['1', '0'], t: 34.0769, frames: [1, 2, 3], clip: [480, 0, 960, 540], cols: 3, cell: 960 },
  { name: 'tape', values: ['1', '0'], t: 34.5, frames: [0], cols: 1, cell: 1920 },
  { name: 'title', values: ['b', 'a', 'c'], t: 0, frames: [2713, 2714, 2715, 2716, 2744], cols: 3, cell: 960 },
  { name: 'pip', values: ['1', '0'], t: 24.0, frames: [0, 240, 540], cols: 1, cell: 1920 },
];
const sheetBase = (s, value) => `sheet_${s.name}${s.tag ? `_${s.tag}` : ''}_${value}`;
// a sheet's frame as a lossless file (--png): sheet_fold_a_+2.png, sheet_title_b_+2714.png
const frameFile = (base, offset) => `${base}_${offset < 0 ? '-' : '+'}${Math.abs(offset)}.png`;

const OUT_NAME = arg('out', 'gate3');
if (!/^[\w.-]+$/.test(OUT_NAME) || OUT_NAME.startsWith('.')) throw new Error(`bad --out name: ${OUT_NAME}`);
const PNG = process.argv.includes('--png');
const STILLS_ONLY = process.argv.includes('--stills');
const BENCH = process.argv.some((a) => a === '--bench' || a.startsWith('--bench='));
const OUT_DIR = PNG ? path.join(LOSSLESS, OUT_NAME) : path.join(root, 'docs', 'review', OUT_NAME);
const TMP_DIR = path.join(TEMP, 'gate3_tmp', PNG ? `${OUT_NAME}_png` : OUT_NAME); // git-ignored scratch, same disk
const FAIL_AT = process.env.GATE3_FAIL_AT === undefined ? -1 : Number(process.env.GATE3_FAIL_AT);
let retries = 0;

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const mb = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

// The baked cuts must exist and match the list and the score (tools/make_collage.py --check).
function checkCuts() {
  const r = spawnSync(PY, [path.join('tools', 'make_collage.py'), '--check'], { cwd: root, encoding: 'utf8' });
  if (r.error) throw new Error(`could not run ${PY}: ${r.error.message}`);
  const said = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tools/make_collage.py --check did not pass (bake the cuts: tools/make_collage.py --bake):\n${said}`);
  console.log(`make_collage.py --check: ${said}`);
}

// Each PNG -> a JPEG of the same name (quality JPEG_QUALITY, 4:4:4) next to it; the PNG is removed.
// Pillow from .venv (Node has no JPEG encoder here).
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
  if (r.error) throw new Error(`could not run ${PY}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the JPEG conversion (Pillow) failed:\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
}

// fn(), once more if it throws; capture n fails both times when GATE3_FAIL_AT=n
async function twice(n, label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (n === FAIL_AT) throw new Error(`forced failure (GATE3_FAIL_AT=${n})`);
      return await fn();
    } catch (e) {
      if (attempt === 1) throw e;
      console.log(`retry for ${label}: ${e.message}`);
      retries++;
    }
  }
}

// the page in B draws w x h in high with the full-size pictures, else throws
function checkPage(info, w, h, what) {
  if (info.width !== w || info.height !== h) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${w}x${h} (${what})`);
  if (info.collage.strength !== STRENGTH) throw new Error(`the page draws strength '${info.collage.strength}', wanted '${STRENGTH}' (${what})`);
  if (info.tex !== 'full') throw new Error(`the page uses tex=${info.tex}, wanted the full-size pictures (${what})`);
}

// The page has the variant name with value among its values, else throws: after Task 12 the page has
// no variants (FR_INFO().variants is gone) and the sheets cannot be made from it.
function checkVariant(info, name, value) {
  if (!info.variants || !Object.hasOwn(info.variants, name)) {
    throw new Error(
      `the page has no variant '${name}': the variant sheets can only be made on a page from before Task 12, ` +
        'which removed the variants once the owner had chosen (node tools/gate3.mjs --stills makes the stills alone)',
    );
  }
  if (info.variants[name] !== value) throw new Error(`the page draws ${name}=${info.variants[name]}, wanted ${name}=${value}`);
}

// One value of a sheet in one browser: its frames, the sheet into dir (and with --png each frame as
// a lossless PNG). -> { gpu, files, times }
async function sheet(s, value, dir) {
  const [w, h] = SHEET_SIZE;
  const base = sheetBase(s, value);
  const B = await openBrowser(`http://localhost:${PORT}/?w=${w}&h=${h}&collage=${STRENGTH}&${s.name}=${value}#t=${s.t + s.frames[0] / 60}`, { w, h });
  try {
    const info = await B.ev('window.FR_INFO()');
    checkPage(info, w, h, base);
    checkVariant(info, s.name, value);
    const frames = await renderFrames(B, s.t, s.frames, s.clip || null);
    if (B.logs.length) console.log(`page messages (${base}):\n  ` + B.logs.join('\n  '));
    const files = [`${base}.jpg`];
    const size = writeSheet(frames, path.join(dir, files[0]), { cols: s.cols, cell: s.cell });
    if (PNG) {
      for (const f of frames) {
        const file = frameFile(base, f.offset);
        writePNG(path.join(dir, file), f.rgb, f.w, f.h);
        files.push(file);
      }
    }
    return { gpu: info.gpu, files, size, times: frames.map((f) => f.t) };
  } finally {
    await B.close();
  }
}

async function stills() {
  if (fs.existsSync(OUT_DIR) && fs.readdirSync(OUT_DIR).some((f) => /\.(png|webp|jpe?g)$/i.test(f))) {
    throw new Error(`${path.relative(root, OUT_DIR)} already holds pictures; a review bundle (and its lossless twin) is never overwritten`);
  }
  checkCuts();
  fs.rmSync(TMP_DIR, { recursive: true, force: true }); // left over from a crashed run
  const server = await startServer(PORT);
  const stillFiles = [];
  const files = [];
  let done = false;
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const [n, s] of STILLS.entries()) {
      const t0 = Date.now();
      const img = await twice(n, s.file, async () => {
        const r = await grab(`collage=${STRENGTH}`, s.t, [W, H]); // one fresh browser per still
        checkPage(r.info, W, H, s.file);
        return r;
      });
      // the sheets need the page's variants: say so after the first still, not after all of them
      if (n === 0 && !STILLS_ONLY) for (const sh of SHEETS) checkVariant(img.info, sh.name, sh.values[0]);
      writePNG(path.join(TMP_DIR, s.file), toRGB(img.px), W, H);
      stillFiles.push(s.file);
      const variants = img.info.variants ? Object.entries(img.info.variants).map(([k, v]) => `${k} ${v}`).join(' ') : 'none';
      console.log(`${s.file}  ${fs.statSync(path.join(TMP_DIR, s.file)).size} bytes  ${((Date.now() - t0) / 1000).toFixed(0)} s  (${img.info.collage.strength}, variants: ${variants}, GPU ${img.gpu})`);
    }
    if (!STILLS_ONLY) {
      let n = STILLS.length;
      for (const s of SHEETS) {
        for (const value of s.values) {
          const t0 = Date.now();
          const base = sheetBase(s, value);
          const r = await twice(n++, base, () => sheet(s, value, TMP_DIR));
          files.push(...r.files);
          console.log(`${base}.jpg  ${r.size.w}x${r.size.h}  t ${r.times.map((t) => t.toFixed(4)).join(', ')}  ${fs.statSync(path.join(TMP_DIR, `${base}.jpg`)).size} bytes  ${((Date.now() - t0) / 1000).toFixed(0)} s  (GPU ${r.gpu})`);
        }
      }
    }
    // the stills are captured as lossless PNG; unless --png, each becomes a JPEG in the temporary folder
    let out = stillFiles;
    if (!PNG) {
      toJPEG(stillFiles.map((f) => path.join(TMP_DIR, f)));
      out = stillFiles.map((f) => f.replace(/\.png$/, '.jpg'));
    }
    out = [...out, ...files];
    let total = 0;
    for (const f of out) total += fs.statSync(path.join(TMP_DIR, f)).size;
    const kind = PNG ? `lossless PNG${STILLS_ONLY ? '' : ' (sheets JPEG)'}` : `JPEG quality ${JPEG_QUALITY}, 4:4:4`;
    console.log(`${kind}: ${out.length} files, ${total} bytes`);
    // every file exists: move them in (the folder may exist, e.g. holding only the page)
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of out) fs.renameSync(path.join(TMP_DIR, f), path.join(OUT_DIR, f));
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    done = true;
    console.log(`${out.length} files in ${path.relative(root, OUT_DIR)}; retries: ${retries}`);
  } finally {
    if (!done) fs.rmSync(TMP_DIR, { recursive: true, force: true });
    await server.close();
  }
}

// Every time in times drawn once to warm up, then REPS timed frames (renderFrame to a one-pixel read,
// which returns when the GPU is done), and the draw calls of the frame. -> [{ t, ms, median, calls }]
async function timeAll(B, times) {
  const per = await B.ev(`(async () => {
    const gl = document.getElementById('view').getContext('webgl2');
    const px = new Uint8Array(4);
    const out = [];
    for (const t of ${JSON.stringify(times)}) {
      // warm-up: the first frame at this time, waited for, so that no timed frame also waits for the
      // GPU work of the frame before it
      await renderFrame(t);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const ms = [];
      for (let i = 0; i < ${REPS}; i++) {
        const t0 = performance.now();
        await renderFrame(t);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // returns when the GPU is done
        ms.push(performance.now() - t0);
      }
      out.push({ t, ms, calls: window.FR_INFO().calls });
    }
    return out;
  })()`, 900000);
  for (const p of per) p.median = median(p.ms);
  return per;
}

async function bench() {
  const times = [];
  for (let i = 0; BENCH_FROM + i * BENCH_STEP <= BENCH_TO + 1e-9; i++) times.push(Number((BENCH_FROM + i * BENCH_STEP).toFixed(2)));
  const server = await startServer(PORT);
  const rows = [];
  try {
    for (const [w, h] of BENCH_SIZES) {
      let B = null;
      try {
        B = await openBrowser(`http://localhost:${PORT}/?w=${w}&h=${h}&collage=${STRENGTH}#t=${times[0]}`, { w, h });
        const info = await B.ev('window.FR_INFO()');
        checkPage(info, w, h, `bench ${w}x${h}`);
        const per = await timeAll(B, times);
        // the same times with the picture in picture off, in the same page (none after Task 12)
        const off = await B.ev(`typeof window.setVariant === 'function' && window.setVariant('pip', '0')`);
        if (off) {
          const offPer = await timeAll(B, times);
          for (const [i, p] of per.entries()) p.off = { ms: offPer[i].ms, median: offPer[i].median, calls: offPer[i].calls };
        }
        if (B.logs.length) console.log(`page messages (${w}x${h}):\n  ` + B.logs.join('\n  '));
        if (B.logs.some((l) => l.startsWith('exception:') || l.startsWith('error:'))) throw new Error(`the page reported errors while timing ${w}x${h}`);
        const meds = per.map((p) => p.median);
        const slow = per.reduce((a, p) => (p.median > a.median ? p : a));
        const worst = per.reduce((a, p) => (Math.max(...p.ms) > Math.max(...a.ms) ? p : a));
        // the times the windows were drawn: their levels are extra passes, so more draw calls than
        // the same time with pip=0
        const win = off ? per.filter((p) => p.calls > 1.5 * p.off.calls) : [];
        const windows = win.length
          ? {
              n: win.length,
              from: win[0].t,
              to: win[win.length - 1].t,
              on: median(win.map((p) => p.median)),
              off: median(win.map((p) => p.off.median)),
              ratio: median(win.map((p) => p.median / p.off.median)),
            }
          : null;
        rows.push({
          w, h, gpu: info.gpu, strength: info.collage.strength, cuts: info.collage.images, memory: info.memory,
          reps: REPS, n: per.length,
          min: Math.min(...meds), median: median(meds), max: slow.median, maxAt: slow.t,
          worstFrame: Math.max(...worst.ms), worstAt: worst.t,
          over: meds.filter((m) => m > FRAME_MS).length,
          windows,
          times: per,
        });
      } finally {
        if (B) await B.close();
      }
    }
  } finally {
    await server.close();
  }
  for (const r of rows) {
    const m = r.memory || {};
    console.log(
      `${r.w}x${r.h} | GPU ${r.gpu} | ${r.strength}, ${r.cuts} cuts loaded | ${r.n} times x ${r.reps} | ` +
        `per-time median: min ${r.min.toFixed(2)} / median ${r.median.toFixed(2)} / max ${r.max.toFixed(2)} ms (at ${r.maxAt} s) | ` +
        `slowest single frame ${r.worstFrame.toFixed(2)} ms (at ${r.worstAt} s) | over ${FRAME_MS.toFixed(1)} ms: ${r.over} of ${r.n}`,
    );
    console.log(
      r.windows
        ? `  windows drawn at ${r.windows.n} times (${r.windows.from}-${r.windows.to} s): median ${r.windows.on.toFixed(2)} ms with them, ${r.windows.off.toFixed(2)} ms with pip=0 (ratio ${r.windows.ratio.toFixed(2)})`
        : '  windows: not measured (the page has no variant pip, or no time drew a window)',
    );
    console.log(`  memory: collage ${mb(m.collage || 0)}, life map ${mb(m.life || 0)}, picture in picture ${mb(m.pip || 0)}`);
  }
  const f = arg('bench');
  if (f) fs.writeFileSync(path.resolve(root, f), JSON.stringify(rows, null, 2) + '\n');
}

try {
  await (BENCH ? bench() : stills());
  process.exit(0);
} catch (e) {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}

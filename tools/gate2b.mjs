// Review gate 2b (collage look test): twelve 4K stills of 19.3-41.6 s and, for each of the
// collage's three strengths, six 1080p frames after six cello notes, into docs/review/gate2b/.
//
//   node tools/gate2b.mjs [--out=gate2b] [--png]
//                                          the stills and strips into docs/review/<out>/ (refuses if it already
//                                          holds stills, JPEG or PNG). Runs tools/make_collage.py --check first and
//                                          stops unless it passes (the baked cuts must be there and current). The
//                                          files are JPEG, quality 95 with 4:4:4 chroma (the repository is kept
//                                          small; torn edges, shadows and lines can still be judged at 100 %),
//                                          made from the captured pixels with Pillow (.venv's Python); --png keeps
//                                          lossless PNG instead (for local use). Written into
//                                          local-only/temp/gate2b_tmp/<out>/ first (not in git: a run killed
//                                          half-way leaves nothing git sees) and moved in only when every file
//                                          exists; on failure the temporary folder is removed. Test switch:
//                                          GATE2B_FAIL_AT=<0..14> makes that capture fail (both attempts):
//                                          0..11 the stills, 12..14 the strips of calm, mid, high.
//   node tools/gate2b.mjs --bench[=json]   GPU-synced frame times at 1920x1080 and 3840x2160, t = 15.0..42.0 s
//                                          every 0.5 s, in the score's default strength (prints a table;
//                                          --bench=<file> also writes every time as JSON)
//
// Stills: 3840 x 2160 in the score's default strength (score.collage.default), one fresh browser
// per still (grab in tools/browser.mjs: canvas pixels by gl.readPixels). Strips: 1920 x 1080, one
// browser per strength (?collage=<name>) that draws, for each of the first six cello notes after
// STRIP_AFTER s, the note's time + STRIP_LAG (strip_<name>_<1..6>.jpg, .png with --png), and prints how many blocks
// change their cut on that note. Bench: one headless Edge per size; at each time one frame is drawn
// to warm up, then REPS frames are timed from renderFrame(t) to a one-pixel readPixels (which waits
// until the GPU has finished; renderFrame now ends with the same read, gl.finish does not wait under
// ANGLE; the warm-up frame is waited for the same way), and the time's median is kept. Vite server on
// port 5199. Every capture has one retry; retries are reported.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, arg, startServer, openBrowser, grab, readCanvas, toRGB, writePNG, PORT } from './browser.mjs';
import { TEMP } from './paths.mjs';

const [W, H] = [3840, 2160];
const STRIP_SIZE = [1920, 1080];
const STRIP_AFTER = 27.0; // the strips follow the first six cello notes after this time (s)
const STRIP_LAG = 0.1; // each frame this long after its note (s): the paste (2 frames) is over
const STRIP_NAMES = ['calm', 'mid', 'high'];
const BENCH_FROM = 15.0;
const BENCH_TO = 42.0;
const BENCH_STEP = 0.5;
const REPS = 5; // timed frames per time; their median is kept (a lone hiccup of the headless browser, 0.1-0.5 s, is not)
const FRAME_MS = 1000 / 60;
const JPEG_QUALITY = 95; // with chroma subsampling off (4:4:4)
const PY = path.join(root, '.venv', 'Scripts', 'python.exe');

// The plan's times, but the run at 31.27, not 31.20: at 31.20 nothing is being torn (tree_green's
// tear ends at 31.148, yellow_block's starts at 31.224, TEAR = 8 frames); at 31.27 its wrong
// fragment is coming off and the photo shows through the ink flash under it.
const STILLS = [
  [19.3, 'two_bars'],
  [21.0, 'first_fragments'],
  [23.1, 'covered'],
  [26.5, 'crescendo'],
  [29.9, 'other_cities'],
  [31.27, 'run'],
  [33.0, 'solo'],
  [34.16, 'hit'],
  [36.0, 'rooms'],
  [39.8, 'chords'],
  [41.3, 'before_glue'],
  [41.6, 'one_picture'],
].map(([t, name]) => ({ t, file: `t${t.toFixed(2).padStart(5, '0')}_${name}.png` }));

const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const score = readJSON('assets/score.json');
const DEFAULT = score.collage && score.collage.default;
if (!DEFAULT) throw new Error('assets/score.json has no collage (score.collage.default)');
for (const name of STRIP_NAMES) {
  if (!score.collage.changes[name]) throw new Error(`assets/score.json has no collage strength '${name}'`);
}
// the strips' notes: assets/music.json cello rows are [t, duration, pitch, velocity]; a change's
// `note` is its row
const cello = readJSON('assets/music.json').cello;
const STRIP = cello
  .map((c, note) => ({ note, at: c[0] }))
  .filter((c) => c.at > STRIP_AFTER)
  .slice(0, 6)
  .map((c, i) => ({ ...c, n: i + 1, t: Number((c.at + STRIP_LAG).toFixed(4)) }));
if (STRIP.length !== 6) throw new Error(`only ${STRIP.length} cello notes after ${STRIP_AFTER} s`);
const stripFile = (name, n) => `strip_${name}_${n}.png`;

const OUT_NAME = arg('out', 'gate2b');
if (!/^[\w.-]+$/.test(OUT_NAME) || OUT_NAME.startsWith('.')) throw new Error(`bad --out name: ${OUT_NAME}`);
const OUT_DIR = path.join(root, 'docs', 'review', OUT_NAME);
const TMP_DIR = path.join(TEMP, 'gate2b_tmp', OUT_NAME); // git-ignored scratch, same disk
const FAIL_AT = process.env.GATE2B_FAIL_AT === undefined ? -1 : Number(process.env.GATE2B_FAIL_AT);
const BENCH = process.argv.some((a) => a === '--bench' || a.startsWith('--bench='));
const PNG = process.argv.includes('--png');
let retries = 0;

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

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

// fn(), once more if it throws; capture n fails both times when GATE2B_FAIL_AT=n
async function twice(n, label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (n === FAIL_AT) throw new Error(`forced failure (GATE2B_FAIL_AT=${n})`);
      return await fn();
    } catch (e) {
      if (attempt === 1) throw e;
      console.log(`retry for ${label}: ${e.message}`);
      retries++;
    }
  }
}

// One strength's six frames in one browser, written into dir. -> GPU name
async function strip(name, dir) {
  const [w, h] = STRIP_SIZE;
  const B = await openBrowser(`http://localhost:${PORT}/?w=${w}&h=${h}&collage=${name}#t=${STRIP[0].t}`, { w, h });
  try {
    const info = await B.ev('window.FR_INFO()');
    if (info.width !== w || info.height !== h) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${w}x${h}`);
    if (info.collage.strength !== name) throw new Error(`the page draws strength '${info.collage.strength}', wanted '${name}'`);
    if (info.tex !== 'full') throw new Error(`the page uses tex=${info.tex}, wanted the full-size pictures`);
    for (const s of STRIP) {
      await B.ev(`renderFrame(${s.t})`, 60000);
      const img = await readCanvas(B, `collage=${name} t=${s.t}`);
      writePNG(path.join(dir, stripFile(name, s.n)), toRGB(img.px), img.w, img.h);
    }
    if (B.logs.length) console.log(`page messages (collage=${name}):\n  ` + B.logs.join('\n  '));
    return info.gpu;
  } finally {
    await B.close();
  }
}

async function stills() {
  if (fs.existsSync(OUT_DIR) && fs.readdirSync(OUT_DIR).some((f) => /\.(png|webp|jpe?g)$/i.test(f))) {
    throw new Error(`${path.relative(root, OUT_DIR)} already holds stills; a review bundle is never overwritten`);
  }
  checkCuts();
  fs.rmSync(TMP_DIR, { recursive: true, force: true }); // left over from a crashed run
  const server = await startServer(PORT);
  const files = [];
  let done = false;
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const [n, s] of STILLS.entries()) {
      const t0 = Date.now();
      const img = await twice(n, s.file, async () => {
        const r = await grab(`collage=${DEFAULT}`, s.t, [W, H]); // one fresh browser per still
        if (r.info.collage.strength !== DEFAULT) throw new Error(`the page draws strength '${r.info.collage.strength}', wanted '${DEFAULT}'`);
        return r;
      });
      writePNG(path.join(TMP_DIR, s.file), toRGB(img.px), W, H);
      files.push(s.file);
      console.log(`${s.file}  ${fs.statSync(path.join(TMP_DIR, s.file)).size} bytes  ${((Date.now() - t0) / 1000).toFixed(0)} s  (${DEFAULT}, GPU ${img.gpu})`);
    }
    for (const [i, name] of STRIP_NAMES.entries()) {
      const t0 = Date.now();
      const gpu = await twice(STILLS.length + i, `strip ${name}`, () => strip(name, TMP_DIR));
      const changes = score.collage.changes[name].events;
      for (const s of STRIP) {
        const f = stripFile(name, s.n);
        files.push(f);
        const on = changes.filter((e) => e.note === s.note).length;
        console.log(`${f}  t ${s.t} (cello note ${s.note} at ${s.at} + ${STRIP_LAG})  ${on} blocks change on the note  ${fs.statSync(path.join(TMP_DIR, f)).size} bytes`);
      }
      console.log(`strip ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s  (GPU ${gpu})`);
    }
    // the captures are lossless PNG; unless --png, each becomes a JPEG in the temporary folder
    let out = files;
    if (!PNG) {
      toJPEG(files.map((f) => path.join(TMP_DIR, f)));
      out = files.map((f) => f.replace(/\.png$/, '.jpg'));
      let total = 0;
      for (const f of out) total += fs.statSync(path.join(TMP_DIR, f)).size;
      console.log(`JPEG quality ${JPEG_QUALITY}, 4:4:4: ${out.length} files, ${total} bytes`);
    }
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

async function bench() {
  const times = [];
  for (let i = 0; BENCH_FROM + i * BENCH_STEP <= BENCH_TO + 1e-9; i++) times.push(Number((BENCH_FROM + i * BENCH_STEP).toFixed(2)));
  const server = await startServer(PORT);
  const rows = [];
  try {
    for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
      let B = null;
      try {
        B = await openBrowser(`http://localhost:${PORT}/?w=${w}&h=${h}&collage=${DEFAULT}#t=${times[0]}`, { w, h });
        const info = await B.ev('window.FR_INFO()');
        if (info.width !== w || info.height !== h) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${w}x${h}`);
        if (info.collage.strength !== DEFAULT) throw new Error(`the page draws strength '${info.collage.strength}', wanted '${DEFAULT}'`);
        if (info.tex !== 'full') throw new Error(`the page uses tex=${info.tex}, wanted the full-size pictures`);
        const per = await B.ev(`(async () => {
          const gl = document.getElementById('view').getContext('webgl2');
          const px = new Uint8Array(4);
          const out = [];
          for (const t of ${JSON.stringify(times)}) {
            // warm-up: the first frame at this time, waited for, so that no timed frame also waits
            // for the GPU work of the frame before it
            await renderFrame(t);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const ms = [];
            for (let i = 0; i < ${REPS}; i++) {
              const t0 = performance.now();
              await renderFrame(t);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // returns when the GPU is done
              ms.push(performance.now() - t0);
            }
            out.push({ t, ms });
          }
          return out;
        })()`, 900000);
        if (B.logs.length) console.log(`page messages (${w}x${h}):\n  ` + B.logs.join('\n  '));
        if (B.logs.some((l) => l.startsWith('exception:') || l.startsWith('error:'))) throw new Error(`the page reported errors while timing ${w}x${h}`);
        for (const p of per) p.median = median(p.ms);
        const meds = per.map((p) => p.median);
        const slow = per.reduce((a, p) => (p.median > a.median ? p : a));
        const worst = per.reduce((a, p) => (Math.max(...p.ms) > Math.max(...a.ms) ? p : a));
        rows.push({
          w, h, gpu: info.gpu, strength: DEFAULT, cuts: info.collage.images, reps: REPS, n: per.length,
          min: Math.min(...meds), median: median(meds), max: slow.median, maxAt: slow.t,
          worstFrame: Math.max(...worst.ms), worstAt: worst.t,
          over: meds.filter((m) => m > FRAME_MS).length,
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
    console.log(`${r.w}x${r.h} | GPU ${r.gpu} | ${r.strength}, ${r.cuts} cuts loaded | ${r.n} times x ${r.reps} | per-time median: min ${r.min.toFixed(2)} / median ${r.median.toFixed(2)} / max ${r.max.toFixed(2)} ms (at ${r.maxAt} s) | slowest single frame ${r.worstFrame.toFixed(2)} ms (at ${r.worstAt} s) | over ${FRAME_MS.toFixed(1)} ms: ${r.over} of ${r.n}`);
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

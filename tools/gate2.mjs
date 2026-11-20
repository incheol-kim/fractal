// Review gate 2 (look test): six 4K stills of the page into docs/review/gate2/.
//
//   node tools/gate2.mjs [--out=gate2]   the six stills into docs/review/<out>/ (refuses if it already holds stills).
//                                        Written into docs/review/.<out>-tmp first and moved in only when all six exist;
//                                        on failure the temporary folder is removed. Test switch: GATE2_FAIL_AT=<0..5>
//                                        makes that still fail (both attempts) to prove nothing is left behind.
//   node tools/gate2.mjs --bench[=json]  frame times at 1920x1080 and 3840x2160, t = 26.8..37.2 s every 0.4 s
//                                        (prints a table; --bench=<file> also writes it as JSON)
//
// Stills: canvas pixels via gl.readPixels (grab/writePNG from tools/browser.mjs), one browser per still. Bench: one headless Edge session per size (tools/browser.mjs), Vite server on port 5199. Every
// capture has a long time limit and one retry; retries are reported.
import fs from 'node:fs';
import path from 'node:path';
import { root, arg, startServer, openBrowser, grab, toRGB, writePNG, PORT } from './browser.mjs';

const W = 3840;
const H = 2160;
const STILLS = [
  [3.0, 'x8'],
  [13.5, 'x1'],
  [22.0, 'B'],
  [34.16, 'hit'],
  [39.8, 'chords'],
  [44.9, 'done'],
].map(([t, name]) => ({ t, file: `t${t.toFixed(2).padStart(5, '0')}_${name}.png` }));
const OUT_NAME = arg('out', 'gate2');
if (!/^[\w.-]+$/.test(OUT_NAME) || OUT_NAME.startsWith('.')) throw new Error(`bad --out name: ${OUT_NAME}`);
const OUT_DIR = path.join(root, 'docs', 'review', OUT_NAME);
const TMP_DIR = path.join(root, 'docs', 'review', `.${OUT_NAME}-tmp`);
const FAIL_AT = process.env.GATE2_FAIL_AT === undefined ? -1 : Number(process.env.GATE2_FAIL_AT);
let retries = 0;
const BENCH = process.argv.some((a) => a === '--bench' || a.startsWith('--bench='));

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

// The canvas pixels themselves (gl.readPixels after renderFrame(t), MSAA resolved: grab in
// tools/browser.mjs); the compositor screenshot of a 4K page timed out for minutes.
async function stills() {
  if (fs.existsSync(OUT_DIR) && fs.readdirSync(OUT_DIR).some((f) => /\.(png|webp)$/i.test(f))) {
    throw new Error(`${path.relative(root, OUT_DIR)} already holds stills; a review bundle is never overwritten`);
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true }); // left over from a crashed run
  const server = await startServer(PORT);
  let done = false;
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const [n, s] of STILLS.entries()) {
      const t0 = Date.now();
      let img = null;
      for (let attempt = 0; attempt < 2 && !img; attempt++) {
        try {
          if (n === FAIL_AT) throw new Error('forced failure (GATE2_FAIL_AT)');
          img = await grab('', s.t, [W, H]); // one fresh browser per still
        } catch (e) {
          if (attempt === 1) throw e;
          console.log(`retry for ${s.file}: ${e.message}`);
          retries++;
        }
      }
      const file = path.join(TMP_DIR, s.file);
      writePNG(file, toRGB(img.px), W, H);
      console.log(`${s.file}  ${fs.statSync(file).size} bytes  ${((Date.now() - t0) / 1000).toFixed(0)} s  (GPU ${img.gpu})`);
    }
    // all six exist: move them in (the folder may exist, e.g. holding only a page)
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const s of STILLS) fs.renameSync(path.join(TMP_DIR, s.file), path.join(OUT_DIR, s.file));
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    done = true;
    console.log(`retries: ${retries}`);
  } finally {
    if (!done) fs.rmSync(TMP_DIR, { recursive: true, force: true });
    await server.close();
  }
}

async function bench() {
  const server = await startServer(PORT);
  const rows = [];
  try {
    for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
      let B = null;
      try {
        B = await openBrowser(`http://localhost:${PORT}/?w=${w}&h=${h}#t=26.8`, { w, h });
        const info = await B.ev('window.FR_INFO()');
        const ms = await B.ev(`(async () => {
          const out = [];
          for (let t = 26.8; t < 37.21; t += 0.4) {
            await renderFrame(t);            // first call at a time (the page's warm-up at load has already compiled and uploaded everything)
            // reading one pixel back waits for the GPU (gl.finish under ANGLE does not fully), so the
            // time is state + draw + the GPU really done; renderFrame's own FR_LAST_MS ended with
            // gl.finish until plan 2's final fix wave and with the same one-pixel read since
            const gl = document.getElementById('view').getContext('webgl2');
            const px = new Uint8Array(4);
            const t0 = performance.now();
            await renderFrame(t);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            out.push({ finish: window.FR_LAST_MS, synced: performance.now() - t0 });
          }
          return out;
        })()`, 600000);
        const st = (k) => { const a = ms.map((m) => m[k]); return { min: Math.min(...a), median: median(a), max: Math.max(...a) }; };
        rows.push({ w, h, gpu: info.gpu, n: ms.length, synced: st('synced'), finish: st('finish') });
      } finally {
        if (B) await B.close();
      }
    }
  } finally {
    await server.close();
  }
  for (const r of rows) console.log(`${r.w}x${r.h} | GPU ${r.gpu} | ${r.n} times | synced (readPixels) min ${r.synced.min.toFixed(2)} / median ${r.synced.median.toFixed(2)} / max ${r.synced.max.toFixed(2)} ms | renderFrame's own (FR_LAST_MS) min ${r.finish.min.toFixed(2)} / median ${r.finish.median.toFixed(2)} / max ${r.finish.max.toFixed(2)} ms`);
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

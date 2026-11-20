// A frame is drawn from its time alone: not from what the page drew before it, nor from the canvas
// size the page started with (the collage and the ground it gives the light lines, Task 10).
//
//   node tools/check_collage.mjs [--seek] [--resize] [--t=27.0] [--q="collage=mid"] [--sub=<n>] [--shutter=<x>] [--jitter=0|1]
//
// With neither flag it does both. The reference is one frame from a fresh browser: the page at
// ?w=1920&h=1080&<q>#t=<t>, renderFrame(t) and nothing else (grab in tools/browser.mjs). --q adds
// address options to every page of the check (the reference's and the ones checked against it):
// --q=pieces=web checks the web set of the collage's pieces (src/collage_set.js), and the reference must
// then say it drew that set (FR_INFO().collage.set). The set drawn is printed with the reference.
// --sub, --shutter and --jitter go to every renderFrame of the check, as renderFrame(t, { sub,
// shutter, jitter }) (tools/browser.mjs subArg): each frame then the average of its sub-frames
// (src/main.js).
//   --seek    another fresh 1920 x 1080 browser, opened at ?<q>#t=40, draws renderFrame(40), switches
//             the strength to another (high, or calm when it opened with high), renderFrame(22),
//             switches the strength back to what it opened with, renderFrame(t); its frame against
//             the reference.
//   --resize  the page at ?<q> without ?w=&h= in a 1280 x 720 window (canvas 1280 x 720), the
//             window then grown to 1920 x 1080 (the canvas follows), renderFrame(t); its frame
//             against the reference. After the growth the render targets must have followed the
//             canvas: FR_INFO().targets.ground the canvas's size and targets.pip the picture in
//             picture's levels for it (src/collage.js pipSizes with the central room's box of
//             assets/collage.json and the picture's size of assets/regions.json).
// Two frames are the same by tools/cmp_png.py's default rule: a pixel is over when its largest
// channel difference (RGB, 0..255) is above OVER, and at most SHARE of the pixels may be over (4x
// MSAA edge pixels vary between draws, so frames are never compared byte for byte). Prints PASS or
// FAIL and exits 0 or 1. A failing check writes both frames to local-only/temp/check_collage/.
import fs from 'node:fs';
import path from 'node:path';
import { root, arg, subArg, sleep, startServer, openBrowser, readCanvas, grab, toRGB, writePNG, PORT } from './browser.mjs';
import { TEMP } from './paths.mjs';
import { pipSizes, PIP_ROOM } from '../src/collage.js';

const W = 1920;
const H = 1080;
const SMALL = [1280, 720];
const OVER = 3;
const SHARE = 0.0005;

const T = Number(arg('t', '27.0'));
const Q = arg('q', '').replace(/^[?&]/, '');
const SUB = subArg(); // renderFrame's sub-frames, or null
const valued = ['--t=', '--q=', '--sub=', '--shutter=', '--jitter='];
const flags = process.argv.slice(2).filter((a) => a.startsWith('--') && !valued.some((v) => a.startsWith(v)));
const unknown = flags.filter((a) => a !== '--seek' && a !== '--resize');
if (!Number.isFinite(T) || unknown.length || SUB === false) {
  console.error('usage: node tools/check_collage.mjs [--seek] [--resize] [--t=27.0] [--q="collage=mid"] [--sub=<n>] [--shutter=<x>] [--jitter=0|1]');
  process.exit(2);
}
const amp = Q ? `&${Q}` : ''; // the options after ?w=&h=
// a call of renderFrame at t, with the sub-frames if given
const rf = (t) => `renderFrame(${t}${SUB ? `, ${JSON.stringify(SUB)}` : ''})`;
const runSeek = flags.includes('--seek') || !flags.length;
const runResize = flags.includes('--resize') || !flags.length;

// Two RGBA frames of one size -> { over, share, max, mean } (RGB only, as cmp_png.compare).
function compare(a, b) {
  const n = a.length / 4;
  let over = 0;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
      sum += d;
      if (d > m) m = d;
    }
    if (m > OVER) over++;
    if (m > max) max = m;
  }
  return { over, share: over / n, max, mean: sum / (n * 3) };
}

// waits until the page's canvas is w x h (the resize event has been handled)
async function canvasSize(B, w, h) {
  for (let i = 0; i < 100; i++) {
    const info = await B.ev('window.FR_INFO()');
    if (info.width === w && info.height === h) return;
    await sleep(100);
  }
  const info = await B.ev('window.FR_INFO()');
  throw new Error(`the canvas is ${info.width}x${info.height}, wanted ${w}x${h}`);
}

// one call to the page that must say true (setStrength); -> the call, for the log
async function call(B, fn, ...args) {
  const expr = `${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
  if (!(await B.ev(expr))) throw new Error(`${expr} was refused`);
  return expr;
}

async function seekFrame() {
  const B = await openBrowser(`http://localhost:${PORT}/?w=${W}&h=${H}${amp}#t=40`, { w: W, h: H });
  try {
    const info = await B.ev('window.FR_INFO()');
    const first = info.collage.strength;
    const steps = [rf(40)];
    await B.ev(rf(40), 60000);
    steps.push(await call(B, 'setStrength', first === 'high' ? 'calm' : 'high'));
    steps.push(rf(22));
    await B.ev(rf(22), 60000);
    steps.push(await call(B, 'setStrength', first));
    steps.push(rf(T));
    await B.ev(rf(T), 60000);
    const img = await readCanvas(B, `seek t=${T}`);
    if (B.logs.length) console.log(`page messages (seek):\n  ` + B.logs.join('\n  '));
    return { img, steps: steps.join(', ') };
  } finally {
    await B.close();
  }
}

// the render targets a W x H canvas has (renderer.js info().targets)
function targetsFor(w, h) {
  const json = (name) => JSON.parse(fs.readFileSync(path.join(root, 'assets', name), 'utf8'));
  const room = json('collage.json').blocks.find((b) => b.name === PIP_ROOM);
  const { w: pw, h: ph } = json('regions.json');
  return { ground: [w, h], pip: pipSizes(w, h, room.bbox, { w: pw, h: ph }) };
}

async function resizeFrame() {
  const B = await openBrowser(`http://localhost:${PORT}/${Q ? `?${Q}` : ''}#t=${T}`, { w: SMALL[0], h: SMALL[1] });
  try {
    await canvasSize(B, SMALL[0], SMALL[1]);
    await B.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await canvasSize(B, W, H);
    const { targets } = await B.ev('window.FR_INFO()');
    const want = targetsFor(W, H);
    if (JSON.stringify(targets) !== JSON.stringify(want)) throw new Error(`resize: the render targets are ${JSON.stringify(targets)} after the growth, want ${JSON.stringify(want)}`);
    await B.ev(rf(T), 60000);
    const img = await readCanvas(B, `resize t=${T}`);
    if (B.logs.length) console.log(`page messages (resize):\n  ` + B.logs.join('\n  '));
    const sizes = (list) => list.map(([w, h]) => `${w}x${h}`).join(' ');
    return { img, steps: `opened at ${SMALL.join('x')}, window grown to ${W}x${H} (targets: ground ${sizes([targets.ground])}, pip ${sizes(targets.pip)}), ${rf(T)}` };
  } finally {
    await B.close();
  }
}

function save(name, img) {
  const file = path.join(TEMP, 'check_collage', `${name}.png`);
  writePNG(file, toRGB(img.px), img.w, img.h);
  return path.relative(root, file);
}

const server = await startServer(PORT);
let code = 0;
try {
  const ref = await grab(Q, T, [W, H], PORT, SUB);
  const set = ref.info.collage.set;
  const asked = new URLSearchParams(Q).get('pieces');
  if (asked !== null && set !== asked) throw new Error(`the page drew the '${set}' set of pieces, --q asks for '${asked}'`);
  console.log(`reference: a fresh browser, ?w=${W}&h=${H}${amp}#t=${T}, ${rf(T)}, pieces ${set} | GPU ${ref.gpu}`);
  const checks = [];
  if (runSeek) checks.push(['seek', seekFrame]);
  if (runResize) checks.push(['resize', resizeFrame]);
  for (const [name, frame] of checks) {
    const { img, steps } = await frame();
    if (img.w !== ref.w || img.h !== ref.h) throw new Error(`${name}: the frame is ${img.w}x${img.h}, the reference ${ref.w}x${ref.h}`);
    const r = compare(ref.px, img.px);
    const ok = r.share <= SHARE;
    console.log(`${name}: ${steps}`);
    console.log(`  over ${OVER}: ${r.over} px (share ${r.share.toFixed(6)}), max ${r.max}, mean ${r.mean.toFixed(4)}  ${ok ? 'PASS' : 'FAIL'} (share <= ${SHARE})`);
    if (!ok) {
      code = 1;
      console.log(`  frames: ${save(`${name}_reference`, ref)}, ${save(`${name}_${T}`, img)}`);
    }
  }
} catch (e) {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  code = 1;
} finally {
  await server.close();
}
console.log(code ? 'FAIL' : 'PASS');
process.exit(code);

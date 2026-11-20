// One still frame of the page as a PNG, rendered by headless Edge on the high-performance GPU.
//
//   node tools/shot.mjs --t=<s> [--w=1920] [--h=1080] [--q="fx=0"] --out=<png> [--clip=x,y,w,h] [--bench=<frames>]
//                       [--sub=<n>] [--shutter=<x>] [--jitter=0|1]
//
// Starts its own Vite dev server on port 5199, opens the page at ?w=&h=&<q>#t=<t> (canvas fixed
// to w x h, window the same size, device scale 1), calls renderFrame(t) and saves the canvas
// pixels (readCanvas in tools/browser.mjs: gl.readPixels, the one capture path of the tools).
// --clip saves only that part of the frame (canvas pixels, x, y from the top left), for looking
// at details. --q=pieces=web draws the web set of the collage's pieces (src/collage_set.js); the set
// the page drew (FR_INFO().collage.set) is printed, and must be the one --q names.
// --sub, --shutter, --jitter: the frame as the average of n sub-frames over a shutter window of x
// frames, with the sub-pixel jitter (1, the default) or without it (0) (renderFrame(t, { sub, shutter,
// jitter }) in src/main.js; sub 1, shutter 0 and jitter 1 for those not given). Without any of them,
// renderFrame(t) as always.
// --bench=N then renders N frames from t on (1/60 s apart, with the same sub-frames) and prints the
// time per frame from the frame state to the GPU having finished (window.FR_LAST_MS). Browser and
// server: tools/browser.mjs.
import path from 'node:path';
import { root, arg, startServer, openBrowser, readCanvas, toRGB, writePNG, PORT, subArg } from './browser.mjs';

const T = Number(arg('t'));
const W = Math.round(Number(arg('w', 1920)));
const H = Math.round(Number(arg('h', 1080)));
const Q = arg('q', '').replace(/^[?&]/, '');
const OUT = arg('out');
const BENCH = Math.max(0, Math.round(Number(arg('bench', 0))) || 0);
const CLIP = arg('clip') ? arg('clip').split(',').map(Number) : null;
const SUB = subArg(); // renderFrame's second argument, or null
const clipOK = (c) => c.length === 4 && c.every(Number.isInteger) && c[0] >= 0 && c[1] >= 0 && c[2] > 0 && c[3] > 0 && c[0] + c[2] <= W && c[1] + c[3] <= H;
if (!Number.isFinite(T) || !OUT || !(W > 0 && H > 0) || (CLIP && !clipOK(CLIP)) || SUB === false) {
  console.error('usage: node tools/shot.mjs --t=<s> [--w=1920] [--h=1080] [--q="fx=0"] --out=<png> [--clip=x,y,w,h] [--bench=<frames>] [--sub=<n>] [--shutter=<x>] [--jitter=0|1]');
  console.error('       --clip: whole pixels inside the frame; --sub: a whole number, 1 or more; --shutter: 0 to 1; --jitter: 0 or 1');
  process.exit(2);
}
const sub = SUB ? `, ${JSON.stringify(SUB)}` : ''; // after the time in a call of renderFrame

const server = await startServer(PORT);
let B = null;
let code = 0;
try {
  const query = `?w=${W}&h=${H}${Q ? '&' + Q : ''}`;
  B = await openBrowser(`http://localhost:${PORT}/${query}#t=${T}`, { w: W, h: H });
  const info = await B.ev('window.FR_INFO()');
  if (info.width !== W || info.height !== H) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${W}x${H}`);
  const asked = new URLSearchParams(Q).get('pieces');
  if (asked !== null && info.collage.set !== asked) throw new Error(`the page drew the '${info.collage.set}' set of pieces, --q asks for '${asked}'`);
  const t = await B.ev(`renderFrame(${T}${sub})`, 60000);
  const img = await readCanvas(B, `t=${t}${Q ? ' ' + Q : ''}${sub}`);
  let rgb = toRGB(img.px);
  let [ow, oh] = [img.w, img.h];
  if (CLIP) {
    const [x0, y0, cw, ch] = CLIP;
    const part = Buffer.alloc(cw * ch * 3);
    for (let y = 0; y < ch; y++) rgb.copy(part, y * cw * 3, ((y0 + y) * img.w + x0) * 3, ((y0 + y) * img.w + x0 + cw) * 3);
    [rgb, ow, oh] = [part, cw, ch];
  }
  const out = path.resolve(root, OUT);
  writePNG(out, rgb, ow, oh);
  // the sub-frames the page says it drew with
  const subs = SUB ? await B.ev('window.FR_INFO()').then((d) => ` sub ${d.sub} shutter ${d.shutter} jitter ${d.jitter ? 1 : 0}`) : '';
  console.log(`t=${t} ${W}x${H}${Q ? ' ' + Q : ''}${subs}${CLIP ? ` clip ${CLIP.join(',')}` : ''} -> ${path.relative(root, out)} | GPU ${info.gpu} | msaa ${info.samples} | pictures ${info.pictures.join('x')} | pieces ${info.collage.set}`);
  if (BENCH > 0) {
    const r = await B.ev(`(async () => {
      const ms = [];
      for (let i = 0; i < ${BENCH}; i++) {
        await renderFrame(${T} + i / 60${sub});
        ms.push(window.FR_LAST_MS);
      }
      ms.sort((x, y) => x - y);
      return { mean: ms.reduce((s, x) => s + x, 0) / ms.length, median: ms[ms.length >> 1], max: ms[ms.length - 1] };
    })()`, 600000);
    console.log(`bench: ${BENCH} frames from t=${T}: mean ${r.mean.toFixed(2)} ms, median ${r.median.toFixed(2)} ms, max ${r.max.toFixed(2)} ms (state + draw + GPU finish)`);
  }
  if (B.logs.length) console.log('page messages:\n  ' + B.logs.join('\n  '));
} catch (e) {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  if (B && B.logs.length) console.error('page messages:\n  ' + B.logs.join('\n  '));
  code = 1;
} finally {
  if (B) await B.close();
  await server.close();
}
process.exit(code);

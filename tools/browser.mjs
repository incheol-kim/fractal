// Shared by tools/shot.mjs, tools/check_final.mjs, tools/gate2.mjs, tools/export_video.mjs and the
// other page tools: the page's own Vite dev server, headless Edge on the high-performance GPU driven
// over CDP, and the one way a frame is captured (readCanvas / grab: the canvas pixels by
// gl.readPixels, never the compositor screenshot, which took minutes or stalled at 4K) and written
// (writePNG). The browser launch and CDP calls follow the owner's earlier piano solo piece (its
// tools/export_video.mjs, openBrowser).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer } from 'vite';
import { EDGE_PROFILES } from './paths.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 5199; // the tools' Vite server
// Microsoft Edge where Windows installs it (%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe)
const EDGE = path.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --name=value from the command line, or d
export const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

// --sub=<n>, --shutter=<x> and --jitter=0|1 from the command line: renderFrame's sub-frames,
// { sub, shutter, jitter } (sub 1, shutter 0 and jitter on for those not given; src/main.js); null
// when none is given, false when one is not a value renderFrame takes (sub a whole number, 1 or more;
// shutter 0 to 1; jitter 0 or 1).
export function subArg() {
  const s = arg('sub');
  const x = arg('shutter');
  const j = arg('jitter');
  if (s === undefined && x === undefined && j === undefined) return null;
  const sub = s === undefined ? 1 : Number(s);
  const shutter = x === undefined ? 0 : Number(x);
  if (!(Number.isInteger(sub) && sub >= 1 && shutter >= 0 && shutter <= 1)) return false;
  if (j !== undefined && j !== '0' && j !== '1') return false;
  return { sub, shutter, jitter: j !== '0' };
}

// a port nobody listens on now (the browser's debugging port; the export's own Vite server)
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// The page's Vite dev server on a fixed port (strict: fails if the port is taken). -> server (close() it)
export async function startServer(port) {
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    server: { port, strictPort: true, open: false },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

// Headless Edge at w x h (device scale 1) on the page at url; waits until FR_READY, or fails at once
// when the page reports an error or an exception before it (a load failure is logged that way).
// -> { send(method, params, ms), ev(expr, ms), close(), logs }. On failure the browser is closed.
// --disable-extensions: with Edge's (built-in) extensions on, a fresh Edge cancelled every request
// in flight at one moment of its first ~5-8 s (net::ERR_ABORTED; the page did not reload or hide,
// the dev server sent nothing): a load or reload in that window lost 1-5 cuts and had to retry them
// (4 of 11 probe sessions; with the switch 0 of 10; final fix wave of plan 2, 2026-11-18).
// Its profile is a folder of the project's temp folder (paths.mjs EDGE_PROFILES), removed by close();
// one that a killed tool left behind lies there, where anything may be deleted.
// requests: an array to keep the page's requests in, from before the page is opened (CDP Network, the
// cache off): { url, status (null until answered), failed (the error, or null), bytes, done } each
// (the check of the published copy before it is published: no request of its page may fail).
// extraArgs: more switches for Edge (that check: Edge's own background requests off); none for the
// other tools, whose Edge is as it was.
export async function openBrowser(url, { w, h, requests = null, extraArgs = [] }) {
  const port = await freePort();
  fs.mkdirSync(EDGE_PROFILES, { recursive: true });
  const profile = path.join(EDGE_PROFILES, `edge-shot-${port}`);
  const edge = spawn(EDGE, ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-extensions',
    '--force_high_performance_gpu', '--allow-file-access-from-files', '--hide-scrollbars', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    ...extraArgs, `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  // close the browser, then remove its temporary profile (Edge holds files until it has exited)
  const close = async () => {
    try {
      if (ws) ws.close();
    } catch {}
    const exited = new Promise((r) => (edge.exitCode !== null ? r() : edge.once('exit', r)));
    try {
      edge.kill();
    } catch {}
    await Promise.race([exited, sleep(5000)]);
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  };
  const logs = [];
  try {
    let targets;
    for (let i = 0; i < 150 && !targets; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      } catch {
        await sleep(200);
      }
    }
    if (!targets) throw new Error('browser did not start');
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const byId = new Map(); // CDP requestId -> its entry of requests (a redirect starts a new entry)
    const noteRequest = (method, p) => {
      if (method === 'Network.requestWillBeSent') {
        const before = byId.get(p.requestId);
        if (before && p.redirectResponse) Object.assign(before, { status: p.redirectResponse.status, done: true });
        const r = { url: p.request.url, status: null, failed: null, bytes: 0, done: false };
        byId.set(p.requestId, r);
        requests.push(r);
        return;
      }
      const r = byId.get(p.requestId);
      if (!r) return;
      if (method === 'Network.responseReceived') r.status = p.response.status;
      else if (method === 'Network.loadingFinished') Object.assign(r, { bytes: p.encodedDataLength, done: true });
      else if (method === 'Network.loadingFailed') Object.assign(r, { failed: p.errorText + (p.canceled ? ' (canceled)' : ''), done: true });
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (requests && m.method && m.method.startsWith('Network.')) {
        noteRequest(m.method, m.params);
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (m.method === 'Runtime.exceptionThrown') {
        logs.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
      }
    };
    await new Promise((r) => (ws.onopen = r));
    // every call has a time limit, so a stalled browser is noticed instead of hanging. The timer is
    // cleared when the answer comes: a pending timer would keep the answer (readCanvas: 2.6 MB of
    // base64 a call) alive for the whole limit, gigabytes over a video export.
    const send = (method, params = {}, ms = 120000) => new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`${method} took longer than ${ms / 1000} s`));
      }, ms);
      pending.set(i, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(method + ': ' + m.error.message));
        else resolve(m.result);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expr, ms) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await send('Page.enable').catch(() => {});
    await send('Runtime.enable').catch(() => {});
    if (requests) {
      await send('Network.enable');
      await send('Network.setCacheDisabled', { cacheDisabled: true });
    }
    await send('Page.navigate', { url });
    let ready = false;
    let failed = false; // the page reported an error: it will not get ready (main.js logs a load failure)
    for (let i = 0; i < 1200 && !ready && !failed; i++) {
      ready = await ev('!!window.FR_READY && typeof renderFrame === "function"').catch(() => false);
      failed = !ready && logs.some((l) => l.startsWith('error:') || l.startsWith('exception:'));
      if (!ready && !failed) await sleep(100);
    }
    if (!ready) throw new Error('page did not get ready' + (logs.length ? ':\n  ' + logs.join('\n  ') : ''));
    await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    return { send, ev, close, logs };
  } catch (e) {
    await close();
    throw e;
  }
}

// The canvas pixels of the page open in B, as drawn (gl.readPixels: MSAA resolved, no compositor,
// no colour management) -> { px: Uint8Array RGBA, rows top first, w, h }. Throws on a WebGL error
// or when the page has reported an exception or a console error (label names the frame).
export async function readCanvas(B, label = '') {
  const [W, H, glError] = await B.ev(`(() => {
    const gl = document.getElementById('view').getContext('webgl2');
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__px = px;
    return [W, H, gl.getError()];
  })()`);
  if (glError !== 0) throw new Error(`WebGL error 0x${glError.toString(16)} while drawing ${label}`);
  const bad = B.logs.filter((l) => l.startsWith('exception:') || l.startsWith('error:'));
  if (bad.length) throw new Error(`the page reported errors (${label}):\n  ${bad.join('\n  ')}`);
  const rows = 128;
  const out = new Uint8Array(W * H * 4);
  for (let y0 = 0; y0 < H; y0 += rows) {
    const n = Math.min(rows, H - y0);
    const b64 = await B.ev(`(() => {
      const a = window.__px.subarray(${y0 * W * 4}, ${(y0 + n) * W * 4});
      let s = '';
      for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768));
      return btoa(s);
    })()`);
    const chunk = Buffer.from(b64, 'base64');
    // readPixels rows are bottom first
    for (let r = 0; r < n; r++) {
      const src = r * W * 4;
      out.set(chunk.subarray(src, src + W * 4), (H - 1 - (y0 + r)) * W * 4);
    }
  }
  await B.ev('delete window.__px');
  return { px: out, w: W, h: H };
}

// Width x height of a PNG file from its header.
export function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } finally {
    fs.closeSync(fd);
  }
}

// One frame in a fresh headless Edge: the page at ?w=&h=&<query>#t=<t> (canvas fixed to w x h,
// window the same size, device scale 1), renderFrame(t) (renderFrame(t, sub) with sub, the
// sub-frames: subArg), its canvas pixels (readCanvas). The pictures must be at their full size (the
// key image file's) unless the query asks for tex=half. The Vite server must be running on port.
// -> { px, w, h, gpu, info }
export async function grab(query, t, [w, h], port = PORT, sub = null) {
  const q = String(query || '').replace(/^[?&]/, '');
  const B = await openBrowser(`http://localhost:${port}/?w=${w}&h=${h}${q ? '&' + q : ''}#t=${t}`, { w, h });
  try {
    const info = await B.ev('window.FR_INFO()');
    if (info.width !== w || info.height !== h) throw new Error(`canvas is ${info.width}x${info.height}, wanted ${w}x${h}`);
    const key = pngSize(path.join(root, 'assets', 'key_hires.png'));
    if (!/(^|&)tex=half(&|$)/.test(q) && info.pictures[0] !== key[0]) {
      throw new Error(`pictures are ${info.pictures.join('x')}, wanted the full size ${key.join('x')}`);
    }
    const s = sub ? `, ${JSON.stringify(sub)}` : '';
    await B.ev(`renderFrame(${t}${s})`, 60000);
    const img = await readCanvas(B, `${q || 'no options'} t=${t}${s}`);
    if (B.logs.length) console.log(`page messages (${q || 'no options'} t=${t}):\n  ` + B.logs.join('\n  '));
    return { ...img, gpu: info.gpu, info };
  } finally {
    await B.close();
  }
}

// RGBA pixels -> RGB (a Buffer), for writePNG.
export function toRGB(px) {
  const rgb = Buffer.alloc((px.length / 4) * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    rgb[j] = px[i];
    rgb[j + 1] = px[i + 1];
    rgb[j + 2] = px[i + 2];
  }
  return rgb;
}

// CRC-32 for the PNG chunks
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// RGB rows (a Buffer, top first) -> 8-bit RGB PNG file (no colour chunks: the values as they are).
export function writePNG(file, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h); // each row: filter 0, then the row
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

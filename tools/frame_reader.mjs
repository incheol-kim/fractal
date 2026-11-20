// The canvas's pixels as raw bytes, for the video export (tools/export_video.mjs): the same bytes as
// tools/browser.mjs readCanvas (gl.readPixels, RGBA, rows top first), without its 17 base64 round
// trips over CDP (1.5 s of a 4K frame's 1.65 s). The page posts the pixels to a small HTTP server of
// this process, bound to 127.0.0.1 on a free port (one a worker): the code that reads them is injected
// with each call, as readCanvas does; nothing in src/ knows of it. HTTP because Node has the server
// built in and a plain POST of a typed array is a simple cross-origin request (the page is on the
// Vite server's port); CDP's own ways out (IO.read, Fetch) are base64 again.
//
//   const rx = await frameReceiver();      // { url, close() }
//   const img = await readFrame(B, rx, 'frame 12');  // { px, w, h }, as readCanvas(B, 'frame 12')
//   await rx.close();
import http from 'node:http';

// A receiver of posted frames: POST <url>/frame/<id> with the bytes as the body. -> { url,
// expect(id, ms) (a promise of the body of that id; rejects after ms), cancel(id), close() }
export async function frameReceiver() {
  const waiting = new Map(); // id -> { resolve, reject, timer }
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': '*' };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const m = req.url.match(/^\/frame\/(\d+)$/);
    const w = m && waiting.get(m[1]);
    if (req.method !== 'POST' || !w) {
      req.resume();
      res.writeHead(404, cors).end();
      return;
    }
    const size = Number(req.headers['content-length']);
    const body = Number.isInteger(size) && size >= 0 ? Buffer.allocUnsafe(size) : null;
    const parts = [];
    let got = 0;
    req.on('data', (d) => {
      if (body && got + d.length <= size) d.copy(body, got);
      else parts.push(d);
      got += d.length;
    });
    req.on('end', () => {
      waiting.delete(m[1]);
      clearTimeout(w.timer);
      if (body && got === size && !parts.length) w.resolve(body);
      else w.reject(new Error(`frame ${m[1]}: ${got} bytes came, the request said ${req.headers['content-length']}`));
      res.writeHead(204, cors).end();
    });
    req.on('error', (e) => {
      waiting.delete(m[1]);
      clearTimeout(w.timer);
      w.reject(e);
    });
  });
  server.keepAliveTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    expect(id, ms = 120000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(String(id));
          reject(new Error(`frame ${id}: no bytes came in ${ms / 1000} s`));
        }, ms);
        waiting.set(String(id), { resolve, reject, timer });
      });
    },
    cancel(id) {
      const w = waiting.get(String(id));
      if (w) clearTimeout(w.timer);
      waiting.delete(String(id));
    },
    close() {
      for (const w of waiting.values()) clearTimeout(w.timer);
      waiting.clear();
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

let next = 0; // frame ids: every read has its own, so a late or stray body never stands for another frame

// The canvas pixels of the page open in B, as readCanvas(B, label) gives them (gl.readPixels: MSAA
// resolved, no compositor, no colour management) -> { px: Uint8Array RGBA, rows top first, w, h }.
// Throws on a WebGL error, when the page has reported an exception or a console error (label names
// the frame), and when the bytes that came are not exactly w x h x 4 of this read.
export async function readFrame(B, rx, label = '') {
  const id = ++next;
  const body = rx.expect(id);
  body.catch(() => {}); // awaited below, or cancelled
  let W;
  let H;
  let glError;
  let status;
  try {
    [W, H, glError, status] = await B.ev(`(async () => {
      const gl = document.getElementById('view').getContext('webgl2');
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const glError = gl.getError();
      if (glError !== 0) return [W, H, glError, 0];
      const r = await fetch(${JSON.stringify(`${rx.url}/frame/${id}`)}, { method: 'POST', body: px });
      return [W, H, 0, r.status];
    })()`, 120000);
  } catch (e) {
    rx.cancel(id);
    throw e;
  }
  if (glError !== 0) {
    rx.cancel(id);
    throw new Error(`WebGL error 0x${glError.toString(16)} while drawing ${label}`);
  }
  const bad = B.logs.filter((l) => l.startsWith('exception:') || l.startsWith('error:'));
  if (bad.length) {
    rx.cancel(id);
    throw new Error(`the page reported errors (${label}):\n  ${bad.join('\n  ')}`);
  }
  if (status !== 204) {
    rx.cancel(id);
    throw new Error(`${label}: the frame's bytes were not taken (HTTP ${status})`);
  }
  const raw = await body;
  if (raw.length !== W * H * 4) throw new Error(`${label}: ${raw.length} bytes came, wanted ${W}x${H}x4 = ${W * H * 4}`);
  // readPixels rows are bottom first
  const out = new Uint8Array(W * H * 4);
  const row = W * 4;
  for (let y = 0; y < H; y++) out.set(raw.subarray(y * row, (y + 1) * row), (H - 1 - y) * row);
  return { px: out, w: W, h: H };
}

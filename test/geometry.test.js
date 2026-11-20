import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitStage, buildRibbon, triangulateLeaf, polyArea, gpuNotice, halfTexURL, lostNotice, inPolys } from '../src/geometry.js';

// Sum of the triangle areas of a { position, index } mesh (2D, absolute values).
function meshArea(m) {
  const p = m.position;
  let s = 0;
  for (let i = 0; i < m.index.length; i += 3) {
    const a = m.index[i] * 2;
    const b = m.index[i + 1] * 2;
    const c = m.index[i + 2] * 2;
    s += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2;
  }
  return s;
}

// Rings in the regions.json convention: outer clockwise on screen (y down), holes counter-clockwise.
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const reversed = (ring) => ring.slice().reverse();

test('fitStage: 16:9 letterbox, centred', () => {
  const a = fitStage(1920, 1200, 1);
  assert.equal(a.cssW, 1920);
  assert.equal(a.cssH, 1080);
  assert.equal(a.left, 0);
  assert.equal(a.top, 60);
  assert.equal(a.pxW, 1920);
  assert.equal(a.pxH, 1080);

  const b = fitStage(1280, 720, 1.5);
  assert.equal(b.cssW, 1280);
  assert.equal(b.cssH, 720);
  assert.equal(b.pxW, 1920);
  assert.equal(b.pxH, 1080);

  const c = fitStage(1000, 1000, 1);
  assert.equal(c.cssW, 1000);
  assert.ok(c.cssH === 562 || c.cssH === 563, `cssH ${c.cssH}`);
  assert.equal(c.left, 0);
  assert.ok(Math.abs(c.top - (1000 - c.cssH) / 2) <= 0.5, `top ${c.top}`);

  // a wide window: pillarbox
  const d = fitStage(3000, 1080, 1);
  assert.equal(d.cssW, 1920);
  assert.equal(d.cssH, 1080);
  assert.equal(d.left, 540);
  assert.equal(d.top, 0);
});

test('fitStage: pixel size is the CSS size times the device pixel ratio', () => {
  const s = fitStage(1707, 1067, 1.5); // a 2560x1600 screen at 150 %
  assert.equal(s.pxW, Math.round(s.cssW * 1.5));
  assert.equal(s.pxH, Math.round(s.cssH * 1.5));
  assert.ok(Math.abs(s.cssW / s.cssH - 16 / 9) < 0.005);
});

test('fitStage: at 150 % the canvas and its offset are whole device pixels', () => {
  const s = fitStage(1707, 1067, 1.5); // the window 2560 x 1600 device px (1707 x 1067 CSS px)
  assert.equal(s.pxW, 2560);
  assert.equal(s.pxH, 1440);
  assert.ok(Math.abs(s.cssW * 1.5 - 2560) < 1e-6, `cssW ${s.cssW}`);
  assert.ok(Math.abs(s.cssH * 1.5 - 1440) < 1e-6, `cssH ${s.cssH}`);
  assert.ok(Math.abs(s.left * 1.5 - 0) < 1e-6, `left ${s.left}`);
  assert.ok(Math.abs(s.top * 1.5 - 80) < 1e-6, `top ${s.top}`);
});

test('fitStage: whole device pixels at 125, 150 and 175 %, 16:9, the largest that fits, centred', () => {
  const whole = (v) => Math.abs(v - Math.round(v)) < 1e-6;
  const windows = [[1707, 1067], [1536, 739], [1463, 754], [1097, 617], [1000, 1000], [1280, 720], [3000, 1080], [2195, 1234]];
  for (const dpr of [1.25, 1.5, 1.75]) {
    for (const [w, h] of windows) {
      const s = fitStage(w, h, dpr);
      const at = `${w}x${h} @${dpr}: ${JSON.stringify(s)}`;
      for (const v of [s.cssW * dpr, s.cssH * dpr, s.left * dpr, s.top * dpr]) assert.ok(whole(v), at);
      assert.ok(Math.abs(s.cssW * dpr - s.pxW) < 1e-6 && Math.abs(s.cssH * dpr - s.pxH) < 1e-6, at); // 1:1
      assert.ok(Number.isInteger(s.pxW) && Number.isInteger(s.pxH), at);
      assert.ok(Math.abs(s.pxW - (s.pxH * 16) / 9) <= 1 && Math.abs(s.pxH - (s.pxW * 9) / 16) <= 1, at); // 16:9 within a pixel
      // inside the window, touching two of its sides, centred to a device pixel
      const Wd = Math.floor(w * dpr + 1e-6);
      const Hd = Math.floor(h * dpr + 1e-6);
      assert.ok(s.pxW <= Wd && s.pxH <= Hd && (s.pxW === Wd || s.pxH === Hd), at);
      assert.ok(Math.abs(s.left * dpr - Math.floor((Wd - s.pxW) / 2)) < 1e-6, at);
      assert.ok(Math.abs(s.top * dpr - Math.floor((Hd - s.pxH) / 2)) < 1e-6, at);
    }
  }
});

test('fitStage: another aspect when asked (fixed canvas size)', () => {
  const s = fitStage(2944, 1648, 1, 2944 / 1648);
  assert.equal(s.cssW, 2944);
  assert.equal(s.cssH, 1648);
  assert.equal(s.left, 0);
  assert.equal(s.top, 0);
});

test('buildRibbon: two vertices per point, two triangles per segment, u from 0 to 1', () => {
  const pts = [[0, 0], [1, 0], [3, 0], [3, 2], [6, 6]];
  const r = buildRibbon(pts, 2);
  assert.equal(r.position.length, 10 * 2);
  assert.equal(r.u.length, 10);
  assert.equal(r.side.length, 10);
  assert.equal(r.index.length, 8 * 3);
  assert.equal(r.u[0], 0);
  assert.equal(r.u[1], 0);
  assert.equal(r.u[8], 1);
  assert.equal(r.u[9], 1);
  for (let i = 2; i < 10; i += 2) assert.ok(r.u[i] > r.u[i - 2], `u not increasing at ${i}`);
  // u follows the length: the first segment is 1 of 1 + 2 + 2 + 5 = 10
  assert.ok(Math.abs(r.u[2] - 0.1) < 1e-6);
  for (let i = 0; i < 10; i++) assert.equal(r.side[i], i % 2 === 0 ? 1 : -1);
  for (const k of r.index) assert.ok(k >= 0 && k < 10);
});

test('buildRibbon: the two sides are width apart on a straight piece', () => {
  const r = buildRibbon([[0, 0], [10, 0]], 3);
  const dy = Math.abs(r.position[1] - r.position[3]);
  assert.ok(Math.abs(dy - 3) < 1e-6, `dy ${dy}`);
  // the centre line is where the points are
  assert.ok(Math.abs((r.position[0] + r.position[2]) / 2) < 1e-6);
  assert.ok(Math.abs((r.position[1] + r.position[3]) / 2) < 1e-6);
});

test('buildRibbon: repeated points do not give NaN', () => {
  const r = buildRibbon([[1, 1], [1, 1], [4, 5], [4, 5]], 1);
  for (const v of r.position) assert.ok(Number.isFinite(v));
  for (const v of r.u) assert.ok(Number.isFinite(v));
  assert.equal(r.u[r.u.length - 1], 1);
});

test('polyArea: outer minus holes', () => {
  const outer = square(0, 0, 4, 4);
  const hole = reversed(square(1, 1, 3, 3));
  assert.ok(Math.abs(polyArea([outer]) - 16) < 1e-9);
  assert.ok(Math.abs(polyArea([outer, hole]) - 12) < 1e-9);
});

test('inPolys: inside the outer ring, not in its hole, inside an island in the hole', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole = [[2, 2], [8, 2], [8, 8], [2, 8]];
  const island = [[4, 4], [6, 4], [6, 6], [4, 6]];
  const polys = [outer, hole, island];
  assert.equal(inPolys(1, 1, polys), true);
  assert.equal(inPolys(3, 3, polys), false);
  assert.equal(inPolys(5, 5, polys), true);
  assert.equal(inPolys(11, 5, polys), false);
  assert.equal(inPolys(5, 5, [outer, [[1, 1], [2, 1]]]), true); // a ring of fewer than 3 points is no ring
});

test('triangulateLeaf: a square with a hole', () => {
  const polys = [square(0.1, 0.1, 0.5, 0.5), reversed(square(0.2, 0.2, 0.3, 0.4))];
  const m = triangulateLeaf(polys);
  assert.ok(m.position instanceof Float32Array);
  assert.ok(m.index instanceof Uint32Array);
  const want = polyArea(polys);
  assert.ok(Math.abs(meshArea(m) - want) / want < 0.005, `${meshArea(m)} vs ${want}`);
});

test('triangulateLeaf: two outer rings, the hole goes with the one that contains it, island in the hole', () => {
  const polys = [
    reversed(square(0.62, 0.62, 0.68, 0.68)), // hole of the second outer, listed first
    square(0, 0, 0.3, 0.3),
    square(0.5, 0.5, 0.9, 0.9),
    square(0.64, 0.64, 0.66, 0.66), // island inside that hole
  ];
  const m = triangulateLeaf(polys);
  const want = 0.09 + 0.16 - 0.0036 + 0.0004;
  assert.ok(Math.abs(polyArea(polys) - want) < 1e-9);
  assert.ok(Math.abs(meshArea(m) - want) / want < 0.005, `${meshArea(m)} vs ${want}`);
});

test('triangulateLeaf: every leaf of regions.json covers its area', () => {
  const regions = JSON.parse(readFileSync(new URL('../assets/regions.json', import.meta.url), 'utf8'));
  for (const leaf of regions.leaves) {
    const m = triangulateLeaf(leaf.polys);
    const want = polyArea(leaf.polys);
    assert.ok(Math.abs(meshArea(m) - want) / want < 0.005, `leaf ${leaf.id}: ${meshArea(m)} vs ${want}`);
  }
});

const INTEL = 'ANGLE (Intel, Intel(R) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Laptop GPU (0x00002F58) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const AMD_APU = 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)';

test('gpuNotice: the three cases of the brief, with the GPU name and the half-size option', () => {
  const a = gpuNotice(INTEL, 16384, 5888);
  assert.equal(typeof a, 'string');
  assert.ok(a.includes(INTEL), a);
  assert.ok(a.includes('tex=half'), a);
  assert.equal(gpuNotice(NVIDIA, 16384, 5888), null);
  const c = gpuNotice(NVIDIA, 4096, 5888);
  assert.equal(typeof c, 'string');
  assert.ok(c.includes(NVIDIA), c);
  assert.ok(c.includes('4096') && c.includes('5888'), c);
  assert.ok(c.includes('tex=half'), c);
});

test('gpuNotice: which GPUs it speaks about', () => {
  for (const name of [AMD_APU, SWIFT]) {
    const m = gpuNotice(name, 16384, 5888);
    assert.ok(m && m.includes(name) && m.includes('tex=half'), m);
  }
  assert.equal(gpuNotice('ANGLE (AMD, AMD Radeon RX 7900 XTX (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 16384, 5888), null);
  assert.equal(gpuNotice('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 16384, 5888), null);
  assert.equal(gpuNotice('', 16384, 5888), null); // unknown name and enough texture size: nothing to say
  assert.equal(gpuNotice(INTEL, 16384, NaN) === null, false); // size not known yet: still the GPU part
  assert.equal(gpuNotice(NVIDIA, 16384, NaN), null);
  const unknown = gpuNotice('', 4096, 5888);
  assert.ok(unknown.includes('4096') && unknown.includes('tex=half'), unknown);
});

test('gpuNotice: a ready link that keeps the address query and hash', () => {
  const m = gpuNotice(INTEL, 16384, 5888, 'http://localhost:5173/?hud=1#t=13.5');
  assert.ok(m.includes('http://localhost:5173/?hud=1&tex=half#t=13.5'), m);
  const n = gpuNotice(NVIDIA, 4096, 5888, 'http://localhost:5173/#t=3');
  assert.ok(n.includes(NVIDIA) && n.includes('http://localhost:5173/?tex=half#t=3'), n);
  const o = gpuNotice(INTEL, 16384, 5888, 'http://localhost:5173/?tex=full&w=1920&h=1080');
  assert.ok(o.includes('http://localhost:5173/?tex=half&w=1920&h=1080'), o);
});

test('gpuNotice: no half-size hint once the page is on tex=half', () => {
  const href = 'http://localhost:5173/?hud=1&tex=half#t=1';
  const m = gpuNotice(INTEL, 16384, 2944, href);
  assert.ok(m.includes(INTEL), m);
  assert.ok(!m.includes('tex=half') && !m.includes('http'), m);
  const s = gpuNotice(NVIDIA, 2048, 2944, href); // even the half-size picture is too big
  assert.ok(s.includes(NVIDIA) && s.includes('2048') && s.includes('2944'), s);
  assert.ok(!s.includes('tex=half') && !s.includes('http'), s);
  assert.equal(gpuNotice(NVIDIA, 16384, 2944, href), null);
});

test('halfTexURL: sets tex=half, keeps everything else', () => {
  assert.equal(halfTexURL('http://localhost:5173/'), 'http://localhost:5173/?tex=half');
  assert.equal(halfTexURL('http://localhost:5173/?hud=1#t=13.5'), 'http://localhost:5173/?hud=1&tex=half#t=13.5');
  assert.equal(halfTexURL('http://localhost:5173/?tex=full#t=2'), 'http://localhost:5173/?tex=half#t=2');
});

test('lostNotice: names the GPU and offers the half-size link unless already on it', () => {
  const m = lostNotice(INTEL, 'http://localhost:5173/?hud=1#t=13.5');
  assert.ok(m.includes(INTEL) && m.includes('http://localhost:5173/?hud=1&tex=half#t=13.5'), m);
  const h = lostNotice(NVIDIA, 'http://localhost:5173/?tex=half');
  assert.ok(h.includes(NVIDIA) && !h.includes('http'), h);
  assert.ok(lostNotice('', 'http://localhost:5173/').includes('tex=half'));
});

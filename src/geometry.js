// Pure geometry helpers: stage fit, stroke ribbons, leaf triangulation, GPU notice.
// No DOM and no WebGL, so the tests can import this file in Node.
import { Earcut } from 'three/src/extras/Earcut.js';

const STAGE_ASPECT = 16 / 9;

// The largest box of the given aspect (16:9 unless asked) inside the window (winW x winH CSS
// pixels), centred. It is chosen in whole device pixels, size and offset (pxW x pxH, the canvas
// pixels), and the CSS box is derived from them (cssW/cssH/left/top = device pixels / dpr), so
// the canvas maps 1:1 onto device pixels at any dpr (150 % Windows scaling included) and is
// never resampled.
export function fitStage(winW, winH, dpr = 1, aspect = STAGE_ASPECT) {
  const r = dpr > 0 ? dpr : 1;
  // the window in device pixels (a CSS size times dpr can end in .5: the window has the whole part)
  const W = Math.max(1, Math.floor(Math.max(1, winW) * r + 1e-6));
  const H = Math.max(1, Math.floor(Math.max(1, winH) * r + 1e-6));
  let pxW;
  let pxH;
  if (W / H > aspect) {
    pxH = H;
    pxW = Math.max(1, Math.min(W, Math.round(H * aspect)));
  } else {
    pxW = W;
    pxH = Math.max(1, Math.min(H, Math.round(W / aspect)));
  }
  const x = Math.floor((W - pxW) / 2);
  const y = Math.floor((H - pxH) / 2);
  return { cssW: pxW / r, cssH: pxH / r, left: x / r, top: y / r, pxW, pxH };
}

const MITER_LIMIT = 3;

// A triangle strip along a polyline: point i gives vertex 2i (side +1) and 2i+1 (side -1).
// position: the two sides, width apart (mitred at the bends, mitre at most MITER_LIMIT times).
// normal: per vertex, the offset of side +1 from the point for a half width of 1 (the mitre), so
// a shader can rebuild any width as point + normal * side * halfWidth (point = mean of the pair).
// u: length along the line, 0 at the first point, 1 at the last.
export function buildRibbon(pts, width) {
  const n = pts.length;
  const position = new Float32Array(n * 4);
  const normal = new Float32Array(n * 4);
  const u = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  const index = new Uint32Array(Math.max(n - 1, 0) * 6);
  if (n === 0) return { position, normal, u, side, index };

  const cum = new Float64Array(n);
  const dir = new Array(Math.max(n - 1, 0)).fill(null);
  for (let i = 1; i < n; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy);
    cum[i] = cum[i - 1] + len;
    if (len > 0) dir[i - 1] = [dx / len, dy / len];
  }
  // zero-length segments take a neighbour's direction
  for (let i = 1; i < dir.length; i++) if (!dir[i] && dir[i - 1]) dir[i] = dir[i - 1];
  for (let i = dir.length - 2; i >= 0; i--) if (!dir[i] && dir[i + 1]) dir[i] = dir[i + 1];
  for (let i = 0; i < dir.length; i++) if (!dir[i]) dir[i] = [1, 0];

  const total = cum[n - 1];
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    const dp = dir.length ? dir[Math.max(i - 1, 0)] : [1, 0];
    const dn = dir.length ? dir[Math.min(i, dir.length - 1)] : [1, 0];
    const np = [-dp[1], dp[0]];
    const nn = [-dn[1], dn[0]];
    let mx = np[0] + nn[0];
    let my = np[1] + nn[1];
    let ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = nn[0];
      my = nn[1];
      ml = 1;
    }
    mx /= ml;
    my /= ml;
    const k = 1 / Math.max(mx * nn[0] + my * nn[1], 1 / MITER_LIMIT);
    mx *= k;
    my *= k;
    const [x, y] = pts[i];
    const a = i * 4;
    position[a] = x + mx * half;
    position[a + 1] = y + my * half;
    position[a + 2] = x - mx * half;
    position[a + 3] = y - my * half;
    normal[a] = mx;
    normal[a + 1] = my;
    normal[a + 2] = mx;
    normal[a + 3] = my;
    const uu = total > 0 ? cum[i] / total : n > 1 ? i / (n - 1) : 0;
    u[i * 2] = uu;
    u[i * 2 + 1] = uu;
    side[i * 2] = 1;
    side[i * 2 + 1] = -1;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = 2 * i;
    index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  return { position, normal, u, side, index };
}

// A ribbon (width 0: positions on the line, normals carry the width) all round a closed ring:
// the ring's points with the last point before them and the first after, so every corner of
// the ring is mitred (the closing segment is covered twice). A repeated closing point is dropped.
// points: the points used, one per pair of vertices (vertex 2i and 2i + 1 are at points[i]).
export function closedRibbon(ring) {
  let r = ring;
  const n = r.length;
  if (n > 1 && r[0][0] === r[n - 1][0] && r[0][1] === r[n - 1][1]) r = r.slice(0, n - 1);
  const points = r.length < 2 ? r.slice() : [r[r.length - 1], ...r, r[0]];
  return { ...buildRibbon(points, 0), points };
}

// Shoelace area of one ring, sign kept (positive for clockwise on screen with y down).
function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

// Area covered by a leaf's rings (outer rings minus holes, islands added back).
export function polyArea(polys) {
  let s = 0;
  for (const ring of polys) s += ringArea(ring);
  return Math.abs(s);
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Is (x, y) inside a leaf (its rings even-odd: inside an outer ring and not in a hole)?
export function inPolys(x, y, polys) {
  let inside = false;
  for (const ring of polys) if (ring.length >= 3 && inRing(x, y, ring)) inside = !inside;
  return inside;
}

function bboxOf(ring) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// Triangles covering a leaf: polys is a flat list of rings; outer rings have the sign of the
// largest ring, holes the other sign. Each hole goes with the smallest outer ring that holds most
// of its points (an island inside a hole is an outer ring of its own).
// -> { position: Float32Array [x, y, ...], index: Uint32Array }
export function triangulateLeaf(polys) {
  const rings = polys.filter((r) => r.length >= 3).map((r) => ({ r, a: ringArea(r), box: bboxOf(r) }));
  if (!rings.length) return { position: new Float32Array(0), index: new Uint32Array(0) };
  const sign = Math.sign(rings.reduce((m, x) => (Math.abs(x.a) > Math.abs(m.a) ? x : m)).a) || 1;
  const outers = rings.filter((x) => Math.sign(x.a) === sign).map((x) => ({ ...x, holes: [] }));
  for (const h of rings.filter((x) => Math.sign(x.a) !== sign)) {
    let best = null;
    let bestScore = 0;
    for (const o of outers) {
      const b = o.box;
      if (h.box[0] < b[0] || h.box[1] < b[1] || h.box[2] > b[2] || h.box[3] > b[3]) continue;
      let k = 0;
      for (const [x, y] of h.r) if (inRing(x, y, o.r)) k++;
      const score = k / h.r.length;
      if (score > bestScore + 1e-12 || (best && Math.abs(score - bestScore) <= 1e-12 && Math.abs(o.a) < Math.abs(best.a))) {
        best = o;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.5) best.holes.push(h.r);
  }

  const pos = [];
  const idx = [];
  for (const o of outers) {
    const flat = [];
    const holeIdx = [];
    for (const [x, y] of o.r) flat.push(x, y);
    for (const hole of o.holes) {
      holeIdx.push(flat.length / 2);
      for (const [x, y] of hole) flat.push(x, y);
    }
    const base = pos.length / 2;
    const tris = Earcut.triangulate(flat, holeIdx.length ? holeIdx : null, 2);
    for (const t of tris) idx.push(base + t);
    for (const v of flat) pos.push(v);
  }
  return { position: new Float32Array(pos), index: new Uint32Array(idx) };
}

// Integrated or software GPUs, by the WebGL renderer string (ANGLE on Windows).
const WEAK_GPU = [
  /\bIntel\b(?!.*\bArc\(TM\) [AB]\d)/i, // Intel iGPUs (Intel Arc A/B cards are discrete)
  /AMD Radeon\(TM\) (?:\d+M )?Graphics/i, // Ryzen APUs: no model number
  /Radeon\(TM\) Vega/i,
  /SwiftShader|llvmpipe|Basic Render|WARP|Software/i,
];

// The same address with tex=half (query and hash kept; an existing tex= is replaced).
export function halfTexURL(href) {
  const u = new URL(href);
  u.searchParams.set('tex', 'half');
  return u.toString();
}

function onHalf(href) {
  if (!href) return false;
  try {
    return new URL(href).searchParams.get('tex') === 'half';
  } catch {
    return false;
  }
}

// The half-size option for the current address: a ready link when href is given, else the
// option itself. Empty once the page is already on tex=half.
export function halfHint(href) {
  if (onHalf(href)) return '';
  let link = null;
  try {
    link = href ? halfTexURL(href) : null;
  } catch {
    link = null;
  }
  return link ? `Open with half-size pictures: ${link}` : 'Add tex=half to the address to use half-size pictures (for example ?tex=half).';
}

const gpuName = (s) => String(s || '').trim() || 'unknown';

// A message for the page when the browser draws on an integrated or software GPU, or when the
// largest texture is smaller than the picture needs (need = its largest side in pixels; NaN while
// the size is not known yet); else null. It always names the GPU and, unless the page (href) is
// already on tex=half, offers the half-size pictures (a ready link when href is given).
export function gpuNotice(rendererString, maxTex, need, href = null) {
  const raw = String(rendererString || '').trim();
  const weak = raw !== '' && WEAK_GPU.some((re) => re.test(raw));
  const small = Number.isFinite(maxTex) && Number.isFinite(need) && maxTex < need;
  if (!weak && !small) return null;
  const name = gpuName(raw);
  const hint = halfHint(href);
  const msgs = [];
  if (weak) {
    msgs.push(
      `This browser is drawing with integrated graphics or in software (GPU: ${name}). ` +
        'To use the high-performance GPU, set this browser to “High performance” in Windows Settings → System → Display → Graphics, then restart the browser.' +
        (hint && !small ? ' If it is still slow or stops, use the half-size pictures.' : ''),
    );
  }
  if (small) {
    msgs.push(
      `The largest texture ${weak ? 'this GPU' : `this GPU (${name})`} can hold (${maxTex}px) is smaller than the picture (${need}px), so the picture may break up` +
        (hint ? '; use the half-size pictures.' : '.'),
    );
  }
  return msgs.join(' ') + (hint ? `\n${hint}` : ''); // the link on a line of its own
}

// The message for a lost WebGL context (the GPU dropped the page, often for lack of memory).
export function lostNotice(rendererString, href = null) {
  const hint = halfHint(href);
  return (
    `The graphics device lost this page’s picture (WebGL context lost, GPU: ${gpuName(rendererString)}). ` +
    'Please reload the page.' +
    (hint ? ` If memory ran short, use the half-size pictures.\n${hint}` : '')
  );
}

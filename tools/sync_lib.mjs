// The sync check's pure part (tools/check_sync.mjs; tested by test/sync.test.js; design 10.4): the
// marked moments and where on the screen each one changes, the frame in which its change first
// shows, how a window of frames is measured and where its change starts. No files, no processes.
//
// A moment's time is when the picture starts to change visibly, as the page's timeline has it (not
// always its note's time): all of them are read from the score, the region map and the code, none is
// written here.
//
// The measure: each decoded frame's clip is reduced (Lanczos) to cells of GRID (a cell is 1/108 of
// the frame's height: 20 px at 4K, 10 px at 1080p, so both files measure alike), and a frame's
// difference is the mean absolute difference of its cells from the frame before (levels, 0..255,
// every channel). The film grain (a new pattern every 1/12 s, a cell of about 2 px at 4K, a few
// levels) and x264's noise average out within a cell (0.0-0.3 levels; at the full size the 12 fps
// steps reach 6); what stays at the 1/12 s steps is the pieces' 12 fps jitter and the gate weave,
// up to 1.4 levels over a busy picture. A moment's change is 13-93 levels.
import { DUR } from '../src/music.js';
import { foldingRows } from '../src/timeline.js';
import { cutoutKey } from '../src/cutouts.js';
import { FPS, frameAt } from './export_lib.mjs';

export const WINDOW = 12; // frames decoded before and after a moment's expected frame
export const TOLERANCE = 1; // frames: a moment is in sync when its change starts this close to its frame
export const GRID = [192, 108]; // the measure's cells across and down the whole frame
// levels: a change starts at the first frame that differs from the one before by more than this.
// Measured (2026-11-19, the four export variants at 4K and 1080p): at most 1.2 between frames
// before a moment (its 1/12 s steps), 13 or more on a moment's first frame.
export const CHANGE = 4;
// levels: the press's change. For two frames before the glue chord the pasted pieces' edges open
// (timeline.js GLUE_BREATH: 1.5 times their border, shadow and offset, eased in, so the first of
// those frames moves them by a tenth of a pixel or less), and 1.3 frames before it the collage under
// the base houses, the coral wall and the pole pastes its next cut (a cello note, 41.4731 s): 5-6
// levels over the whole frame on the frame before the chord, which this must not count; the chord's
// flash and push-in: 34-35. (With CHANGE the press would start a frame before its frame, and a file
// a frame early would fail.)
export const PRESS_CHANGE = 14;
const WIDEN = 0.1; // a clip taken from a box in the picture is widened by this part of the box on each side
const WHOLE = [0, 0, 1, 1];

// a box [x0, y0, x1, y1] of the picture (0..1) widened by WIDEN of its size on each side, kept in the
// frame -> a clip [x, y, w, h]. The picture's coordinates are used as the screen's as they are: the
// camera is not applied (at these moments it is at zoom 1, where the two differ by 0.24 % in x).
function widened([x0, y0, x1, y1]) {
  const [dx, dy] = [(x1 - x0) * WIDEN, (y1 - y0) * WIDEN];
  const [a, b] = [Math.max(0, x0 - dx), Math.max(0, y0 - dy)];
  return [a, b, Math.min(1, x1 + dx) - a, Math.min(1, y1 + dy) - b];
}

// the box round the boxes of the leaves ids (regions.json bbox: [x0, y0, x1, y1])
function boxOf(ids, regions) {
  const leaf = new Map(regions.leaves.map((l) => [l.id, l]));
  const boxes = ids.map((id) => {
    const l = leaf.get(id);
    if (!l || !l.bbox) throw new Error(`MOMENTS: leaf ${id} has no box in the region map`);
    return l.bbox;
  });
  return [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...boxes.map((b) => b[i])));
}

// The x where the line at height y crosses the edges of an outline (polys: rings), sorted: a point
// (x, y) is inside (even-odd, as src/geometry.js inPolys counts it) when an odd number of them lie
// to its right.
function crossings(polys, y) {
  const xs = [];
  for (const ring of polys) {
    if (ring.length < 3) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  return xs.sort((a, b) => a - b);
}
const insideOf = (xs, x) => xs.filter((c) => x < c).length % 2 === 1;
const INSET = 0.01; // a cell's corners are looked at this part of a cell inside it (an edge on the outline counts)

// The largest rectangle of whole cells of a [gx, gy] grid over the picture (0..1) inside a leaf's
// outline (polys: rings, even-odd; a cell is inside when its centre and its four corners, taken
// INSET within it, are) -> a clip [x, y, w, h], or null when no cell is. The first of equal ones,
// row by row from the top.
export function innerRect(polys, [gx, gy] = GRID) {
  const h = new Array(gx).fill(0); // cells inside straight up from the row j, for each column
  let best = null;
  for (let j = 0; j < gy; j++) {
    const rows = [j + INSET, j + 0.5, j + 1 - INSET].map((y) => crossings(polys, y / gy));
    for (let i = 0; i < gx; i++) {
      const pts = [[0, i + INSET], [0, i + 1 - INSET], [1, i + 0.5], [2, i + INSET], [2, i + 1 - INSET]];
      h[i] = pts.every(([r, x]) => insideOf(rows[r], x / gx)) ? h[i] + 1 : 0;
    }
    // the largest rectangle under the histogram h, its bottom on row j
    const stack = []; // [first column, height], heights rising
    for (let i = 0; i <= gx; i++) {
      const hi = i < gx ? h[i] : 0;
      let start = i;
      while (stack.length && stack[stack.length - 1][1] >= hi) {
        const [s, hs] = stack.pop();
        if (hs > 0 && (!best || hs * (i - s) > best.area)) best = { area: hs * (i - s), i0: s, i1: i, j0: j - hs + 1, j1: j + 1 };
        start = s;
      }
      stack.push([start, hi]);
    }
  }
  return best && [best.i0 / gx, best.j0 / gy, (best.i1 - best.i0) / gx, (best.j1 - best.j0) / gy];
}

// The moments to check, from the score (assets/score.json) and the region map (assets/regions.json),
// in time order: [{ name, t, clip: [x, y, w, h] (0..1 of the frame), threshold (levels) }]
//   sky       the sky piece lands (the score's piece on the region map's sky leaf); clip: the largest
//             rectangle inside the sky leaf (innerRect), where nothing else is drawn: the sky leaf's
//             box would also hold the tower, whose collage pastes nine new cuts 6-7 frames before
//             the sky, as large a change as the sky's
//   strike    the camera cuts to the strike's push-in (the first punch-in of score.camera, the one
//             before the glue chord): the whole frame changes
//   fold      the first folding cut-out lands (timeline.js foldingRows; red_block_left of the three
//             colour blocks), lying toward the eye; clip: the box round its leaves. The box round
//             all three would also hold red_block_top, whose collage pastes a new cut two frames
//             before, as large a change as the fold's first frame
//   press     the glue chord (score.glue): the whole frame flashes white and pushes in, and the
//             last pieces slam in. Its breath (GLUE_BREATH) starts two frames before, too small
//             to be seen in the first of them, smaller than the chord in the second (PRESS_CHANGE)
//   blackout  the picture cuts to black (DUR)
// A box clip is widened by WIDEN on each side; the others are the whole frame or inside a leaf.
export function MOMENTS(score, regions) {
  const sky = regions.leaves.find((l) => l.kind === 'sky');
  const skyPiece = sky && score.pieces.find((p) => p.leaf === sky.id);
  if (!skyPiece) throw new Error('MOMENTS: no piece of the sky leaf in the score');
  const skyClip = innerRect(sky.polys);
  if (!skyClip) throw new Error('MOMENTS: the sky leaf holds no cell of the grid');
  const punch = score.camera.find((e) => e.hold !== undefined && e.ease !== undefined && e.t < score.glue);
  if (!punch) throw new Error('MOMENTS: no push-in before the glue chord in score.camera');
  const folding = [...foldingRows(score.pieces)].map((i) => score.pieces[i]);
  if (!folding.length) throw new Error('MOMENTS: no folding cut-out in the score');
  const first = folding.reduce((a, p) => (p.t < a.t ? p : a));
  const firstLeaves = folding.filter((p) => cutoutKey(p) === cutoutKey(first)).map((p) => p.leaf);
  return [
    { name: 'sky', t: skyPiece.t, clip: skyClip, threshold: CHANGE },
    { name: 'strike', t: punch.t, clip: WHOLE, threshold: CHANGE },
    { name: 'fold', t: first.t, clip: widened(boxOf(firstLeaves, regions)), threshold: CHANGE },
    { name: 'press', t: score.glue, clip: WHOLE, threshold: PRESS_CHANGE },
    { name: 'blackout', t: DUR, clip: WHOLE, threshold: CHANGE },
  ].sort((a, b) => a.t - b.t);
}

// The frame in which a change at t first shows, for a shutter (a part of a frame; the frame k's
// window is [k / 60, k / 60 + shutter / 60), src/subframes.js): the frame floor(t x 60) when its
// window holds t, else the next one; with shutter 0, the first frame time at or after t (ceil(t x 60)).
export function expectedFrame(t, shutter) {
  const k = frameAt(t); // the last k with k / 60 <= t
  return t === k / FPS || t < k / FPS + shutter / FPS ? k : k + 1;
}

// The first index whose difference is over the threshold, or -1 when none is. diffs[i] is how much
// the frame i differs from the frame i - 1 (diffs[0] = 0: frameDiffs).
export function onset(diffs, threshold) {
  return diffs.findIndex((d) => d > threshold);
}

// the mean absolute difference of two frames of one size (bytes; every channel of every pixel)
export function meanAbsDiff(a, b) {
  if (a.length !== b.length || !a.length) throw new Error(`frames of another size: ${a.length} and ${b.length} bytes`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
  return s / a.length;
}

// frames in order -> [0, meanAbsDiff(frame 1, frame 0), meanAbsDiff(frame 2, frame 1), ...]
export function frameDiffs(frames) {
  return frames.map((f, i) => (i === 0 ? 0 : meanAbsDiff(frames[i - 1], f)));
}

// the size [w, h] a clip is reduced to for the measure: GRID's cells over it (at least one)
export function measureSize(clip) {
  return [Math.max(1, Math.round(clip[2] * GRID[0])), Math.max(1, Math.round(clip[3] * GRID[1]))];
}

// The frames to decode for a moment expected in frame e, in a file of frames k0 ... k0 + frames - 1:
// { first, count } (WINDOW frames before e and after it), or null when the file does not hold them all.
export function windowOf(e, k0, frames) {
  const first = e - WINDOW;
  const last = e + WINDOW;
  return first >= k0 && last <= k0 + frames - 1 ? { first, count: last - first + 1 } : null;
}

// A moment's window measured: the frame differences from its frame first on, its threshold and its
// expected frame -> { onset: the frame where its change starts (null: none does), off: onset - expected
// (null), ok: within TOLERANCE }
export function judge(diffs, first, threshold, expected) {
  const i = onset(diffs, threshold);
  if (i < 0) return { onset: null, off: null, ok: false };
  const off = first + i - expected;
  return { onset: first + i, off, ok: Math.abs(off) <= TOLERANCE };
}

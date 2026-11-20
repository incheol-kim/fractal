// Pure helpers for the photo pieces (section C and the coda): cut-outs, their per-frame transform
// and what the pieces hide, all from the frame state (timeline.js frameState) as it is: no time
// computation here. No DOM, no WebGL (tests import it).
//
// A cut-out is every score.pieces row that shares t and note (a group and the pieces riding with
// it). It moves rigidly: one transform, taken from its largest leaf's row, about one pivot, the
// area-weighted centre of its leaves. A large fold cut-out first stands up about its hinge, the
// lower edge of the box round its leaves (foldPoint, by the fold of the timeline). A large one
// sliding or slamming in is then stretched back toward where it was a frame ago (smearWeight, by
// the smear of the timeline). A large pasted one gets a strip of masking tape across a top corner
// once it has landed (tapeSpot, by the tape of the timeline).

// The eye's distance for the fold's perspective, picture heights (a starting value).
// It must exceed a panel's height x sin(timeline.js FOLD_FROM), at most about 0.98, or its top reaches the eye (foldPoint's w).
export const FOLD_DIST = 1.6;

// The key of a cut-out: the score.pieces rows that share it, t and note, are one cut-out (groupCutouts;
// timeline.js foldingRows groups them the same way).
export const cutoutKey = (p) => `${p.t}|${p.note}`;

const bySizeArea = (pieces, leafOf) => (a, b) =>
  pieces[b].size - pieces[a].size || ((leafOf(pieces[b].leaf) || {}).area || 0) - ((leafOf(pieces[a].leaf) || {}).area || 0) || a - b;

// The hinge of the leaves leafOf gives for ids: the lower edge [x0, y, x1, y] (picture 0..1) of
// the box round their bboxes ([x0, y0, x1, y1], y down), or null when one of them has no bbox.
function hingeOf(ids, leafOf) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y = -Infinity;
  for (const id of ids) {
    const l = leafOf(id);
    if (!l || !l.bbox) return null;
    x0 = Math.min(x0, l.bbox[0]);
    x1 = Math.max(x1, l.bbox[2]);
    y = Math.max(y, l.bbox[3]);
  }
  return [x0, y, x1, y];
}

// score.pieces -> cut-outs in draw order: large first (the size of the largest leaf), then by
// time, then note, so small things land on top. leafOf(id) -> { area, c, bbox } (regions.json leaf).
// Each: { rows, leaves, t, note, style, size, pivot: [x, y] (picture 0..1), rep (row of the
// transform), hinge: [x0, y, x1, y] (picture 0..1, hingeOf) or null }
export function groupCutouts(pieces, leafOf) {
  const groups = new Map();
  pieces.forEach((p, row) => {
    const key = cutoutKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const cuts = [];
  for (const rows of groups.values()) {
    const first = pieces[rows[0]];
    let w = 0;
    let x = 0;
    let y = 0;
    for (const r of rows) {
      const l = leafOf(pieces[r].leaf);
      if (!l) continue;
      const a = l.area > 0 ? l.area : 0;
      w += a;
      x += a * l.c[0];
      y += a * l.c[1];
    }
    if (!(w > 0)) {
      // no areas: the plain mean of the centres
      const ls = rows.map((r) => leafOf(pieces[r].leaf)).filter(Boolean);
      w = ls.length || 1;
      x = ls.reduce((s, l) => s + l.c[0], 0);
      y = ls.reduce((s, l) => s + l.c[1], 0);
    }
    const rep = rows.slice().sort(bySizeArea(pieces, leafOf))[0];
    const leaves = rows.map((r) => pieces[r].leaf);
    cuts.push({
      rows,
      leaves,
      t: first.t,
      note: first.note,
      style: first.style,
      size: Math.max(...rows.map((r) => pieces[r].size)),
      pivot: [x / w, y / w],
      rep,
      hinge: hingeOf(leaves, leafOf),
    });
  }
  return cuts.sort((a, b) => b.size - a.size || a.t - b.t || a.note - b.note);
}

// leaf id -> its row in score.pieces
export function pieceRowOfLeaf(pieces) {
  return new Map(pieces.map((p, row) => [p.leaf, row]));
}

// A point p of a cut-out at rest turned deg degrees about its hinge, as the eye sees it: the
// cut-out lying toward the eye (deg > 0) or leaning away (deg < 0), seen in perspective from dist.
// All in picture px (the same unit on both axes); hinge [x0, y0, x1, y1]. With m the hinge's
// middle, u its direction, n = (u.y, -u.x) (up for a lower edge, y being down), q = p - m,
// a = q.u, b = q.n and w = 1 / (1 - b sin(deg) / dist):
//   p' = p + u a (w - 1) + n b (cos(deg) w - 1)
// At 0 degrees p' is exactly p (standing, the cut-out lies exactly on the picture), and a point on
// the hinge stays where it is at every angle. Mirrored in shaders/piece.vert.glsl (foldPoint).
export function foldPoint(p, hinge, deg, dist) {
  const len = Math.hypot(hinge[2] - hinge[0], hinge[3] - hinge[1]);
  const ux = (hinge[2] - hinge[0]) / len;
  const uy = (hinge[3] - hinge[1]) / len;
  const [nx, ny] = [uy, -ux];
  const qx = p[0] - (hinge[0] + hinge[2]) / 2;
  const qy = p[1] - (hinge[1] + hinge[3]) / 2;
  const a = qx * ux + qy * uy;
  const b = qx * nx + qy * ny;
  const rad = (deg * Math.PI) / 180;
  const w = 1 / (1 - (b * Math.sin(rad)) / dist);
  const k = b * (Math.cos(rad) * w - 1);
  return [p[0] + ux * a * (w - 1) + nx * k, p[1] + uy * a * (w - 1) + ny * k];
}

// How far a point of a smeared cut-out goes with the smear, 0..1 (the smear frames, timeline.js
// pieceAt's smx, smy): d the point at rest from the cut-out's pivot, sm the smear (where the
// cut-out was a frame ago minus where it is), radius the farthest point of its outline from the
// pivot; all in picture px. 0 without a smear; else 0.5 + d.(sm / |sm|) / (2 radius), clamped to
// 0..1: the leading edge stays (0), the trailing edge goes the whole smear back (1), and the photo
// between stretches evenly. Mirrored in shaders/piece.vert.glsl (smearWeight).
export function smearWeight(d, sm, radius) {
  const len = Math.hypot(sm[0], sm[1]);
  if (len === 0) return 0;
  const w = 0.5 + (d[0] * (sm[0] / len) + d[1] * (sm[1] / len)) / (2 * radius);
  return Math.min(Math.max(w, 0), 1);
}

// Masking tape: a large pasted cut-out, TAPE_MIN_SIZE or more and a slam, slide or fold, gets one
// strip of tape across a top corner, put on once it has landed (timeline.js pieceAt's tape; its size
// and colour are layers/pieces.js's).
export const TAPE_MIN_SIZE = 3;
const TAPE_STYLES = ['slam', 'slide', 'fold'];
const TAPE_MARGIN = 0.02; // an outline point nearer the picture's edge than this (0..1) is not taped

// Where the tape of a cut-out goes: { p: [x, y] (picture 0..1), deg } or null (no tape). The corner
// is a top one of the bbox of the cut-out's representative leaf (row cut.rep): the left for an even
// cut.note, the right for an odd one. p is the point of that leaf's outlines (every ring) nearest
// the corner in picture px (pic: { w, h }, the picture's size, regions.json w and h), of those
// TAPE_MARGIN or more inside the picture (0.02 <= x <= 0.98, 0.02 <= y <= 0.98); the strip's
// middle lies on it, so the strip lies half on the cut-out, half off. deg: the strip's long side,
// degrees from the picture's x toward its y (down): -40 at a left corner (rising to the right, across
// it), 40 at a right one (falling to the right), each turned (note x 37) % 31 - 15 more.
// null under TAPE_MIN_SIZE, for develop and bleed (not pasted), and when no outline point is inside.
export function tapeSpot(cut, leafOf, pic) {
  if (cut.size < TAPE_MIN_SIZE || !TAPE_STYLES.includes(cut.style)) return null;
  const leaf = leafOf(cut.leaves[cut.rows.indexOf(cut.rep)]);
  if (!leaf || !leaf.bbox || !leaf.polys) return null;
  const left = cut.note % 2 === 0;
  const [cx, cy] = [left ? leaf.bbox[0] : leaf.bbox[2], leaf.bbox[1]];
  let p = null;
  let best = Infinity;
  for (const ring of leaf.polys) {
    for (const [x, y] of ring) {
      if (x < TAPE_MARGIN || x > 1 - TAPE_MARGIN || y < TAPE_MARGIN || y > 1 - TAPE_MARGIN) continue;
      const d = Math.hypot((x - cx) * pic.w, (y - cy) * pic.h);
      if (d < best) {
        best = d;
        p = [x, y];
      }
    }
  }
  return p ? { p, deg: (left ? -40 : 40) + ((cut.note * 37) % 31) - 15 } : null;
}

// Per cut-out texels for the piece shader, CUT_FLOATS floats (CUT_TEXELS RGBA texels) each:
//   (s cos - 1, s sin, x, y), (border, shadow, cos, sin), (fold, smx, smy, tape)
// x, y in stage heights at zoom 1, rot about the pivot; border (CUT_BORDER) and shadow the timeline's;
// fold in degrees, about the hinge; smx, smy the smear (CUT_SMEAR), stage heights at zoom 1; tape 1
// once the tape is on (CUT_TAPE, 0 or 1). In place (no offset, no turn, scale 1, no fold, no smear)
// the first eleven are exactly (0, 0, 0, 0, 0|f, 0|f, 1, 0, 0, 0, 0), so the shader's
// p + (M - I) d + off is p itself.
// Reads state.pieces, state.fold, state.smear and state.tape only (row c.rep per cut-out); with
// ?fx=0 the timeline leaves the 12 fps jitter out of it, so a settled cut-out is then exactly in place.
export const CUT_TEXELS = 3;
export const CUT_FLOATS = CUT_TEXELS * 4;
export const CUT_BORDER = 4; // the second texel's x
export const CUT_FOLD = 8; // the third texel's x
export const CUT_SMEAR = 9; // the third texel's y and z
export const CUT_TAPE = 11; // the third texel's w
export function cutoutTexels(cuts, state, out = new Float32Array(cuts.length * CUT_FLOATS)) {
  cuts.forEach((c, k) => {
    const [, x, y, rot, s, border, shadow] = state.pieces.subarray(c.rep * 8, c.rep * 8 + 8);
    const rad = (rot * Math.PI) / 180;
    const cs = Math.cos(rad);
    const sn = Math.sin(rad);
    const at = k * CUT_FLOATS;
    out.set([s * cs - 1 + 0, s * sn + 0, x + 0, y + 0, border + 0, shadow + 0, cs, sn + 0], at);
    out[at + CUT_FOLD] = state.fold[c.rep] + 0;
    out[at + CUT_SMEAR] = state.smear[c.rep * 2] + 0;
    out[at + CUT_SMEAR + 1] = state.smear[c.rep * 2 + 1] + 0;
    out[at + CUT_TAPE] = state.tape[c.rep] + 0;
  });
  return out;
}

// score.strokes row -> the piece rows of the stroke's leaves (leaf and leaf2, those that have a
// piece), or null for a wire (photo) or a stroke that is not in strokeById: never hidden.
// rowOfLeaf: pieceRowOfLeaf(score.pieces).
export function strokeLeafRows(events, strokeById, rowOfLeaf) {
  return events.map((ev) => {
    const s = strokeById.get(ev.s);
    if (!s || ev.photo) return null;
    return [s.leaf, s.leaf2].filter((l) => l !== undefined && l !== null && rowOfLeaf.has(l)).map((l) => rowOfLeaf.get(l));
  });
}

// Strokes state (p, w, ink, photo per row) with p = 0 for every pencil or ink stroke whose leaves
// all have pieces at a = 1 (the photo covers them). leafRows[i]: the piece rows of stroke row i's
// leaves (leaf and leaf2), or null for a wire (never hidden). fold: the frame state's fold (1 per
// score row; null: nothing folds). A row whose cut-out is folding (fold not 0) does not cover its
// leaf yet, though its a is 1: the panel rises in front of everything and covers the lines as it
// goes, and they go on the frame it is upright, as under a develop piece once it is whole.
export function hideCoveredStrokes(strokes, leafRows, pieces, fold, out = new Float32Array(strokes.length)) {
  out.set(strokes);
  for (let i = 0; i < leafRows.length; i++) {
    const rows = leafRows[i];
    if (!rows || !rows.length || strokes[i * 4 + 3] > 0.5) continue;
    let all = true;
    for (const r of rows) {
      if (!(pieces[r * 8] >= 1) || (fold && fold[r] !== 0)) {
        all = false;
        break;
      }
    }
    if (all) out[i * 4] = 0;
  }
  return out;
}

// Flats state (a, dx, dy, s per row) with a = 0 where the leaf's piece is fully photo (a = 1 and
// ink = 0), so the flat's misregistered edge does not peek out around the photo. flatRows[i]:
// the piece row of flat row i's leaf (-1: none).
export function hidePhotoFlats(flats, flatRows, pieces, out = new Float32Array(flats.length)) {
  out.set(flats);
  for (let i = 0; i < flatRows.length; i++) {
    const r = flatRows[i];
    if (r >= 0 && pieces[r * 8] >= 1 && pieces[r * 8 + 7] <= 0) out[i * 4] = 0;
  }
  return out;
}

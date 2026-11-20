// Timeline: pure functions from (t, score) to the exact on-screen state. This is the one place where
// a time becomes state: the renderer and the layers draw frameState's values as they are.
// No DOM, no renderer, no state between calls, no randomness except ease.js hashes.
import { DUR } from './music.js';
import { clamp, lerp, smooth, outBack, hash21, noise1 } from './ease.js';
import { PIP } from './collage.js';
import { cutoutKey } from './cutouts.js';
import { cardAt, VIDEO_END } from './card.js';

const FRAME = 1 / 60;
// The glue chord (score.glue, 41.49) presses the pasted pieces flat (starting values). For
// GLUE_BREATH seconds before it they open from 1 to GLUE_OPEN times their torn edge or border,
// shadow, offset and jitter (a breath); on it they are pressed to nothing in SETTLE seconds
// (looseAt). On it too a white flash of FLASH over the whole frame fades out in FLASH_D seconds
// (flashAt), and the camera makes a small push-in (score.camera, data/cues.json punch).
export const GLUE_BREATH = 2 / 60;
export const GLUE_OPEN = 1.5;
export const SETTLE = 2 / 60;
export const FLASH = 0.15;
export const FLASH_D = 0.15;
const JIT_ROT = 0.15; // degrees
const JIT_POS = 0.6 / 2160; // screen heights
const SPREAD = 0.6; // seconds for a wash to spread over its whole shape

// Film effects (paper tooth, grain, gate weave) after the glue fall to this part by score.end.
export const FILM_FLOOR = 0.35;
// Gate weave at full film strength, stage heights (12 fps).
export const WEAVE = 0.3 / 1080;

// The page's time: the picture to the audio's end (DUR), then the end card (card.js), to the video's
// end (VIDEO_END).
export function clampT(t) {
  if (typeof t !== 'number' || Number.isNaN(t)) return 0;
  return clamp(t, 0, VIDEO_END);
}

function camOf(e) {
  return { zoom: e.zoom, cx: e.c[0], cy: e.c[1] };
}

export function cameraAt(t, camera) {
  let i = -1;
  for (let k = 0; k < camera.length; k++) {
    if (camera[k].t <= t) i = k;
    else break;
  }
  if (i < 0) return camOf(camera[0]);
  const e = camera[i];
  if (e.hold === undefined || e.ease === undefined) return camOf(e);
  // Temporary punch-in: return to the cut before it.
  let b = i - 1;
  while (b >= 0 && camera[b].hold !== undefined && camera[b].ease !== undefined) b--;
  const base = camOf(camera[Math.max(b, 0)]);
  const pun = camOf(e);
  const u = t - e.t - e.hold;
  if (u <= 0) return pun;
  if (u >= e.ease) return base;
  const k = smooth(0, e.ease, u);
  return {
    zoom: lerp(pun.zoom, base.zoom, k),
    cx: lerp(pun.cx, base.cx, k),
    cy: lerp(pun.cy, base.cy, k),
  };
}

// Hand shake (starting values): through the six high chords (score.shake, data/cues.json) the camera
// wanders smoothly at 60 fps, a little like a hand-held one. amp: the largest shift, screen heights;
// hz: how many new random targets per second. It eases in over SHAKE_IN and out over SHAKE_OUT
// seconds, and pushes in SHAKE_COVER x amp, so a shift of amp never uncovers the edge (a shift of amp
// needs a zoom of at least 1 + 2 amp; SHAKE_COVER 2.2 leaves a margin).
export const SHAKE = { amp: 3.5 / 1080, hz: 2.5 };
export const SHAKE_IN = 0.25;
export const SHAKE_OUT = 0.35;
export const SHAKE_COVER = 2.2;

// -> { x, y, zoom }: the camera's shift (screen heights) and extra zoom factor at t; exactly
// { x: 0, y: 0, zoom: 1 } outside the window and without a shake
export function shakeAt(t, shake) {
  const none = { x: 0, y: 0, zoom: 1 };
  if (!shake || !(t > shake.from && t < shake.to)) return none;
  const { amp, hz } = SHAKE;
  const env = smooth(shake.from, shake.from + SHAKE_IN, t) * (1 - smooth(shake.to - SHAKE_OUT, shake.to, t));
  return {
    x: amp * env * noise1(t * hz, 7001),
    y: amp * env * noise1(t * hz, 7002),
    zoom: 1 + SHAKE_COVER * amp * env,
  };
}

export function strokeAt(t, ev) {
  const p = ev.d > 0 ? clamp((t - ev.t) / ev.d, 0, 1) : t >= ev.t ? 1 : 0;
  return { p, w: ev.w, ink: ev.ink };
}

export function washAt(t, w) {
  if (t < w.t) return 0;
  const rise = smooth(0, 0.4, t - w.t);
  const low = w.gain * 0.12;
  const fall = smooth(w.t + 0.4, w.t + Math.max(w.d, 0.4), t);
  return lerp(w.gain * rise, low, fall);
}

// The border, shadow, offset and jitter of a flat or a photo piece that arrived at evT: looseAt
// (the breath before the glue chord, pressed to 0 after it); 0 always for events that arrive on
// or after the chord.
function glueFactor(t, evT, glue) {
  if (evT >= glue) return 0;
  return looseAt(t, glue);
}

export function flatAt(t, ev, glue) {
  if (t < ev.t) return { a: 0, dx: 0, dy: 0, s: 1 };
  // the collage has covered this plane
  if (ev.until !== undefined && t >= ev.until) return { a: 0, dx: 0, dy: 0, s: 1 };
  const u = clamp((t - ev.t) / (2 * FRAME), 0, 1);
  const s = lerp(1.12, 1, outBack(u));
  const f = glueFactor(t, ev.t, glue);
  const mag = (h) => (2 + 4 * h) / 2160;
  const sign = (h) => (h < 0.5 ? -1 : 1);
  const hx = hash21(ev.leaf, 101);
  const hy = hash21(ev.leaf, 202);
  const dx = sign(hash21(ev.leaf, 303)) * mag(hx) * f + 0;
  const dy = sign(hash21(ev.leaf, 404)) * mag(hy) * f + 0;
  return { a: 1, dx, dy, s };
}

// Collage (starting values). PASTE: a block's new cut is pasted over the old one in this long.
// TEAR: a torn-off fragment takes this long to leave once its photo arrives (seconds).
export const PASTE = 2 / 60;
export const TEAR = 8 / 60;
const EDGE = 1e-9; // a progress that is this close to done is done (float rounding of t + d)

// 0..1 progress of dt over d, exactly 1 once dt has reached d (up to rounding).
function progress(dt, d) {
  if (dt <= 0) return 0;
  return dt >= d - EDGE ? 1 : dt / d;
}

// A bleed piece comes up in this long, whatever its d (seconds).
const BLEED = 0.5;

// How far a develop or bleed piece has come up at t, 0..1, exactly 1 once it is whole: its `a`
// (pieceAt), and what the collage fragment under it goes by (collageLeafAt).
export function emergeAt(t, piece) {
  const d = piece.style === 'bleed' ? BLEED : piece.d;
  return d > 0 ? progress(t - piece.t, d) : t >= piece.t ? 1 : 0;
}

// How loose the pasted pieces are: the strength of the collage's torn edge, tilt, shadow and
// offset (and, by glueFactor, of the flats' and photo pieces' border, shadow, offset and jitter).
// 1 until glue - GLUE_BREATH, rising to GLUE_OPEN at the glue chord, pressed from there to 0 by
// glue + SETTLE, 0 after. The collage's tilt goes no further than 1 (collage.js cutUV).
export function looseAt(t, glue) {
  if (t < glue) return 1 + (GLUE_OPEN - 1) * smooth(glue - GLUE_BREATH, glue, t);
  return GLUE_OPEN * (1 - smooth(glue, glue + SETTLE, t));
}

// The white over the whole frame on the glue chord (layers/flash.js), 0..1: none before it, FLASH
// on it, falling as (1 - u)^2 with u = (t - glue) / FLASH_D to 0 at u = 1, none after.
export function flashAt(t, glue) {
  if (t < glue) return 0;
  const u = progress(t - glue, FLASH_D);
  return u >= 1 ? 0 : FLASH * (1 - u) * (1 - u);
}

// One leaf of the collage. ev: a row of score.collage.leaves, piece: that leaf's score.pieces event.
// rim: how much of the fragment's torn edge and shadow shows, and of its offset (dx, dy): under a
// develop or bleed piece 1 minus the piece's a, so they are all but gone when the piece is whole and
// the fragment goes (nothing pops); 1 for every other fragment.
// foldD > 0: the piece stands up with a folding cut-out in foldD seconds (FOLD_D; foldingLeaves).
// The fragment is then not torn off: the panel rises in front of it and covers it, and it goes, as
// under a develop piece, when the panel is up (its rim falling from 1 on the note to 0 then).
export function collageLeafAt(t, ev, piece, glue, foldD = 0) {
  if (t < ev.t) return { a: 0, dx: 0, dy: 0, s: 1, tear: 0, rim: 1 };
  const folds = piece && foldD > 0;
  const tear = ev.tear && !folds ? progress(t - ev.off, TEAR) : 0;
  let covered = false;
  let rim = 1;
  if (piece) {
    if (folds) {
      const e = progress(t - piece.t, foldD);
      covered = e >= 1;
      rim = 1 - e;
    } else if (ev.tear) covered = tear >= 1;
    else if (piece.style === 'develop' || piece.style === 'bleed') {
      const e = emergeAt(t, piece);
      covered = e >= 1;
      rim = 1 - e;
    } else {
      const p = pieceAt(t, piece, glue, false);
      covered = p.a >= 1 && p.ink <= 0;
    }
  }
  const s = lerp(1.12, 1, outBack(progress(t - ev.t, 2 * FRAME)));
  const f = looseAt(t, glue) * rim;
  const mag = (h) => (2 + 4 * h) / 2160;
  const sign = (h) => (h < 0.5 ? -1 : 1);
  const dx = sign(hash21(ev.leaf, 707)) * mag(hash21(ev.leaf, 505)) * f + 0;
  const dy = sign(hash21(ev.leaf, 808)) * mag(hash21(ev.leaf, 606)) * f + 0;
  return { a: covered ? 0 : 1, dx, dy, s, tear, rim };
}

// One block of the tower. events: this block's changes in time order ({ t, to }).
//   cur  the cut shown now (-1 before first), prev the cut it is being pasted over (-1 when not pasting),
//   u    progress of the last paste, k  changes so far
export function collageBlockAt(t, first, start, events) {
  if (t < first) return { cur: -1, prev: -1, u: 1, k: 0 };
  let k = 0;
  while (k < events.length && events[k].t <= t) k++;
  if (k === 0) return { cur: start, prev: -1, u: 1, k: 0 };
  const u = progress(t - events[k - 1].t, PASTE);
  const prev = u < 1 ? (k === 1 ? start : events[k - 2].to) : -1;
  return { cur: events[k - 1].to, prev, u, k };
}

export function strengths(score) {
  return score.collage ? Object.keys(score.collage.changes) : [];
}

// Per score (a cache keyed only on the score object, it cannot change a result): each block's
// events by strength, its collage leaf rows, and the photo event of each leaf.
const collageCache = new WeakMap();
function collageIndex(score) {
  let c = collageCache.get(score);
  if (c) return c;
  const col = score.collage;
  const events = {};
  for (const name of Object.keys(col.changes)) {
    const per = col.blocks.map(() => []);
    for (const e of col.changes[name].events) per[e.block].push(e);
    events[name] = per;
  }
  const leafRows = col.blocks.map(() => []);
  col.leaves.forEach((ev, i) => leafRows[ev.block].push(i));
  const pieceOf = new Map();
  for (const p of score.pieces) if (!pieceOf.has(p.leaf)) pieceOf.set(p.leaf, p);
  c = { events, leafRows, pieceOf, folding: foldingLeaves(score.pieces) };
  collageCache.set(score, c);
  return c;
}

// One collage leaf row ev at t (collageLeafAt with its photo piece and, under a folding cut-out, the
// fold's FOLD_D). index: collageIndex(score).
function collageLeafRow(t, ev, index, glue) {
  return collageLeafAt(t, ev, index.pieceOf.get(ev.leaf), glue, index.folding.has(ev.leaf) ? FOLD_D : 0);
}

function collageState(t, score, strength, glue) {
  const col = score.collage;
  const str = col.changes[strength] ? strength : col.default;
  const index = collageIndex(score);
  const blocks = new Float32Array(col.blocks.length * 4);
  col.blocks.forEach((b, i) => {
    const r = collageBlockAt(t, b.first, col.changes[str].start[i], index.events[str][i]);
    blocks.set([r.cur, r.prev, r.u, r.k], i * 4);
  });
  const leaves = new Float32Array(col.leaves.length * 4);
  const tear = new Float32Array(col.leaves.length);
  const rim = new Float32Array(col.leaves.length);
  col.leaves.forEach((ev, i) => {
    const r = collageLeafRow(t, ev, index, glue);
    leaves.set([r.a, r.dx, r.dy, r.s], i * 4);
    tear[i] = r.tear;
    rim[i] = r.rim;
  });
  return { strength: str, loose: looseAt(t, glue), blocks, leaves, tear, rim };
}

// The block as it showed just before t0: only its changes before t0; nothing (cur -1) up to its first.
function blockBefore(t0, first, start, events) {
  if (!(t0 > first)) return { cur: -1, prev: -1, u: 1, k: 0 };
  return collageBlockAt(t0, first, start, events.filter((e) => e.t < t0));
}

// Picture in picture (design 6.2's 4): the collage state at t with the glass rooms of score.pip as
// windows that show the whole frame in miniature (collage.js PIP; renderer.js draws it), or null
// when no window shows at t (the frame is then base's alone). base: collageState's result at t. For
// each row { block, t: P, accent } of score.pip, from P on:
//   - until the block's first change to its accent at or after P in base's strength (E; none for an
//     accent of -1 or without such a change: never) the block is [PIP, the cut that showed just
//     before P while u < 1 else -1, u, the changes before P + 1] with u = (t - P) / PASTE in 0..1:
//     the window is pasted over the room as a new cut is, and its cuts do not show meanwhile;
//   - from E on the block is base's, but the accent is pasted over the window (prev PIP) while it
//     comes down;
//   - its leaves that arrive after P arrive at P instead (the whole room is the window): each leaf
//     row as collageState computes it, with ev.t P.
// A window shows while its block's cur or prev is PIP and a leaf of it is drawn (a > 0).
export function pipCollage(t, score, base, glue) {
  const col = score.collage;
  const index = collageIndex(score);
  const str = base.strength;
  let out = null;
  let shows = false;
  for (const { block: row, t: P, accent } of score.pip) {
    if (!(t >= P)) continue;
    const evs = index.events[str][row];
    const ai = accent >= 0 ? evs.findIndex((e) => e.to === accent && e.t >= P) : -1;
    const E = ai >= 0 ? evs[ai].t : Infinity;
    let blk;
    if (t >= E) {
      const [cur, prev, u, k] = base.blocks.subarray(row * 4, row * 4 + 4);
      blk = [cur, prev !== -1 && k === ai + 1 ? PIP : prev, u, k];
    } else {
      const was = blockBefore(P, col.blocks[row].first, col.changes[str].start[row], evs);
      const u = progress(t - P, PASTE);
      blk = [PIP, u < 1 ? was.cur : -1, u, was.k + 1];
    }
    if (!out) out = { ...base, blocks: base.blocks.slice(), leaves: base.leaves.slice(), tear: base.tear.slice(), rim: base.rim.slice() };
    out.blocks.set(blk, row * 4);
    const isWindow = blk[0] === PIP || blk[1] === PIP;
    for (const i of index.leafRows[row]) {
      const ev = col.leaves[i];
      const r = collageLeafRow(t, ev.t > P ? { ...ev, t: P } : ev, index, glue);
      out.leaves.set([r.a, r.dx, r.dy, r.s], i * 4);
      out.tear[i] = r.tear;
      out.rim[i] = r.rim;
      if (isWindow && r.a > 0) shows = true;
    }
  }
  return shows ? out : null;
}

// How strong the paper tooth, film grain and gate weave are: full until the glue (41.49), then
// easing down to FILM_FLOOR by the end of the music (score.end), and held there.
export function filmStrength(t, glue, end) {
  return lerp(1, FILM_FLOOR, smooth(glue, end, t));
}

// The fold (design 7 and 8, the 37.81 chord; starting values): a fold piece of FOLD_MIN_SIZE or
// more (the three colour blocks) appears lying toward the eye at FOLD_FROM degrees about its lower
// edge and stands up to 0 (in place) in FOLD_D seconds; its cut-out is drawn folded about that hinge
// (cutouts.js foldPoint), in front of the other pieces, over the wrong fragment under it, which goes
// when it is up (collageLeafAt). The smaller fold pieces slam as before.
export const FOLD_MIN_SIZE = 3;
export const FOLD_FROM = 78; // degrees
export const FOLD_D = 6 / 60; // seconds

// The fold's angle dt seconds after the piece landed, degrees, with u = dt / FOLD_D in 0..1: it
// rises as FOLD_FROM (1 - u^2), faster and faster, and snaps upright. Exactly 0 from dt = FOLD_D on
// (up to rounding).
export function foldAngle(dt) {
  const u = progress(dt, FOLD_D);
  if (u >= 1) return 0;
  return FOLD_FROM * (1 - u * u);
}

// Whether a cut-out folds, from its score.pieces rows (those sharing t and note, cutouts.js
// groupCutouts): every row is a fold piece and the largest is FOLD_MIN_SIZE or more. The one rule
// for the panel (each of its rows takes the fold, so its representative does whichever row that
// is), the fragment under it (no tear, collageLeafAt) and the lines on it (they stay while it
// folds, cutouts.js hideCoveredStrokes).
export function cutoutFolds(rows) {
  return rows.length > 0 && rows.every((p) => p.style === 'fold') && Math.max(...rows.map((p) => p.size)) >= FOLD_MIN_SIZE;
}

// Smear frames (design 8, the sky's 30.32; starting values): a slide or a slam (a fold piece that
// does not fold is a slam) of SMEAR_MIN_SIZE or more is drawn, on each frame of its entry and the
// one after, stretched SMEAR times back to where it was a frame ago, as in cel animation. Only its
// offset is stretched, not its turn or scale (pieceAt's smx, smy).
export const SMEAR_MIN_SIZE = 3;
export const SMEAR = 1;

// How a slide and a slam come in: e, 0 at "from" and 1 in place, over d seconds from landing.
const SLIDE = { d: 8 * FRAME, ease: (u) => 1 - (1 - u) * (1 - u) * (1 - u) };
const SLAM = { d: 2 * FRAME, ease: outBack };
const entryAt = (dt, entry) => entry.ease(clamp(dt / entry.d, 0, 1));

// The rows of pieces whose cut-out folds (cutoutFolds), a Set of row indices.
export function foldingRows(pieces) {
  const groups = new Map();
  pieces.forEach((p, i) => {
    const key = cutoutKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const out = new Set();
  for (const rows of groups.values()) if (cutoutFolds(rows.map((i) => pieces[i]))) for (const i of rows) out.add(i);
  return out;
}

// The leaves of those rows: the leaves that stand up with a folding cut-out.
export function foldingLeaves(pieces) {
  return new Set([...foldingRows(pieces)].map((i) => pieces[i].leaf));
}

// Per score (a cache keyed only on the score object, it cannot change a result): foldingRows.
const foldCache = new WeakMap();
function foldingRowsOf(score) {
  if (!foldCache.has(score)) foldCache.set(score, foldingRows(score.pieces));
  return foldCache.get(score);
}

// fx false (?fx=0): no 12 fps jitter; the piece is exactly where it would be without it.
// folds: whether ev's cut-out folds (cutoutFolds of its rows; frameState passes foldingRows); by
// default ev taken as a cut-out of its own. A row of a folding cut-out stands up in place (fold,
// degrees; x = y = rot = 0, s = 1) and jitters from ev.t + FOLD_D on. For every other piece fold is
// 0 and a fold piece is exactly what the same piece as a slam is.
// smx, smy (stage heights): the smear of a slide or a slam (so not of a row that folds) of
// SMEAR_MIN_SIZE or more, for 0 <= dt < its entry + one frame: SMEAR times from's offset times
// (e(dt) - e(max(dt - FRAME, 0))), where it was a frame ago (from, before its first frame) minus
// where it is. Exactly 0 at every other time and for every other piece.
// tape (0 or 1): the masking tape (cutouts.js tapeSpot) is on, 1, for a slam, slide or fold piece
// from dt = its entry + one frame on (the entry: FOLD_D for a row that folds, else the slide's 8
// frames or the slam's 2; the frame: the smear's last), so it is never on while the piece folds or
// smears. 0 before and for develop and bleed. Its size does not matter here (tapeSpot leaves the
// small ones out); on the glue chord the border hides it.
export function pieceAt(t, ev, glue, fx = true, folds = cutoutFolds([ev])) {
  const style = ev.style;
  const [fdx, fdy, frot, fs] = ev.from;
  const dt = t - ev.t;
  let a = dt < 0 ? 0 : 1;
  let ink = 0;
  let e = 1; // 0 = at "from", 1 = in place
  let landEnd = ev.t;
  let fold = 0;
  let smx = 0;
  let smy = 0;
  let tape = 0;
  // develop and bleed emerge in place (a room developing, the tree blooming): they are not
  // pasted paper, so they have no white border, no shadow and no 12 fps jitter at any time
  let pasted = true;

  if (style === 'develop' || style === 'bleed') {
    a = emergeAt(t, ev);
    ink = 1 - a;
    pasted = false;
  } else {
    // slam, fold (a large one stands up; the others are drawn as slam), slide
    let entryD; // how long its entry takes (seconds)
    if (folds) {
      // in place throughout (from's offset, turn and scale are not used), only turned about the hinge
      entryD = FOLD_D;
      landEnd = ev.t + FOLD_D;
      if (dt >= 0) fold = foldAngle(dt);
    } else {
      const entry = style === 'slide' ? SLIDE : SLAM;
      entryD = entry.d;
      e = entryAt(dt, entry);
      landEnd = ev.t + entry.d;
      const smears = ev.size >= SMEAR_MIN_SIZE;
      if (smears && dt >= 0 && dt < entry.d + FRAME - EDGE) {
        const back = SMEAR * (e - entryAt(Math.max(dt - FRAME, 0), entry));
        smx = fdx * back;
        smy = fdy * back;
      }
    }
    ink = dt >= 0 && dt < (1 + ev.size) * FRAME ? 1 : 0;
    // the tape is put on once the piece has landed: on the first frame after the smear's last
    if (dt >= entryD + FRAME - EDGE) tape = 1;
  }

  const f = glueFactor(t, ev.t, glue);
  let jx = 0;
  let jy = 0;
  let jr = 0;
  if (fx && pasted && f > 0 && t >= landEnd) {
    const tick = Math.floor(t * 12);
    jx = (hash21(ev.leaf, tick * 4 + 1) * 2 - 1) * JIT_POS * f;
    jy = (hash21(ev.leaf, tick * 4 + 2) * 2 - 1) * JIT_POS * f;
    jr = (hash21(ev.leaf, tick * 4 + 3) * 2 - 1) * JIT_ROT * f;
  }

  return {
    a,
    x: fdx * (1 - e) + jx + 0,
    y: fdy * (1 - e) + jy + 0,
    rot: frot * (1 - e) + jr + 0,
    s: fs * (1 - e) + e,
    border: pasted ? f : 0,
    shadow: pasted ? f : 0,
    ink,
    fold: fold + 0,
    smx: smx + 0,
    smy: smy + 0,
    tape,
  };
}

// Signs of life (design 7, 8 and 10.4; starting values): from the cello's last note (score.end,
// 44.87) to the end of the picture (DUR, the audio's end, 2.207 s later) the finished picture lives
// a little, where assets/life.png lets it (piece.frag.glsl): the clouds drift to the right, the
// leaves tremble (12 fps), the wires sway (stroke.frag.glsl wire()) and the rooms' lights breathe.
// All of it rises from 0 over LIFE_IN seconds. After the picture the end card's black covers it
// (frameState's card).
export const LIFE_IN = 0.8; // seconds
export const LIFE_MAX = 2.5; // seconds after the last note it runs for (it covers the 2.207 s to the picture's end)
export const LIFE_FLOW = 5 / 2160; // screen heights a second: how fast the clouds drift at full strength
export const LIFE_TREMBLE = 1.2 / 2160; // screen heights: how far a leaf trembles at most
export const LIFE_BREATH = 0.035; // the rooms' light goes up and down by this part of itself
export const LIFE_BREATH_HZ = 0.45;
export const LIFE_SWAY = 1.2; // picture px: how far a wire sways up and down at most, less than ribbons.js WIRE_PAD
export const LIFE_SWAY_HZ = 0.6;

// The signs of life at t for the last note at end and fx (false: ?fx=0) -> { k, drift, tremble,
// breath, sway, phase }. With tau = clamp(t - end, 0, LIFE_MAX):
//   k        the strength, smooth from 0 to 1 over LIFE_IN
//   drift    how far the clouds have gone to the right (screen heights): the integral of LIFE_FLOW k
//            over tau, so their speed rises with the strength from 0 to LIFE_FLOW and never passes
//            it. With u = clamp(tau / LIFE_IN, 0, 1):
//            LIFE_FLOW (LIFE_IN (u^3 - u^4 / 2) + max(tau - LIFE_IN, 0))
//   tremble  how far a leaf trembles, LIFE_TREMBLE k (screen heights)
//   breath   the rooms' light factor - 1, LIFE_BREATH k sin(2 pi LIFE_BREATH_HZ tau)
//   sway     how far a wire sways at most, LIFE_SWAY k (picture px; the life map's flow scales it)
//   phase    the sway's phase, 2 pi LIFE_SWAY_HZ tau (radians)
// All exactly 0 up to end (tau 0) and with fx false.
export function lifeAt(t, end, fx) {
  if (!fx) return { k: 0, drift: 0, tremble: 0, breath: 0, sway: 0, phase: 0 };
  const tau = clamp(t - end, 0, LIFE_MAX);
  const k = smooth(0, LIFE_IN, tau);
  const u = clamp(tau / LIFE_IN, 0, 1);
  return {
    k,
    drift: LIFE_FLOW * (LIFE_IN * (u * u * u - (u * u * u * u) / 2) + Math.max(tau - LIFE_IN, 0)),
    tremble: LIFE_TREMBLE * k,
    breath: LIFE_BREATH * k * Math.sin(2 * Math.PI * LIFE_BREATH_HZ * tau),
    sway: LIFE_SWAY * k,
    phase: 2 * Math.PI * LIFE_SWAY_HZ * tau,
  };
}

// The state of the frame at t: everything the renderer and the layers draw.
//   tick12      floor(t * 12), the seed of everything that moves at 12 fps
//   camera      { zoom, cx, cy } (with the hand shake's push-in)
//   shake       [x, y] the hand shake's camera shift, screen heights (shakeAt)
//   strokes     4 per score row: p, w, ink, photo
//   flats       4 per score row: a, dx, dy, s
//   pieces      8 per score row: a, x, y, rot, s, border, shadow, ink
//   fold        1 per score row: pieceAt's fold, degrees (0 but while the row's cut-out folds,
//               cutoutFolds: every row of it has the cut-out's angle)
//   smear       2 per score row: pieceAt's smx, smy, stage heights (0 but while a large slide or
//               slam comes in)
//   tape        1 per score row: pieceAt's tape, 0 or 1 (1 once a slam, slide or fold piece has
//               landed)
//   washes      per wash: density
//   plateToKey  0..1, the plate crossfading to the key image over 0.3 s from score.end; always 0
//               while the signs of life are on (fx): the pieces show the plate, which lives, and
//               the wires are drawn by their strokes
//   life        lifeAt(t, score.end, fx): the signs of life after the last note
//   washSpread  per wash: 0..1, how far it has spread over its shape
//   film        filmStrength: paper tooth, grain and gate weave
//   weave       [x, y] gate weave, stage heights
//   collage     null without score.collage, else { strength, loose, blocks (4 per block: cur, prev,
//               u, k; a cur or prev of collage.js PIP is the miniature of the frame), leaves (4 per
//               collage leaf: a, dx, dy, s), tear (1 per collage leaf), rim (1 per collage leaf: how
//               much of its torn edge and shadow shows, collageLeafAt) }: while a glass room is a
//               window (pipCollage) the state with the windows
//   collageBase while a window shows, the collage without the windows (the innermost miniature
//               draws it, renderer.js); else null: always without score.pip
//   flash       flashAt: the white over the whole frame on the glue chord, 0..1
//   card        the end card after the picture (card.js): { black, a } of cardAt(t, DUR), the picture
//               ending with the audio; everything else goes on as it is under the black
// opts.strength picks the change set of the collage (unknown or missing: score.collage.default).
// opts.fx false (?fx=0): nothing moves with the tick (tick12 0, no weave, no piece jitter) and there
// are no signs of life (the plate turns into the key image, which tools/check_final.mjs compares);
// everything else is the same (the glue chord's breath, press, push-in and flash are bound to the
// note, not film effects; the end card is not a film effect either).
export function frameState(t, score, opts = {}) {
  t = clampT(t);
  const fx = opts.fx !== false;
  const glue = score.glue;
  const tick12 = fx ? Math.floor(t * 12) : 0;
  const strokes = new Float32Array(score.strokes.length * 4);
  score.strokes.forEach((ev, i) => {
    const r = strokeAt(t, ev);
    strokes.set([r.p, r.w, r.ink, ev.photo ? 1 : 0], i * 4);
  });
  const flats = new Float32Array(score.flats.length * 4);
  score.flats.forEach((ev, i) => {
    const r = flatAt(t, ev, glue);
    flats.set([r.a, r.dx, r.dy, r.s], i * 4);
  });
  const pieces = new Float32Array(score.pieces.length * 8);
  const fold = new Float32Array(score.pieces.length);
  const smear = new Float32Array(score.pieces.length * 2);
  const tape = new Float32Array(score.pieces.length);
  const folding = foldingRowsOf(score);
  score.pieces.forEach((ev, i) => {
    const r = pieceAt(t, ev, glue, fx, folding.has(i));
    pieces.set([r.a, r.x, r.y, r.rot, r.s, r.border, r.shadow, r.ink], i * 8);
    fold[i] = r.fold;
    smear[i * 2] = r.smx;
    smear[i * 2 + 1] = r.smy;
    tape[i] = r.tape;
  });
  const washes = new Float32Array(score.washes.length);
  const washSpread = new Float32Array(score.washes.length);
  score.washes.forEach((w, i) => {
    washes[i] = washAt(t, w);
    washSpread[i] = smooth(0, SPREAD, t - w.t);
  });
  const film = filmStrength(t, glue, score.end);
  const weave = fx
    ? [(hash21(tick12, 9101) * 2 - 1) * WEAVE * film, (hash21(tick12, 9203) * 2 - 1) * WEAVE * film]
    : [0, 0];
  // the hand shake is the camera, not a film effect: the same with fx off
  const sh = shakeAt(t, score.shake);
  const cam = cameraAt(t, score.camera);
  const camera = sh.zoom === 1 ? cam : { ...cam, zoom: cam.zoom * sh.zoom };
  const collage = score.collage ? collageState(t, score, opts.strength, glue) : null;
  const windows = collage && score.pip ? pipCollage(t, score, collage, glue) : null;
  return {
    t,
    tick12,
    camera,
    shake: [sh.x, sh.y],
    strokes,
    flats,
    pieces,
    fold,
    smear,
    tape,
    washes,
    plateToKey: fx ? 0 : clamp((t - score.end) / 0.3, 0, 1),
    life: lifeAt(t, score.end, fx),
    washSpread,
    film,
    weave,
    collage: windows || collage,
    collageBase: windows ? collage : null,
    flash: flashAt(t, glue),
    card: cardAt(t, DUR),
  };
}

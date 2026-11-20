import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DUR } from '../src/music.js';
import {
  clampT,
  cameraAt,
  strokeAt,
  washAt,
  flatAt,
  pieceAt,
  looseAt,
  flashAt,
  frameState,
  filmStrength,
  FILM_FLOOR,
  WEAVE,
  GLUE_BREATH,
  GLUE_OPEN,
  SETTLE,
  FLASH,
  FLASH_D,
} from '../src/timeline.js';
import { VIDEO_END } from '../src/card.js';
import { assertStateless } from './helpers.js';

const F = 1 / 60;
const EPS = 1e-9;
const JIT_XY = 0.6 / 2160 + 1e-12;

// the page's time: the picture to the audio's end, then the end card, to the video's end (src/card.js)
test('clampT', () => {
  assert.equal(clampT(-3), 0);
  assert.equal(clampT(NaN), 0);
  assert.equal(clampT('x'), 0);
  assert.equal(clampT(99), VIDEO_END);
  assert.equal(clampT(52), 52);
  assert.equal(clampT(49), 49);
  assert.equal(clampT(5), 5);
});

test('cameraAt: cuts apply at their time', () => {
  const cam = [
    { t: 0, zoom: 1, c: [0.5, 0.5] },
    { t: 10, zoom: 2, c: [0.2, 0.3] },
  ];
  assert.equal(cameraAt(9.999, cam).zoom, 1);
  assert.equal(cameraAt(10, cam).zoom, 2);
  assert.equal(cameraAt(10.001, cam).zoom, 2);
  const c = cameraAt(11, cam);
  assert.equal(c.cx, 0.2);
  assert.equal(c.cy, 0.3);
});

test('cameraAt: punch-in holds, eases back to previous cut exactly', () => {
  const cam = [
    { t: 0, zoom: 1, c: [0.5, 0.5] },
    { t: 10, zoom: 3, c: [0.1, 0.1], hold: 1, ease: 0.5 },
  ];
  assert.equal(cameraAt(10.5, cam).zoom, 3);
  assert.equal(cameraAt(11, cam).zoom, 3);
  const mid = cameraAt(11.25, cam).zoom;
  assert.ok(mid > 1 && mid < 3);
  assert.equal(cameraAt(11.5, cam).zoom, 1);
  assert.equal(cameraAt(20, cam).zoom, 1);
  assert.equal(cameraAt(20, cam).cx, 0.5);
});

test('strokeAt', () => {
  const ev = { t: 2, d: 4, w: 0.7, ink: 0.4 };
  assert.equal(strokeAt(1, ev).p, 0);
  assert.equal(strokeAt(2, ev).p, 0);
  assert.equal(strokeAt(4, ev).p, 0.5);
  assert.equal(strokeAt(7, ev).p, 1);
  assert.equal(strokeAt(4, ev).w, 0.7);
  assert.equal(strokeAt(4, ev).ink, 0.4);
});

test('washAt', () => {
  const w = { t: 5, d: 3, gain: 0.8, leaves: [] };
  assert.equal(washAt(4.9, w), 0);
  assert.ok(Math.abs(washAt(5.4, w) - 0.8) < 1e-12);
  assert.ok(Math.abs(washAt(8, w) - 0.8 * 0.12) < 1e-12);
  assert.ok(Math.abs(washAt(100, w) - 0.8 * 0.12) < 1e-12);
  const mid = washAt(6.5, w);
  assert.ok(mid < 0.8 && mid > 0.8 * 0.12);
});

test('flatAt', () => {
  const ev = { leaf: 7, t: 3, note: 60 };
  const glue = 20;
  assert.equal(flatAt(2.99, ev, glue).a, 0);
  const s0 = flatAt(3, ev, glue);
  assert.equal(s0.a, 1);
  assert.ok(s0.s > 1);
  assert.equal(flatAt(3 + 2 * F + EPS, ev, glue).s, 1);
  const after = flatAt(glue + 0.05 + EPS, ev, glue);
  assert.ok(after.dx === 0 && after.dy === 0);
  const a = flatAt(5, ev, glue);
  const b = flatAt(9, ev, glue);
  assert.equal(a.dx, b.dx);
  assert.equal(a.dy, b.dy);
  assert.ok(Math.abs(a.dx) >= 2 / 2160 - 1e-12 && Math.abs(a.dx) <= 6 / 2160 + 1e-12);
});

test('flatAt: a flat with until is gone once the collage covers it', () => {
  const ev = { leaf: 5, t: 16, note: 1, until: 20 };
  assert.equal(flatAt(19.99, ev, 41.4952).a, 1);
  assert.equal(flatAt(20, ev, 41.4952).a, 0);
  assert.equal(flatAt(25, { leaf: 5, t: 16, note: 1 }, 41.4952).a, 1);
});

const piece = (style, size, extra = {}) => ({
  leaf: 3, size, t: 10, d: 2, note: 50, style, from: [0.3, -0.2, 12, 1.5], ...extra,
});

test('pieceAt: slam', () => {
  const glue = 30;
  assert.equal(pieceAt(9.99, piece('slam', 0), glue).a, 0);
  assert.equal(pieceAt(10, piece('slam', 0), glue).ink, 1);
  assert.equal(pieceAt(10 + 2 * F + EPS, piece('slam', 0), glue).ink, 0);
  assert.equal(pieceAt(10 + 4 * F + EPS, piece('slam', 4), glue).ink, 1);
  assert.equal(pieceAt(10 + 5 * F + EPS, piece('slam', 4), glue).ink, 0);
  const p = pieceAt(10 + 2 * F + EPS, piece('slam', 0), glue);
  assert.ok(Math.abs(p.x) <= JIT_XY && Math.abs(p.y) <= JIT_XY);
  assert.ok(Math.abs(p.rot) <= 0.15 + 1e-12);
  assert.equal(p.s, 1);
  assert.equal(p.border, 1);
  assert.equal(p.shadow, 1);
  const start = pieceAt(10, piece('slam', 0), glue);
  assert.ok(Math.abs(start.x - 0.3) < 1e-12 && Math.abs(start.s - 1.5) < 1e-12);
  const g = pieceAt(glue + 0.05 + EPS, piece('slam', 0), glue);
  assert.ok(g.border === 0 && g.shadow === 0 && g.rot === 0 && g.x === 0 && g.y === 0);
});

test('pieceAt: slide, develop, bleed, fold, late pieces', () => {
  const glue = 30;
  const sl = pieceAt(10 + 4 * F, piece('slide', 1), glue);
  assert.ok(sl.x > 0 && sl.x < 0.3);
  const sl2 = pieceAt(10 + 8 * F + EPS, piece('slide', 1), glue);
  assert.ok(Math.abs(sl2.x) <= JIT_XY && sl2.s === 1);
  const dv = pieceAt(11, piece('develop', 2), glue);
  assert.ok(dv.a > 0 && dv.a < 1);
  assert.equal(dv.ink, 1 - dv.a);
  assert.equal(dv.border, 0);
  assert.equal(pieceAt(12, piece('develop', 2), glue).a, 1);
  const bl = pieceAt(10.25, piece('bleed', 2), glue);
  assert.ok(bl.a > 0 && bl.a < 1 && bl.border === 0);
  assert.equal(pieceAt(10.5, piece('bleed', 2), glue).a, 1);
  const fo = pieceAt(10 + F, piece('fold', 1), glue);
  const sm = pieceAt(10 + F, piece('slam', 1), glue);
  assert.deepEqual(fo, sm);
  const late = pieceAt(40, piece('slam', 1, { t: 35 }), glue);
  assert.ok(late.border === 0 && late.shadow === 0 && late.rot === 0 && late.x === 0 && late.y === 0);
});

test('pieceAt: develop and bleed emerge in place, with no border and no shadow at any time', () => {
  const glue = 30;
  for (const style of ['develop', 'bleed']) {
    for (const t of [9.99, 10, 10 + F, 10.25, 11, 12, 20, glue - EPS, glue + 0.02, glue + 0.05 + EPS, 40]) {
      const r = pieceAt(t, piece(style, 2), glue);
      assert.equal(r.border, 0, `${style} border at ${t}`);
      assert.equal(r.shadow, 0, `${style} shadow at ${t}`);
    }
    // and they never move: no 12 fps jitter, no offset, no turn, no scale, at any time
    for (let k = 0; k <= 400; k++) {
      const t = 9.9 + k * 0.0773; // through many 12 fps ticks, past the glue
      const r = pieceAt(t, piece(style, 2), glue);
      assert.ok(r.x === 0 && r.y === 0 && r.rot === 0 && r.s === 1, `${style} at ${t}: ${JSON.stringify(r)}`);
    }
  }
  // the pasted styles keep theirs until the glue
  for (const style of ['slam', 'slide', 'fold']) {
    const r = pieceAt(20, piece(style, 2), glue);
    assert.equal(r.border, 1, `${style} border`);
    assert.equal(r.shadow, 1, `${style} shadow`);
  }
});

test('pieceAt: fx off takes the 12 fps jitter out, and only that; none while arriving, landing or glued', () => {
  const p = { leaf: 7, size: 2, t: 30, d: 0.1, note: 1, style: 'slam', from: [0.05, 0.03, 4, 1.15] };
  const glue = 41.5;
  const jit = (t) => {
    const a = pieceAt(t, p, glue);
    const b = pieceAt(t, p, glue, false);
    assert.ok(a.a === b.a && a.s === b.s && a.border === b.border && a.shadow === b.shadow && a.ink === b.ink, `t=${t}`);
    return { x: a.x - b.x, y: a.y - b.y, rot: a.rot - b.rot };
  };
  const j1 = jit(31);
  const j2 = jit(31.1);
  assert.ok(j1.x !== 0 || j1.y !== 0 || j1.rot !== 0);
  assert.ok(j1.x !== j2.x, 'another tick, another jitter');
  assert.ok(Math.abs(j1.x) <= JIT_XY && Math.abs(j1.rot) <= 0.15 + 1e-12);
  assert.deepEqual(pieceAt(31, p, glue, false), { ...pieceAt(31, p, glue, false), x: 0, y: 0, rot: 0 }, 'settled without fx: in place');
  assert.deepEqual(jit(29.9), { x: 0, y: 0, rot: 0 }, 'not arrived');
  assert.deepEqual(jit(30.01), { x: 0, y: 0, rot: 0 }, 'still landing');
  assert.deepEqual(jit(41.6), { x: 0, y: 0, rot: 0 }, 'glued');
});

test('filmStrength: full until the glue, then down to FILM_FLOOR by the end, held after', () => {
  const glue = 41.4952;
  const end = 44.87;
  assert.equal(FILM_FLOOR, 0.35);
  assert.equal(filmStrength(0, glue, end), 1);
  assert.equal(filmStrength(glue, glue, end), 1);
  const mid = filmStrength((glue + end) / 2, glue, end);
  assert.ok(mid < 1 && mid > FILM_FLOOR);
  assert.equal(filmStrength(end, glue, end), 0.35);
  assert.equal(filmStrength(47, glue, end), 0.35);
  let prev = 1;
  for (let t = glue; t <= end + 0.01; t += 0.05) {
    const f = filmStrength(t, glue, end);
    assert.ok(f <= prev + 1e-12);
    prev = f;
  }
});

// The glue chord (41.4952): the pieces open a little more for a breath before it, then are pressed
// flat on it (design 7, gate 2b).
test('looseAt: 1 until the breath, up to GLUE_OPEN on the chord, pressed to 0 within SETTLE', () => {
  const glue = 41.4952;
  assert.ok(GLUE_BREATH > 0 && GLUE_OPEN > 1 && SETTLE > 0);
  // the pieces are flat within 3 frames of the chord (global constraints)
  assert.ok(SETTLE <= 0.05 + 1e-12, `SETTLE ${SETTLE}`);
  assert.equal(looseAt(40, glue), 1);
  assert.equal(looseAt(glue - GLUE_BREATH, glue), 1);
  const rise = looseAt(glue - GLUE_BREATH / 2, glue);
  assert.ok(rise > 1 && rise < GLUE_OPEN, `${rise}`);
  assert.equal(looseAt(glue, glue), GLUE_OPEN);
  const fall = looseAt(glue + SETTLE / 2, glue);
  assert.ok(fall > 0 && fall < GLUE_OPEN, `${fall}`);
  assert.equal(looseAt(glue + SETTLE, glue), 0);
  assert.equal(looseAt(glue + 1, glue), 0);
  // up through the breath, down after the chord
  let prev = 1;
  for (let k = 1; k <= 20; k++) {
    const l = looseAt(glue - GLUE_BREATH + (k / 20) * GLUE_BREATH, glue);
    assert.ok(l >= prev, `rising at ${k}`);
    prev = l;
  }
  for (let k = 1; k <= 20; k++) {
    const l = looseAt(glue + (k / 20) * SETTLE, glue);
    assert.ok(l <= prev, `falling at ${k}`);
    prev = l;
  }
});

test('flashAt: FLASH on the chord, (1 - u)^2 down to 0 over FLASH_D, none before', () => {
  const glue = 41.4952;
  assert.ok(FLASH > 0 && FLASH < 1 && FLASH_D > 0);
  assert.equal(flashAt(40, glue), 0);
  assert.equal(flashAt(glue - 1e-6, glue), 0);
  assert.equal(flashAt(glue, glue), FLASH);
  assert.ok(Math.abs(flashAt(glue + FLASH_D / 2, glue) - FLASH * 0.25) < 1e-9);
  assert.equal(flashAt(glue + FLASH_D, glue), 0);
  assert.equal(flashAt(glue + 1, glue), 0);
});

test('the breath reaches the flats and the pasted pieces as it does the collage', () => {
  const glue = 41.4952;
  const tb = glue - GLUE_BREATH / 2;
  // a flat's offset: GLUE_OPEN times its offset on the chord, looseAt times it in the breath
  const fl = { leaf: 7, t: 3, note: 60 };
  const base = flatAt(30, fl, glue);
  assert.equal(flatAt(glue - GLUE_BREATH, fl, glue).dx, base.dx);
  for (const [t, k] of [[tb, looseAt(tb, glue)], [glue, GLUE_OPEN]]) {
    const r = flatAt(t, fl, glue);
    assert.ok(Math.abs(r.dx - base.dx * k) < 1e-15 && Math.abs(r.dy - base.dy * k) < 1e-15, `flat at ${t}`);
  }
  // a pasted piece: its border and shadow, and its 12 fps jitter (glue - GLUE_BREATH and the chord
  // are in one tick)
  const p = piece('slam', 2, { t: 30 });
  assert.equal(Math.floor((glue - GLUE_BREATH) * 12), Math.floor(glue * 12));
  const jit = (t) => {
    const on = pieceAt(t, p, glue);
    const off = pieceAt(t, p, glue, false);
    return [on.x - off.x, on.y - off.y, on.rot - off.rot];
  };
  const j1 = jit(glue - GLUE_BREATH);
  assert.ok(j1.some((v) => v !== 0));
  for (const [t, k] of [[tb, looseAt(tb, glue)], [glue, GLUE_OPEN]]) {
    const r = pieceAt(t, p, glue);
    assert.equal(r.border, k, `border at ${t}`);
    assert.equal(r.shadow, k, `shadow at ${t}`);
    jit(t).forEach((v, i) => assert.ok(Math.abs(v - j1[i] * k) <= 1e-12 * Math.max(1, Math.abs(j1[i])), `jitter ${i} at ${t}`));
  }
  assert.equal(pieceAt(glue - GLUE_BREATH, p, glue).border, 1);
  const flat = pieceAt(glue + SETTLE, p, glue);
  assert.ok(flat.border === 0 && flat.shadow === 0 && flat.x === 0 && flat.y === 0 && flat.rot === 0);
  // a piece that lands on the chord has none of it
  const onChord = pieceAt(glue, piece('slam', 2, { t: glue }), glue);
  assert.ok(onChord.border === 0 && onChord.shadow === 0);
});

const realScore = JSON.parse(readFileSync(new URL('../assets/score.json', import.meta.url), 'utf8'));

test('real score: a small push-in and a weak flash on the glue chord', () => {
  const sc = realScore;
  const glue = sc.glue;
  assert.ok(Math.abs(cameraAt(glue, sc.camera).zoom - 1.04) < 1e-9);
  assert.deepEqual([cameraAt(glue, sc.camera).cx, cameraAt(glue, sc.camera).cy], [0.5, 0.5]);
  const mid = cameraAt(glue + 0.15, sc.camera).zoom;
  assert.ok(mid > 1 && mid < 1.04, `${mid}`);
  assert.equal(cameraAt(glue + 0.3, sc.camera).zoom, 1);
  assert.deepEqual(cameraAt(glue + 0.3, sc.camera), cameraAt(41.4, sc.camera));
  assert.deepEqual(cameraAt(glue - 1e-6, sc.camera), cameraAt(41.4, sc.camera));
  // the punch-in of 34.08 is as it was
  assert.equal(cameraAt(34.0769, sc.camera).zoom, 1.6);
  assert.equal(frameState(glue, sc).flash, FLASH);
  assert.equal(frameState(41.0, sc).flash, 0);
  assert.equal(frameState(41.7, sc).flash, 0);
  // bound to the note, not a film effect: the same without fx
  for (const t of [41.0, glue - GLUE_BREATH / 2, glue, glue + SETTLE / 2, glue + 0.1, 41.7]) {
    const on = frameState(t, sc);
    const off = frameState(t, sc, { fx: false });
    assert.equal(off.flash, on.flash, `flash at ${t}`);
    assert.equal(off.collage.loose, on.collage.loose, `loose at ${t}`);
    assert.deepEqual(off.camera, on.camera, `camera at ${t}`);
  }
});

function synth() {
  return {
    glue: 30, end: 44.87,
    camera: [{ t: 0, zoom: 1, c: [0.5, 0.5] }, { t: 8, zoom: 2, c: [0.3, 0.4], hold: 1, ease: 0.5 }],
    washes: [0, 1, 2, 3].map((i) => ({ t: 5 + i * 8, d: 4, gain: 0.5, leaves: [i] })),
    strokes: [
      { s: 1, t: 1, d: 3, w: 0.5, ink: 0.2, note: 40, gen: 0, photo: false },
      { s: 2, t: 6, d: 2, w: 0.9, ink: 0.7, note: 43, gen: 1, photo: true },
    ],
    flats: [{ leaf: 1, t: 2, note: 60 }, { leaf: 2, t: 33, note: 62 }],
    pieces: [
      piece('slam', 2, { leaf: 1, t: 4 }),
      piece('develop', 1, { leaf: 2, t: 12 }),
      piece('slide', 3, { leaf: 3, t: 31 }),
    ],
  };
}

test('frameState layout', () => {
  const sc = synth();
  const f = frameState(6.5, sc);
  assert.equal(f.t, 6.5);
  assert.equal(f.tick12, 78);
  assert.equal(f.strokes.length, 8);
  assert.equal(f.flats.length, 8);
  assert.equal(f.pieces.length, 24);
  assert.equal(f.washes.length, 4);
  assert.ok(f.strokes instanceof Float32Array);
  assert.equal(f.strokes[4 + 3], 1);
  assert.equal(f.strokes[3], 0);
  assert.equal(f.camera.zoom, 1);
  assert.equal(f.plateToKey, 0);
  assert.ok(f.washSpread instanceof Float32Array);
  assert.equal(f.washSpread.length, 4);
  assert.equal(f.film, 1);
  assert.equal(f.weave.length, 2);
  assert.equal(f.flash, 0);
});

test('frameState: no collage in the score gives collage null', () => {
  assert.equal(frameState(25, synth()).collage, null);
});

test('frameState: film is filmStrength of t', () => {
  const sc = synth();
  for (const t of [0, 10, 29.99, 30, 31, 37.4, 44.87, 47, DUR, VIDEO_END]) {
    assert.equal(frameState(t, sc).film, filmStrength(t, sc.glue, sc.end), `t=${t}`);
  }
});

test('frameState: washSpread spreads each wash over 0.6 s from its own time', () => {
  const sc = synth();
  const w = sc.washes[1];
  const at = (t) => frameState(t, sc).washSpread[1];
  assert.equal(at(w.t - 0.01), 0);
  assert.equal(at(w.t), 0);
  assert.ok(Math.abs(at(w.t + 0.3) - 0.5) < 1e-6, `${at(w.t + 0.3)}`);
  assert.equal(at(w.t + 0.6), 1);
  assert.equal(at(w.t + 0.61), 1);
  assert.equal(at(w.t + 5), 1);
  // each wash from its own time
  const f = frameState(w.t + 0.3, sc);
  assert.equal(f.washSpread[0], 1);
  assert.equal(f.washSpread[2], 0);
});

test('frameState: gate weave, a hash of the 12 fps tick, at most WEAVE x film', () => {
  const sc = synth();
  assert.equal(WEAVE, 0.3 / 1080);
  let moved = 0;
  for (let k = 0; k < 100; k++) {
    const f = frameState(k * 0.5 + 0.01, sc); // 100 ticks through the whole piece, the glue and the end
    assert.ok(Math.abs(f.weave[0]) <= WEAVE * f.film && Math.abs(f.weave[1]) <= WEAVE * f.film, `t=${f.t}`);
    if (f.weave[0] !== 0 || f.weave[1] !== 0) moved++;
  }
  assert.ok(moved > 0);
  // two times in one tick (6.5 .. 6.5833), before the glue
  assert.deepEqual(frameState(6.51, sc).weave, frameState(6.58, sc).weave);
  assert.notDeepEqual(frameState(6.51, sc).weave, frameState(6.59, sc).weave);
});

test('frameState { fx: false }: nothing moves with the 12 fps tick; everything else is the same', () => {
  const sc = synth();
  // row 0: a slam piece landed at 4 + 2 frames, long before the glue (30); 6.5 and 7.25 are other ticks
  for (const t of [6.5, 7.25]) {
    const f = frameState(t, sc, { fx: false });
    assert.equal(f.tick12, 0);
    assert.deepEqual(f.weave, [0, 0]);
    assert.equal(f.pieces[0], 1);
    assert.ok(f.pieces[1] === 0 && f.pieces[2] === 0 && f.pieces[3] === 0, `t=${t}: ${[...f.pieces.subarray(0, 8)]}`);
  }
  let moved = 0;
  for (let k = 0; k < 100; k++) if (frameState(5 + k / 12 + 0.01, sc).pieces[1] !== 0) moved++;
  assert.ok(moved > 0, 'with fx (the default) the settled piece jitters');
  for (const t of [3, 4.01, 6.5, 12.3, 30.02, 33, 44.9]) {
    const on = frameState(t, sc);
    const off = frameState(t, sc, { fx: false });
    assert.deepEqual(frameState(t, sc, { fx: true }), on);
    // after the last note the signs of life keep the plate with fx and turn it into the key without
    // (test/timeline_tail.test.js)
    const same = ['t', 'camera', 'strokes', 'flats', 'washes', 'washSpread', 'film', 'flash', ...(t > sc.end ? [] : ['plateToKey'])];
    for (const k of same) {
      assert.deepEqual(off[k], on[k], `${k} at ${t}`);
    }
    for (let r = 0; r < sc.pieces.length; r++) {
      for (const c of [0, 4, 5, 6, 7]) assert.equal(off.pieces[r * 8 + c], on.pieces[r * 8 + c], `piece ${r}.${c} at ${t}`);
    }
  }
});

test('frameState is stateless: shuffled calls equal sorted calls', () => {
  // the seeded times of test/helpers.js (times()), called in their own order and then sorted
  assertStateless(synth(), {}, (f) => ({
    t: f.t, k: f.tick12, c: f.camera, s: [...f.strokes], f: [...f.flats],
    p: [...f.pieces], w: [...f.washes], pk: f.plateToKey,
    ws: [...f.washSpread], fm: f.film, wv: f.weave, fl: f.flash,
  }));
});

test('plateToKey (fx off, so no signs of life) reaches 1 after end + 0.3', () => {
  const sc = synth();
  assert.equal(frameState(44.87 + 0.3 + 0.01, sc, { fx: false }).plateToKey, 1);
  assert.equal(frameState(44.87, sc, { fx: false }).plateToKey, 0);
});

test('degenerate durations never give NaN: zero-length events are complete from their start', () => {
  const w = { t: 5, d: 0.4, gain: 0.8, leaves: [] };
  for (const d of [0, 0.2, 0.4]) {
    const ww = { ...w, d };
    for (const t of [4.999, 5, 5.2, 5.4 - 1e-9, 5.4, 5.4 + 1e-9, 6, 100]) {
      assert.ok(Number.isFinite(washAt(t, ww)), `wash d=${d} t=${t}`);
    }
    assert.ok(Math.abs(washAt(5.4, ww) - 0.8 * 0.12) < 1e-12);
  }
  const s = { t: 2, d: 0, w: 0.5, ink: 0.5 };
  assert.equal(strokeAt(1.999, s).p, 0);
  assert.equal(strokeAt(2, s).p, 1);
  assert.equal(strokeAt(3, s).p, 1);
  for (const style of ['develop', 'bleed', 'slam', 'slide', 'fold']) {
    for (const t of [9.999, 10, 10 + F, 10.5, 11]) {
      const r = pieceAt(t, piece(style, 0, { d: 0 }), 30);
      for (const v of Object.values(r)) assert.ok(Number.isFinite(v), `${style} t=${t}`);
    }
  }
  assert.equal(pieceAt(9.999, piece('develop', 0, { d: 0 }), 30).a, 0);
  assert.equal(pieceAt(10, piece('develop', 0, { d: 0 }), 30).a, 1);
});

test('frameState arrays are all finite with degenerate events', () => {
  const sc = synth();
  sc.washes = [0, 0.2, 0.4, 3].map((d, i) => ({ t: 5 + i, d, gain: 0.5, leaves: [i] }));
  sc.strokes = [{ s: 1, t: 2, d: 0, w: 0.5, ink: 0.2, note: 40, gen: 0, photo: false }];
  sc.pieces = ['develop', 'bleed', 'slam', 'slide', 'fold'].map((style, i) =>
    piece(style, 0, { leaf: i, t: 10, d: 0 }));
  const times = [0, 2, 2 - 1e-9, 5, 5.4, 6.2, 7.4, 8.4, 10, 10 + F, 30, 30.05, 44.87, 47, 99];
  for (const t of times) {
    const f = frameState(t, sc);
    for (const arr of [f.strokes, f.flats, f.pieces, f.washes, f.washSpread, f.weave]) {
      for (const v of arr) assert.ok(Number.isFinite(v), `t=${t}`);
    }
    assert.ok(Number.isFinite(f.plateToKey));
    assert.ok(Number.isFinite(f.film));
  }
});

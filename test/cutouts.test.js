import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameState } from '../src/timeline.js';
import {
  groupCutouts,
  pieceRowOfLeaf,
  strokeLeafRows,
  cutoutTexels,
  hideCoveredStrokes,
  hidePhotoFlats,
  foldPoint,
  smearWeight,
  tapeSpot,
  TAPE_MIN_SIZE,
  CUT_FLOATS,
  CUT_BORDER,
  CUT_FOLD,
  CUT_SMEAR,
  CUT_TAPE,
} from '../src/cutouts.js';
import { closedRibbon } from '../src/geometry.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const score = json('../assets/score.json');
const regions = json('../assets/regions.json');
const leafById = new Map(regions.leaves.map((l) => [l.id, l]));
const leafOf = (id) => leafById.get(id);

// a piece event for the synthetic tests
const ev = (leaf, t, note, size, extra = {}) => ({ leaf, size, t, d: 0.1, note, style: 'slam', from: [0.01, -0.02, 3, 1.1], ...extra });
const fakeLeaves = new Map([
  [1, { id: 1, area: 0.3, c: [0.2, 0.4] }],
  [2, { id: 2, area: 0.1, c: [0.6, 0.8] }],
  [3, { id: 3, area: 0.02, c: [0.9, 0.1] }],
  [4, { id: 4, area: 0.05, c: [0.5, 0.5] }],
  [5, { id: 5, area: 0.01, c: [0.3, 0.3] }],
]);

test('groupCutouts: rows sharing t and note are one cut-out, its pivot the area-weighted centre', () => {
  const pieces = [ev(1, 30, 10, 3), ev(2, 30, 10, 2), ev(3, 30, 11, 1), ev(4, 31, 12, 3)];
  const cuts = groupCutouts(pieces, (id) => fakeLeaves.get(id));
  assert.equal(cuts.length, 3);
  const a = cuts.find((c) => c.note === 10);
  assert.deepEqual(a.rows, [0, 1]);
  assert.deepEqual(a.leaves, [1, 2]);
  assert.equal(a.size, 3);
  assert.equal(a.style, 'slam');
  assert.ok(Math.abs(a.pivot[0] - (0.3 * 0.2 + 0.1 * 0.6) / 0.4) < 1e-12);
  assert.ok(Math.abs(a.pivot[1] - (0.3 * 0.4 + 0.1 * 0.8) / 0.4) < 1e-12);
  assert.equal(a.rep, 0, 'the transform comes from the largest leaf');
  const b = cuts.find((c) => c.note === 11);
  assert.deepEqual(b.rows, [2]);
  assert.ok(Math.abs(b.pivot[0] - 0.9) < 1e-12 && Math.abs(b.pivot[1] - 0.1) < 1e-12, 'one leaf: its own centre');
});

test('groupCutouts: draw order is large first (size of the largest leaf), then by time, then note', () => {
  const pieces = [ev(5, 30, 1, 1), ev(3, 30.5, 2, 1), ev(1, 31, 3, 3), ev(2, 32, 4, 2), ev(4, 30.5, 5, 1)];
  const cuts = groupCutouts(pieces, (id) => fakeLeaves.get(id));
  assert.deepEqual(cuts.map((c) => c.note), [3, 4, 1, 2, 5]);
});

test('groupCutouts: the representative row is the largest leaf by size, then area', () => {
  const pieces = [ev(3, 30, 1, 2), ev(4, 30, 1, 2), ev(5, 30, 1, 1)];
  const cuts = groupCutouts(pieces, (id) => fakeLeaves.get(id));
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].rep, 1, 'leaf 4 (size 2, area 0.05) beats leaf 3 (size 2, area 0.02)');
});

test('groupCutouts: the real score has 87 cut-outs, every row in exactly one, one style and from each', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  assert.equal(cuts.length, 87);
  const seen = new Set();
  for (const c of cuts) {
    for (const r of c.rows) {
      assert.ok(!seen.has(r), `row ${r} twice`);
      seen.add(r);
      const p = score.pieces[r];
      assert.equal(p.t, c.t);
      assert.equal(p.note, c.note);
      assert.equal(p.style, c.style);
      assert.deepEqual(p.from, score.pieces[c.rep].from);
    }
    assert.ok(c.rows.includes(c.rep));
    assert.ok(c.pivot.every((v) => v >= 0 && v <= 1));
  }
  assert.equal(seen.size, score.pieces.length);
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1];
    const b = cuts[i];
    assert.ok(a.size > b.size || (a.size === b.size && (a.t < b.t || (a.t === b.t && a.note < b.note))), `order at ${i}`);
  }
});

test('groupCutouts: the hinge is the lower edge of the box round its leaves\' bboxes; null without a bbox', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  const c = cuts.find((x) => x.leaves.some((id) => leafOf(id).name === 'red_block_left'));
  const boxes = c.leaves.map((id) => leafOf(id).bbox);
  assert.ok(boxes.length > 1, 'the windows ride with the block');
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const x1 = Math.max(...boxes.map((b) => b[2]));
  const y = Math.max(...boxes.map((b) => b[3]));
  assert.deepEqual(c.hinge, [x0, y, x1, y]);
  for (const cut of cuts) assert.ok(Array.isArray(cut.hinge) && cut.hinge.length === 4, `cut-out ${cut.note}`);
  // the synthetic leaves have no bbox
  const fake = groupCutouts([ev(1, 30, 10, 3), ev(2, 30, 10, 2)], (id) => fakeLeaves.get(id));
  assert.equal(fake[0].hinge, null);
  const half = new Map([[1, { ...fakeLeaves.get(1), bbox: [0.1, 0.2, 0.3, 0.6] }], [2, fakeLeaves.get(2)]]);
  assert.equal(groupCutouts([ev(1, 30, 10, 3), ev(2, 30, 10, 2)], (id) => half.get(id))[0].hinge, null, 'one leaf without');
});

test('foldPoint: in place at 0 degrees, flat on the hinge at 90, the hinge itself never moves', () => {
  const hinge = [0, 100, 200, 100];
  const dist = 4120;
  assert.deepEqual(foldPoint([50, 40], hinge, 0, dist), [50, 40]);
  const up = foldPoint([50, 40], hinge, 90, dist);
  assert.ok(Math.abs(up[1] - 100) < 1e-9, `${up}`);
  assert.ok(Math.abs(up[0] - 49.26) < 0.01, `${up}`);
  const half = foldPoint([50, 40], hinge, 45, dist);
  assert.ok(half[1] > 57.0 && half[1] < 57.3, `${half}`);
  for (const deg of [-5, 0, 10, 45, 78, 90]) assert.deepEqual(foldPoint([30, 100], hinge, deg, dist), [30, 100], `${deg}`);
  let prev = 40;
  for (const deg of [10, 20, 30, 45, 60, 78, 90]) {
    const y = foldPoint([50, 40], hinge, deg, dist)[1];
    assert.ok(y > prev && y <= 100 + 1e-9, `${deg}: ${y}`);
    prev = y;
  }
  // lying toward the eye, the far edge is nearer and wider: a trapezoid wider at the top
  const left = foldPoint([0, 40], hinge, 78, dist);
  const right = foldPoint([200, 40], hinge, 78, dist);
  assert.ok(right[0] - left[0] > 200, `${left} ${right}`);
});

test('smearWeight: 0 at the leading edge, 1 at the trailing edge, even in between; 0 without a smear', () => {
  // the smear points back to where the cut-out was (-x): the trailing edge is at -radius
  assert.equal(smearWeight([10, 0], [-4, 0], 20), 0.25);
  assert.equal(smearWeight([-20, 0], [-4, 0], 20), 1);
  assert.equal(smearWeight([20, 0], [-4, 0], 20), 0);
  assert.equal(smearWeight([5, 5], [0, 0], 20), 0);
  assert.equal(smearWeight([0, 7], [-4, 0], 20), 0.5, 'across the smear: half');
  assert.equal(smearWeight([10, 0], [-40, 0], 20), 0.25, 'by the smear\'s direction, not its length');
  assert.equal(smearWeight([-30, 0], [-4, 0], 20), 1, 'clamped beyond the radius');
});

// a square leaf [0.3, 0.3]-[0.5, 0.5], as regions.json has it (bbox, polys), and the picture's size
const pic = { w: regions.w, h: regions.h };
const square = { id: 7, area: 0.04, c: [0.4, 0.4], bbox: [0.3, 0.3, 0.5, 0.5], polys: [[[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5]]] };
const oneLeaf = (leaf, note, size, extra = {}) => groupCutouts([ev(leaf.id, 30, note, size, extra)], (id) => (id === leaf.id ? leaf : undefined))[0];

test('tapeSpot: a top corner of the representative leaf, left for an even note, right for an odd one; its angle', () => {
  assert.equal(TAPE_MIN_SIZE, 3);
  assert.deepEqual(tapeSpot(oneLeaf(square, 4, 3), (id) => square, pic), { p: [0.3, 0.3], deg: -31 });
  assert.deepEqual(tapeSpot(oneLeaf(square, 5, 3), (id) => square, pic), { p: [0.5, 0.3], deg: 55 });
  // deg = (-40 left, 40 right) + (note x 37) % 31 - 15: within 15 of 40 either way
  for (let note = 0; note < 62; note++) {
    const { deg } = tapeSpot(oneLeaf(square, note, 3), (id) => square, pic);
    assert.equal(deg, (note % 2 ? 40 : -40) + ((note * 37) % 31) - 15, `note ${note}`);
    assert.ok(Math.abs(Math.abs(deg) - 40) <= 15, `note ${note}: ${deg}`);
  }
  // slide and fold cut-outs have one too
  for (const style of ['slide', 'fold']) assert.deepEqual(tapeSpot(oneLeaf(square, 4, 3, { style }), (id) => square, pic).p, [0.3, 0.3], style);
});

test('tapeSpot: null for a small cut-out, a develop or bleed one, and a leaf whose outline is all within 0.02 of the edges', () => {
  assert.equal(tapeSpot(oneLeaf(square, 4, 2), (id) => square, pic), null, 'size 2');
  assert.equal(tapeSpot(oneLeaf(square, 4, 3, { style: 'develop' }), (id) => square, pic), null, 'develop');
  assert.equal(tapeSpot(oneLeaf(square, 4, 3, { style: 'bleed' }), (id) => square, pic), null, 'bleed');
  const edge = { ...square, bbox: [0.01, 0.01, 0.99, 0.99], polys: [[[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]]] };
  assert.equal(tapeSpot(oneLeaf(edge, 4, 3), (id) => edge, pic), null, 'every outline point within 0.02 of an edge');
  // the bounds are inclusive: an outline point on 0.02 counts
  const onIt = { ...edge, polys: [[[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.02, 0.98]]] };
  assert.deepEqual(tapeSpot(oneLeaf(onIt, 4, 3), (id) => onIt, pic).p, [0.02, 0.98]);
});

test('tapeSpot: the outline point nearest the corner, measured in picture px (not 0..1)', () => {
  // no point at the corner (0.3, 0.3): (0.35, 0.3) is nearer in 0..1 (0.05 against 0.06), (0.3, 0.36)
  // in picture px (0.06 x 1648 = 99 against 0.05 x 2944 = 147)
  const notched = { ...square, polys: [[[0.35, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.36]]] };
  assert.deepEqual(tapeSpot(oneLeaf(notched, 4, 3), (id) => notched, pic).p, [0.3, 0.36]);
  // every ring counts
  const rings = { ...square, polys: [[[0.5, 0.3], [0.5, 0.5], [0.3, 0.5]], [[0.31, 0.31], [0.32, 0.31], [0.31, 0.32]]] };
  assert.deepEqual(tapeSpot(oneLeaf(rings, 4, 3), (id) => rings, pic).p, [0.31, 0.31]);
  // the representative leaf decides (the largest; not the cut-out's other leaves)
  const other = { id: 8, area: 0.001, c: [0.1, 0.1], bbox: [0.05, 0.05, 0.15, 0.15], polys: [[[0.05, 0.05], [0.15, 0.05], [0.15, 0.15]]] };
  const leaves = new Map([[7, square], [8, other]]);
  const two = groupCutouts([ev(7, 30, 4, 3), ev(8, 30, 4, 1)], (id) => leaves.get(id))[0];
  assert.deepEqual(tapeSpot(two, (id) => leaves.get(id), pic).p, [0.3, 0.3]);
});

test('tapeSpot: in the committed score 14 to 18 cut-outs get a tape, every one large and pasted, its spot on its outline', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  const taped = cuts.filter((c) => tapeSpot(c, leafOf, pic));
  assert.ok(taped.length >= 14 && taped.length <= 18, `${taped.length} tapes`);
  for (const c of taped) {
    assert.ok(c.size >= TAPE_MIN_SIZE && ['slam', 'slide', 'fold'].includes(c.style), `cut-out ${c.note}`);
    const { p } = tapeSpot(c, leafOf, pic);
    const rep = leafOf(score.pieces[c.rep].leaf);
    assert.ok(rep.polys.some((ring) => ring.some(([x, y]) => x === p[0] && y === p[1])), `cut-out ${c.note}: p is a point of its outline`);
  }
});

test('pieceRowOfLeaf: one row per leaf of the picture', () => {
  const m = pieceRowOfLeaf(score.pieces);
  assert.equal(m.size, regions.leaves.length);
  for (const l of regions.leaves) assert.equal(score.pieces[m.get(l.id)].leaf, l.id);
});

// floats k*12 .. k*12+11 of a cut-out (three texels):
//   (s cos - 1, s sin, x, y), (border, shadow, cos, sin), (fold, smx, smy, tape)
// in place, the first eleven (the tape is a state of its own: the border hides it)
const IDENTITY = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
const texelOf = (tx, k) => Array.from(tx.subarray(k * 12, k * 12 + 12));

test('cutoutTexels: three texels per cut-out, the fold first in the third, then the smear\'s two and the tape\'s one', () => {
  assert.equal(CUT_FLOATS, 12);
  assert.equal(CUT_BORDER, 4, 'the second texel x');
  // the border is the representative row's (the pieces' sixth float)
  const pieces = [ev(1, 30, 10, 3)];
  const st = { pieces: new Float32Array([1, 0, 0, 0, 1, 0.75, 0.5, 0]), fold: [0], smear: [0, 0], tape: [0] };
  assert.equal(cutoutTexels(groupCutouts(pieces, (id) => fakeLeaves.get(id)), st)[CUT_BORDER], 0.75);
  assert.equal(CUT_FOLD, 8);
  assert.equal(CUT_SMEAR, 9, 'Task 4: the third texel y and z');
  assert.equal(CUT_TAPE, 11, 'Task 6: the third texel w');
  assert.equal(CUT_TAPE - CUT_SMEAR, 2, 'the smear has two floats');
});

test('cutoutTexels: every cut-out is exactly in place at 44.9 (fx on and off), its tape its representative row\'s', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  assert.equal(cuts.length, 87);
  for (const fx of [true, false]) {
    const st = frameState(44.9, score, { fx });
    const tx = cutoutTexels(cuts, st);
    assert.equal(tx.length, cuts.length * 12);
    cuts.forEach((c, k) => {
      const v = texelOf(tx, k);
      assert.deepEqual(v.slice(0, 11), IDENTITY, `cut-out ${c.note} fx ${fx}`);
      // the tape may be on (1) at 44.9; the border is 0, so it is not seen
      assert.equal(v[11], st.tape[c.rep], `cut-out ${c.note} fx ${fx}: tape`);
    });
  }
});

test('cutoutTexels: the third texel is (fold, smx, smy, tape) of the cut-out\'s representative row', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  const st = frameState(37.85, score);
  const tx = cutoutTexels(cuts, st);
  let folding = 0;
  let taped = 0;
  cuts.forEach((c, k) => {
    const v = texelOf(tx, k);
    // nothing smears at 37.85
    assert.deepEqual(v.slice(8), [st.fold[c.rep], 0, 0, st.tape[c.rep]], `cut-out ${c.note}`);
    if (v[8] !== 0) {
      folding++;
      assert.deepEqual(v.slice(0, 4), [0, 0, 0, 0], `cut-out ${c.note} stands up in place`);
      assert.equal(v[CUT_TAPE], 0, `cut-out ${c.note}: no tape while it folds`);
    }
    if (v[CUT_TAPE] === 1) taped++;
  });
  assert.equal(folding, 3);
  assert.ok(taped >= 12, `the pasted cut-outs landed before have their tape (${taped})`);
});

test('cutoutTexels: before the glue, settled cut-outs jitter with fx and sit still in place without', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  const t1 = 38.0;
  const t2 = 38.1; // another tick12
  const settled = cuts.map((c, k) => [c, k]).filter(([c]) => c.t < t1 - 0.5 && c.style !== 'develop');
  assert.ok(settled.length > 10);
  const a0 = cutoutTexels(cuts, frameState(t1, score, { fx: false }));
  const b0 = cutoutTexels(cuts, frameState(t2, score, { fx: false }));
  const a1 = cutoutTexels(cuts, frameState(t1, score));
  // it reads the pieces, fold, smear and tape state and nothing else
  const st1 = frameState(t1, score);
  assert.deepEqual(cutoutTexels(cuts, { pieces: st1.pieces, fold: st1.fold, smear: st1.smear, tape: st1.tape }), a1);
  let moved = 0;
  for (const [c, k] of settled) {
    const v = texelOf(a0, k);
    assert.deepEqual(v.slice(0, 4), [0, 0, 0, 0], `cut-out ${c.note} at rest without fx`);
    assert.deepEqual(v.slice(6, 11), [1, 0, 0, 0, 0]);
    assert.equal(v[11], st1.tape[c.rep], 'tape');
    assert.equal(v[4], 1, 'border');
    assert.equal(v[5], 1, 'shadow');
    assert.deepEqual(texelOf(b0, k), v, 'the same in the next tick');
    if (texelOf(a1, k).slice(0, 4).some((x) => x !== 0)) moved++;
  }
  assert.equal(moved, settled.length, 'with fx every settled cut-out jitters');
});

test('cutoutTexels: a cut-out arriving is scaled and rotated about its pivot by the timeline values', () => {
  const cuts = groupCutouts(score.pieces, leafOf);
  const k = cuts.findIndex((c) => c.note === 173); // the white room, 34.0788
  const c = cuts[k];
  const st = frameState(c.t + 0.004, score);
  const row = st.pieces.subarray(c.rep * 8, c.rep * 8 + 8);
  const v = texelOf(cutoutTexels(cuts, st), k);
  const rad = (row[3] * Math.PI) / 180;
  assert.ok(Math.abs(v[0] - (row[4] * Math.cos(rad) - 1)) < 1e-6);
  assert.ok(Math.abs(v[1] - row[4] * Math.sin(rad)) < 1e-6);
  assert.ok(Math.abs(v[2] - row[1]) < 1e-7 && Math.abs(v[3] - row[2]) < 1e-7);
  assert.ok(Math.abs(v[0]) > 0.01, 'still overshooting');
});

test('hideCoveredStrokes: a pencil stroke goes once all its leaves are photo; wires stay', () => {
  // three strokes: on leaf rows [0], on rows [0, 1], a wire
  const strokes = new Float32Array([0.5, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1]);
  const rows = [[0], [0, 1], null];
  const pieces = new Float32Array(2 * 8);
  pieces[0] = 1; // row 0: a = 1
  pieces[8] = 0.4; // row 1: a = 0.4 (developing)
  const out = hideCoveredStrokes(strokes, rows, pieces);
  assert.deepEqual(Array.from(out), [0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1]);
  assert.equal(strokes[0], 0.5, 'input untouched');
  pieces[8] = 1;
  assert.deepEqual(Array.from(hideCoveredStrokes(strokes, rows, pieces)), [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
  // a row whose cut-out is still folding (fold not 0) does not cover yet, though its a is 1
  const fold = new Float32Array([0, 23.8]);
  assert.deepEqual(Array.from(hideCoveredStrokes(strokes, rows, pieces, fold)), [0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1]);
  fold[1] = 0;
  assert.deepEqual(Array.from(hideCoveredStrokes(strokes, rows, pieces, fold)), [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
});

test('hideCoveredStrokes: at 44.9 no pencil or ink stroke is left, every wire is', () => {
  const strokes = json('../assets/strokes.json').strokes;
  const byId = new Map(strokes.map((s) => [s.id, s]));
  const rows = strokeLeafRows(score.strokes, byId, pieceRowOfLeaf(score.pieces));
  const st = frameState(44.9, score);
  const out = hideCoveredStrokes(st.strokes, rows, st.pieces);
  score.strokes.forEach((e, i) => assert.equal(out[i * 4], e.photo ? 1 : 0, `stroke ${e.s}`));
});

test('strokeLeafRows: null for a wire or a missing stroke, the piece rows of leaf and leaf2 otherwise', () => {
  const rowOfLeaf = new Map([[5, 0], [6, 1]]);
  const byId = new Map([
    [1, { id: 1, leaf: 5 }],
    [2, { id: 2, leaf: 5, leaf2: 6 }],
    [3, { id: 3, leaf: 9 }],
    [4, { id: 4, leaf: 5 }],
  ]);
  const events = [{ s: 1 }, { s: 2 }, { s: 3 }, { s: 4, photo: 1 }, { s: 99 }];
  assert.deepEqual(strokeLeafRows(events, byId, rowOfLeaf), [[0], [0, 1], [], null, null]);
});

test('hidePhotoFlats: a flat goes once its piece is photo (a = 1, ink = 0)', () => {
  const flats = new Float32Array([1, 0.001, 0.002, 1, 1, -0.001, 0.001, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const flatRows = [0, 1, 2, -1];
  const pieces = new Float32Array(3 * 8);
  pieces.set([1, 0, 0, 0, 1, 1, 1, 0], 0); // photo
  pieces.set([1, 0, 0, 0, 1, 1, 1, 1], 8); // still ink
  pieces.set([0.5, 0, 0, 0, 1, 0, 1, 0.5], 16); // developing
  const out = hidePhotoFlats(flats, flatRows, pieces);
  assert.deepEqual(Array.from(out.filter((_, i) => i % 4 === 0)), [0, 1, 1, 1]);
  assert.equal(out[5], flats[5], 'the other values are kept');
  assert.equal(flats[0], 1, 'input untouched');
});

test('closedRibbon: a closed ring gets mitred corners all round', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const r = closedRibbon(ring);
  // the ring's points, plus the last point before and the first after (butt ends overlapping)
  assert.equal(r.u.length, (ring.length + 2) * 2);
  for (let i = 1; i <= ring.length; i++) {
    const nx = r.normal[i * 4];
    const ny = r.normal[i * 4 + 1];
    assert.ok(Math.abs(Math.hypot(nx, ny) - Math.SQRT2) < 1e-6, `corner ${i - 1} is mitred`);
    assert.equal(r.position[i * 4], ring[i - 1][0]);
    assert.equal(r.position[i * 4 + 1], ring[i - 1][1]);
  }
  // the points it used, one per pair of vertices
  assert.deepEqual(r.points, [ring[3], ...ring, ring[0]]);
  // a ring that repeats its first point at the end gives the same ribbon and points
  const again = closedRibbon([...ring, [0, 0]]);
  assert.deepEqual(Array.from(again.normal), Array.from(r.normal));
  assert.deepEqual(again.points, r.points);
});

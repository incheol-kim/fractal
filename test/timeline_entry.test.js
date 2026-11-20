// How the photo pieces enter (design 7 and 8): the fold of the 37.81 chord, where the three colour
// blocks stand up about their lower edge like a pop-up book (timeline.js foldAngle, pieceAt's fold),
// in front of the wrong fragments under them, which they cover (collageLeafAt's fold); the smear
// frames, where a large piece sliding or slamming in is drawn stretched back to where it was a frame
// ago (pieceAt's smx, smy); and the masking tape put on once a piece has landed (pieceAt's tape).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAngle, pieceAt, frameState, foldingLeaves, cutoutFolds, FOLD_D, SMEAR, SMEAR_MIN_SIZE } from '../src/timeline.js';
import { groupCutouts, strokeLeafRows, pieceRowOfLeaf, hideCoveredStrokes, cutoutTexels, CUT_FLOATS, CUT_FOLD, CUT_SMEAR, CUT_TAPE } from '../src/cutouts.js';
import { realScore, realRegions, assertStateless } from './helpers.js';

const glue = 41.4952;
// a large fold piece, landing at 37.8
const fold = { leaf: 28, size: 3, t: 37.8, d: 0.1, note: 1, style: 'fold', from: [0.05, 0.02, 4, 1.15] };
const FRAMES = Math.round(FOLD_D * 60);

test('foldAngle: rises from 78 as 1 - u^2 in 6 frames and snaps upright', () => {
  assert.equal(FRAMES, 6);
  assert.equal(foldAngle(0), 78);
  assert.ok(Math.abs(foldAngle(3 / 60) - 58.5) < 1e-9, `${foldAngle(3 / 60)}`);
  assert.equal(foldAngle(6 / 60), 0);
  assert.equal(foldAngle(1), 0);
  // it never goes past upright, and only falls
  const a = [0, 1, 2, 3, 4, 5].map((k) => foldAngle(k / 60));
  for (let k = 1; k < a.length; k++) assert.ok(a[k] < a[k - 1] && a[k] > 0, `frame ${k}: ${a}`);
});

test('pieceAt: a large fold piece stands up in place, 0 before it lands, the jitter only once it is up', () => {
  const before = pieceAt(37.79, fold, glue);
  assert.equal(before.a, 0);
  assert.equal(before.fold, 0);
  const on = pieceAt(37.8, fold, glue);
  assert.equal(on.a, 1);
  assert.equal(on.ink, 1);
  assert.ok(on.x === 0 && on.y === 0 && on.rot === 0 && on.s === 1, JSON.stringify(on));
  assert.equal(on.fold, 78);
  for (const t of [37.8 + 6 / 60, 37.8 + 7 / 60, 38.5]) assert.equal(pieceAt(t, fold, glue).fold, 0, `t=${t}`);
  // while it folds it does not move, even with fx on (the 12 fps jitter starts at t + FOLD_D)
  for (let k = 0; k < FRAMES; k++) {
    const t = 37.8 + k / 60;
    const r = pieceAt(t, fold, glue, true);
    assert.ok(r.x === 0 && r.y === 0 && r.rot === 0 && r.s === 1, `frame ${k}: ${JSON.stringify(r)}`);
    assert.equal(r.fold, foldAngle(t - fold.t), `frame ${k}`);
    assert.notEqual(r.fold, 0, `frame ${k} is still folding`);
  }
  // settled and before the glue: the jitter as every pasted piece has it
  const later = pieceAt(38.5, fold, glue);
  assert.ok(later.x !== 0 || later.y !== 0 || later.rot !== 0, 'jitters once up');
});

test('pieceAt: a fold piece whose cut-out does not fold is in every value the same piece as a slam; a small one never folds', () => {
  // the tape's edge (the slam's 2 frames and one) on either side, too
  const at = [37.79, 37.8, 37.8 + 1 / 60, 37.8 + 2 / 60, 37.8 + 2.5 / 60, 37.8 + 3 / 60 + 1e-9, 38.5];
  for (const fx of [true, false]) {
    // folds false: a large fold piece in a cut-out that does not fold (a mixed one, cutoutFolds)
    for (const t of at) {
      assert.deepEqual(pieceAt(t, fold, glue, fx, false), pieceAt(t, { ...fold, style: 'slam' }, glue, fx), `t=${t} fx ${fx}`);
    }
    const small = { ...fold, size: 2 };
    for (const t of at) {
      assert.deepEqual(pieceAt(t, small, glue, fx), pieceAt(t, { ...small, style: 'slam' }, glue, fx), `size 2 t=${t} fx ${fx}`);
    }
  }
  assert.equal(pieceAt(37.8, { ...fold, style: 'slam' }, glue).fold, 0, 'a slam never folds');
  assert.equal(pieceAt(37.8 + 3 / 60 + 1e-9, fold, glue, true, false).tape, 1, 'not folding: taped as a slam is');
});

// the committed score's cut-outs; names(c): the names of a cut-out's leaves
function committed() {
  const score = realScore();
  const regions = realRegions();
  const leafById = new Map(regions.leaves.map((l) => [l.id, l]));
  const cuts = groupCutouts(score.pieces, (id) => leafById.get(id));
  const names = (c) => c.leaves.map((id) => leafById.get(id).name);
  return { score, cuts, names };
}

// the committed score's cut-outs and the three that fold
function folding() {
  const { score, cuts, names } = committed();
  const blocks = cuts.filter((c) => ['red_block_left', 'red_block_top', 'blue_block'].some((n) => names(c).includes(n)));
  return { score, cuts, blocks, names };
}

test('the committed score: the three colour blocks fold on the 37.81 chord, nothing else, nothing at 44.9', () => {
  const { score, cuts, blocks } = folding();
  assert.equal(blocks.length, 3);
  const st = frameState(37.85, score);
  assert.ok(st.fold instanceof Float32Array && st.fold.length === score.pieces.length);
  assert.deepEqual(cuts.filter((c) => st.fold[c.rep] !== 0), blocks);
  assert.ok(frameState(44.9, score).fold.every((x) => x === 0), '44.9');
  assertStateless(score, {}, (s) => [...s.fold]);
});

test('cutoutFolds: one rule for a cut-out, every row a fold piece and the largest FOLD_MIN_SIZE or more', () => {
  const p = (style, size, extra = {}) => ({ ...fold, style, size, ...extra });
  assert.equal(cutoutFolds([p('fold', 3)]), true);
  assert.equal(cutoutFolds([p('fold', 2)]), false);
  assert.equal(cutoutFolds([p('fold', 3), p('fold', 0)]), true, 'small rows ride with the large one');
  assert.equal(cutoutFolds([p('fold', 3), p('slam', 4)]), false, 'a mixed cut-out does not fold');
  assert.equal(cutoutFolds([p('fold', 2), p('slam', 4)]), false);
  assert.equal(cutoutFolds([]), false);
  // frameState: every row of a folding cut-out has its angle, no row of a mixed one has any; the
  // fragments and the pieces follow the same rule (foldingLeaves)
  const synth = (pieces) => ({ glue: 41.5, end: 44.87, camera: [{ t: 0, zoom: 1, c: [0.5, 0.5] }], washes: [], strokes: [], flats: [], pieces });
  const together = synth([p('fold', 3, { leaf: 1 }), p('fold', 0, { leaf: 2 }), p('fold', 2, { leaf: 3, note: 2 })]);
  const st = frameState(37.8 + 2 / 60, together);
  const angle = foldAngle(37.8 + 2 / 60 - 37.8); // as pieceAt takes it: t - ev.t
  assert.ok(angle > 0);
  assert.deepEqual([...st.fold], [angle, angle, 0].map(Math.fround));
  assert.deepEqual([...foldingLeaves(together.pieces)], [1, 2]);
  const mixed = synth([p('fold', 3, { leaf: 1 }), p('slam', 4, { leaf: 2 })]);
  assert.deepEqual([...frameState(37.8 + 2 / 60, mixed).fold], [0, 0]);
  assert.equal(foldingLeaves(mixed.pieces).size, 0);
});

test('the committed score: the pencil lines on a folding block stay until its panel is up', () => {
  const { score, blocks } = folding();
  const strokes = JSON.parse(readFileSync(new URL('../assets/strokes.json', import.meta.url), 'utf8')).strokes;
  const leafRows = strokeLeafRows(score.strokes, new Map(strokes.map((s) => [s.id, s])), pieceRowOfLeaf(score.pieces));
  const shownAt = (st) => hideCoveredStrokes(st.strokes, leafRows, st.pieces, st.fold);
  const blockRows = new Set(blocks.flatMap((c) => c.rows));
  // the picture without the fold: the three blocks' rows as slams (a fold piece that does not fold is one)
  const slammed = { ...score, pieces: score.pieces.map((p, r) => (blockRows.has(r) ? { ...p, style: 'slam' } : p)) };
  const first = Math.min(...blocks.map((c) => c.t));
  const last = Math.max(...blocks.map((c) => c.t));
  // the pencil and ink strokes on a leaf of the three blocks that are drawn the frame before the chord
  const before = shownAt(frameState(first - 1 / 60, score));
  const watched = [];
  leafRows.forEach((rows, i) => {
    if (rows && rows.some((r) => blockRows.has(r)) && before[i * 4] > 0) watched.push({ i, rows });
  });
  assert.ok(watched.length > 200, `${watched.length} strokes`);
  let hiddenOnceUp = 0;
  for (let k = 0; first + k / 60 <= last + FOLD_D + 2 / 60; k++) {
    const t = first + k / 60;
    const st = frameState(t, score);
    const shown = shownAt(st);
    // as it would be without the fold
    const unfolded = shownAt(frameState(t, slammed));
    for (const { i, rows } of watched) {
      if (rows.some((r) => st.fold[r] !== 0)) {
        assert.ok(shown[i * 4] > 0, `stroke ${score.strokes[i].s} hidden at frame ${k} while its panel folds`);
      } else {
        assert.equal(shown[i * 4], unfolded[i * 4], `stroke ${score.strokes[i].s} at frame ${k}, its panel up`);
        if (k > 0 && shown[i * 4] === 0) hiddenOnceUp++;
      }
    }
  }
  assert.ok(hiddenOnceUp > 0, 'the lines go once the panels are up');
});

test('foldingLeaves: the leaves of the three folding cut-outs, every leaf of each', () => {
  const { score, blocks } = folding();
  const want = blocks.flatMap((c) => c.leaves).sort((x, y) => x - y);
  assert.deepEqual([...foldingLeaves(score.pieces)].sort((x, y) => x - y), want);
  assert.equal(want.length, 12);
});

test('the committed score: under a folding block the wrong fragment is not torn off; the panel covers it and it goes when the panel is up', () => {
  const { score, blocks } = folding();
  const col = score.collage;
  // the collage rows under the three blocks, each with its cut-out
  const rows = [];
  col.leaves.forEach((r, i) => {
    const c = blocks.find((b) => b.leaves.includes(r.leaf));
    if (c) rows.push({ i, r, c });
  });
  assert.equal(rows.length, 9);
  assert.ok(rows.every(({ r }) => r.tear), 'all of them are torn off without the fold');
  const share = 1 / 60 / FOLD_D; // the most the rim may fall in one frame
  for (const { i, r, c } of rows) {
    const what = `leaf ${r.leaf}`;
    assert.equal(frameState(c.t - 1 / 60, score).collage.rim[i], 1, `${what}: rim before the note`);
    let prev = 1;
    let up = false;
    for (let k = 0; k / 60 <= 0.3 + 1e-9; k++) {
      const t = c.t + k / 60;
      const st = frameState(t, score);
      const s = st.collage;
      assert.equal(s.tear[i], 0, `${what}: tear at frame ${k}`);
      const f = st.fold[c.rep];
      if (f !== 0) {
        assert.ok(!up, `${what}: folding again at frame ${k}`);
        assert.equal(s.leaves[i * 4], 1, `${what}: drawn while the panel folds (frame ${k})`);
      } else {
        up = true;
        assert.equal(s.leaves[i * 4], 0, `${what}: gone once the panel is up (frame ${k})`);
      }
      const rim = s.rim[i];
      assert.ok(rim <= prev && prev - rim <= share + 1e-6, `${what}: rim ${prev} -> ${rim} at frame ${k}`);
      prev = rim;
    }
    assert.ok(up && prev === 0, `${what}: up and its rim 0 by 0.3 s`);
  }
  assertStateless(score, {}, (s) => [[...s.collage.leaves], [...s.collage.tear], [...s.collage.rim]]);
});

// The smear: a large slide (the sky's from) and a large slam, both landing at 30
const from = [-0.0076, -0.0665, 2.35, 1.126];
const slide = { leaf: 1, size: 4, t: 30, d: 0.2, note: 1, style: 'slide', from };
const slam = { ...slide, size: 3, style: 'slam' };
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got}, not ${want}`);
const still = (r) => r.smx === 0 && r.smy === 0;

// frame k's smear is where the piece was on frame k - 1 minus where it is (from on frame 0), as fx
// off draws it (no jitter)
function wayItCame(ev, k) {
  const was = pieceAt(30 + (k - 1) / 60, ev, glue, false);
  const is = pieceAt(30 + k / 60, ev, glue, false);
  return [SMEAR * (was.x - is.x), SMEAR * (was.y - is.y)];
}

test('pieceAt: a large slide is drawn stretched back the way it came, on its 8 frames and the one after', () => {
  const at = (k) => pieceAt(30 + k / 60, slide, glue);
  assert.ok(still(at(0)), `frame 0 (it has not moved yet): ${JSON.stringify(at(0))}`);
  for (const [k, part] of [[1, 0.330078125], [2, 0.248046875], [8, 0.001953125]]) {
    near(at(k).smx, -0.0076 * part * SMEAR, `smx at frame ${k}`);
    near(at(k).smy, -0.0665 * part * SMEAR, `smy at frame ${k}`);
  }
  for (let k = 0; k <= 9; k++) {
    const [x, y] = wayItCame(slide, k);
    near(at(k).smx, x, `smx at frame ${k}, the way it came`);
    near(at(k).smy, y, `smy at frame ${k}, the way it came`);
  }
  for (const k of [-1, 9, 10, 20, 60]) assert.ok(still(at(k)), `frame ${k}: ${JSON.stringify(at(k))}`);
});

test('pieceAt: a large slam is stretched back to from on its first frame, toward its overshoot on the next, then not at all', () => {
  const at = (k) => pieceAt(30 + k / 60, slam, glue);
  assert.ok(still(at(0)), `frame 0: ${JSON.stringify(at(0))}`);
  near(at(1).smy, -0.0665 * 1.0875 * SMEAR, 'smy at frame 1');
  near(at(2).smy, -0.0665 * -0.0875 * SMEAR, 'smy at frame 2');
  near(at(1).smx, -0.0076 * 1.0875 * SMEAR, 'smx at frame 1');
  for (let k = 0; k <= 3; k++) {
    const [x, y] = wayItCame(slam, k);
    near(at(k).smx, x, `smx at frame ${k}, the way it came`);
    near(at(k).smy, y, `smy at frame ${k}, the way it came`);
  }
  for (const k of [-1, 3, 4, 8, 9, 60]) assert.ok(still(at(k)), `frame ${k}: ${JSON.stringify(at(k))}`);
});

test('pieceAt: the smear adds smx, smy and changes nothing else (its turn and scale are not stretched)', () => {
  // a large piece is, but for them, the same piece as one too small to smear (but for its ink,
  // which lasts a frame longer for each size: pieceAt gives 1 for 0 <= dt < (1 + size) frames)
  const but = ({ smx, smy, ink, ...rest }) => rest;
  const FRAME = 1 / 60;
  for (const ev of [slide, slam]) {
    const small = { ...ev, size: SMEAR_MIN_SIZE - 1 };
    for (let k = -1; k <= 10; k++) {
      const t = 30 + k / 60;
      for (const fx of [true, false]) {
        assert.ok(still(pieceAt(t, small, glue, fx)), `${ev.style} size ${small.size} frame ${k} fx ${fx}: smeared`);
        assert.deepEqual(but(pieceAt(t, ev, glue, fx)), but(pieceAt(t, small, glue, fx)), `${ev.style} frame ${k} fx ${fx}`);
        const dt = t - ev.t;
        assert.equal(pieceAt(t, ev, glue, fx).ink, dt >= 0 && dt < (1 + ev.size) * FRAME ? 1 : 0, `${ev.style} frame ${k} fx ${fx}: ink`);
      }
    }
  }
});

test('pieceAt: no smear for a small slam, a develop or bleed piece, or a fold piece that folds', () => {
  const big = { ...slam, style: 'fold' }; // folds (size 3)
  const never = [
    ['a size 2 slam', { ...slam, size: 2 }],
    ['a size 2 slide', { ...slide, size: 2 }],
    ['develop', { ...slide, style: 'develop' }],
    ['bleed', { ...slide, style: 'bleed' }],
    ['a fold piece that folds', big],
  ];
  assert.ok(big.size >= SMEAR_MIN_SIZE && slam.size >= SMEAR_MIN_SIZE && !(2 >= SMEAR_MIN_SIZE));
  for (const [what, ev] of never) {
    for (let k = -1; k <= 20; k++) {
      const r = pieceAt(30 + k / 60, ev, glue, true);
      assert.ok(still(r), `${what} at frame ${k}: ${JSON.stringify(r)}`);
    }
  }
});

test('pieceAt: a large fold piece whose cut-out does not fold is a slam, its smear too', () => {
  const big = { ...slam, style: 'fold' };
  for (const k of [1, 2]) {
    const f = pieceAt(30 + k / 60, big, glue, true, false);
    const s = pieceAt(30 + k / 60, slam, glue, true);
    assert.deepEqual([f.smx, f.smy], [s.smx, s.smy], `frame ${k}`);
    assert.ok(!still(f), `frame ${k}: smeared`);
  }
});

test('the committed score: the sky is smeared as it slides in, the cloud as it slams in; nothing once they are in, or at 44.9', () => {
  const { score, cuts, names } = committed();
  const sky = cuts.findIndex((c) => names(c).includes('sky'));
  const cloud = cuts.findIndex((c) => names(c).includes('cloud_main'));
  assert.ok(sky >= 0 && cloud >= 0);
  // the third texel of cut-out k: (fold, smx, smy, tape)
  const third = (tx, k) => Array.from(tx.subarray(k * CUT_FLOATS + CUT_FOLD, k * CUT_FLOATS + CUT_FLOATS));
  const smearOf = (tx, k) => [tx[k * CUT_FLOATS + CUT_SMEAR], tx[k * CUT_FLOATS + CUT_SMEAR + 1]];
  const st = frameState(30.3183 + 1 / 60, score);
  assert.ok(st.smear instanceof Float32Array && st.smear.length === score.pieces.length * 2);
  const tx = cutoutTexels(cuts, st);
  const rep = cuts[sky].rep;
  assert.deepEqual(third(tx, sky), [st.fold[rep], st.smear[rep * 2], st.smear[rep * 2 + 1], st.tape[rep]], 'the representative row\'s');
  assert.equal(st.tape[rep], 0, 'no tape while it slides in');
  assert.ok(Math.hypot(...smearOf(tx, sky)) > 0.015, `the sky's smear on its first frame: ${smearOf(tx, sky)}`);
  // 9 frames on: the sky is in; the cloud (a size 3 slam at 30.4606) is coming in, smeared itself
  const late = cutoutTexels(cuts, frameState(30.3183 + 9 / 60, score));
  assert.deepEqual(smearOf(late, sky), [0, 0]);
  assert.ok(Math.hypot(...smearOf(late, cloud)) > 0, `the cloud's smear: ${smearOf(late, cloud)}`);
  // the cloud is in, the far city not yet come; and the finished picture
  for (const t of [30.55, 44.9]) assert.ok(frameState(t, score).smear.every((x) => x === 0), `t=${t}`);
  assertStateless(score, {}, (s) => [...s.smear]);
});

test('the committed score: the sky and the fourteen large cut-outs smear as they come in', () => {
  const { score, cuts, names } = committed();
  // the cut-outs smeared on their first frame (every one that smears is then: from is never 0)
  const on = cuts.filter((c) => {
    const st = frameState(c.t + 1 / 60, score);
    return st.smear[c.rep * 2] !== 0 || st.smear[c.rep * 2 + 1] !== 0;
  });
  const big = (c) => c.size >= SMEAR_MIN_SIZE && (c.style === 'slide' || c.style === 'slam');
  assert.deepEqual(on, cuts.filter(big));
  assert.equal(on.length, 15);
  assert.ok(on.some((c) => names(c).includes('sky')) && on.some((c) => names(c).includes('cloud_main')));
});

// The masking tape: put on once the piece has landed, its entry (fold, smear, slam) over. A large
// fold piece landing at 30, folding.
const big = { ...fold, t: 30 };
const tapeAt = (t, ev, fx = true) => pieceAt(t, ev, glue, fx).tape;

test('pieceAt: the tape goes on a frame after the entry: a slam\'s 2 frames, a slide\'s 8', () => {
  assert.equal(tapeAt(30 + 2 / 60, slam), 0);
  assert.equal(tapeAt(30 + 3 / 60 + 1e-9, slam), 1);
  assert.equal(tapeAt(30 + 8 / 60, slide), 0);
  assert.equal(tapeAt(30 + 9 / 60 + 1e-9, slide), 1);
  // on the frames of the video: from the first frame without a smear on, never with one
  for (const [ev, on] of [[slam, 3], [slide, 9]]) {
    for (let k = -2; k <= 40; k++) {
      const r = pieceAt(30 + k / 60, ev, glue);
      assert.equal(r.tape, k >= on ? 1 : 0, `${ev.style} frame ${k}`);
      if (r.tape) assert.ok(still(r), `${ev.style} frame ${k}: taped while smeared`);
    }
  }
  // the piece's size does not matter here (cutouts.js tapeSpot leaves the small ones out)
  assert.equal(tapeAt(30 + 3 / 60 + 1e-9, { ...slam, size: 1 }), 1);
  assert.equal(tapeAt(31, slam, false), 1, 'fx off too');
});

test('pieceAt: a folding piece is taped a frame after it is up: FOLD_D and one', () => {
  assert.equal(tapeAt(30 + 6 / 60, big), 0);
  assert.equal(tapeAt(30 + 7 / 60 + 1e-9, big), 1);
  assert.equal(tapeAt(30 + FOLD_D, big), 0, 'up, not yet taped');
  assert.equal(tapeAt(30 + FOLD_D + 1 / 60 + 1e-9, big), 1, 'taped');
  for (let k = -2; k <= 40; k++) {
    const r = pieceAt(30 + k / 60, big, glue);
    assert.equal(r.tape, k >= FRAMES + 1 ? 1 : 0, `frame ${k}`);
    if (r.tape) assert.equal(r.fold, 0, `frame ${k}: taped while folding`);
  }
});

test('pieceAt: no tape on a develop or bleed piece, or before a piece lands', () => {
  for (let k = -2; k <= 300; k += 3) {
    const t = 30 + k / 60;
    assert.equal(tapeAt(t, { ...slide, style: 'develop' }), 0, `develop frame ${k}`);
    assert.equal(tapeAt(t, { ...slide, style: 'bleed' }), 0, `bleed frame ${k}`);
  }
  for (const ev of [slam, slide, big]) assert.equal(tapeAt(29.99, ev), 0, `${ev.style} before it lands`);
});

test('the committed score: the folding blocks are taped once up, the sky long after its slide', () => {
  const { score, cuts, blocks, names } = folding();
  const sky = cuts.find((c) => names(c).includes('sky'));
  const st = frameState(37.8154 + 5 / 60, score);
  assert.ok(st.tape instanceof Float32Array && st.tape.length === score.pieces.length);
  const later = frameState(38.5, score);
  for (const c of blocks) {
    assert.equal(st.tape[c.rep], 0, `block ${c.note} still folding`);
    assert.equal(later.tape[c.rep], 1, `block ${c.note} up and taped`);
  }
  assert.equal(frameState(35.0, score).tape[sky.rep], 1, 'the sky');
  // the texel carries the representative row's tape
  const k = cuts.indexOf(sky);
  assert.equal(cutoutTexels(cuts, frameState(35.0, score))[k * CUT_FLOATS + CUT_TAPE], 1);
  assert.equal(cutoutTexels(cuts, frameState(30.3183 + 8 / 60, score))[k * CUT_FLOATS + CUT_TAPE], 0, 'the sky, still sliding');
  assertStateless(score, {}, (s) => [...s.tape]);
});

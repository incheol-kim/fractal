import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  looseAt,
  collageLeafAt,
  collageBlockAt,
  strengths,
  frameState,
  pieceAt,
  emergeAt,
  foldingLeaves,
  PASTE,
  TEAR,
  FOLD_D,
  GLUE_BREATH,
  GLUE_OPEN,
} from '../src/timeline.js';
import { openAcross, PIP } from '../src/collage.js';

const F = 1 / 60;
const glue = 41.4952;
const slam = (size, extra = {}) => ({
  leaf: 7, size, t: 31, d: 1, note: 3, style: 'slam', from: [0.1, -0.1, 5, 1.2], ...extra,
});
const ev = (extra = {}) => ({ leaf: 7, block: 0, t: 20, note: 3, off: 31, tear: false, ...extra });

test('looseAt', () => {
  assert.equal(looseAt(glue - GLUE_BREATH, glue), 1);
  assert.equal(looseAt(glue, glue), GLUE_OPEN);
  assert.equal(looseAt(glue + 0.05, glue), 0);
  const m = looseAt(glue + 0.025, glue);
  assert.ok(m > 0 && m < 1);
});

test('collageLeafAt: the breath before the glue chord opens the offsets as much as the torn edges', () => {
  const p = slam(4, { t: glue });
  const e = ev({ off: glue });
  const base = collageLeafAt(40, e, p, glue);
  assert.ok(base.dx !== 0 && base.dy !== 0);
  assert.deepEqual(collageLeafAt(glue - GLUE_BREATH, e, p, glue), base);
  const tb = glue - GLUE_BREATH / 2;
  for (const [t, k] of [[tb, looseAt(tb, glue)], [glue, GLUE_OPEN]]) {
    const r = collageLeafAt(t, e, p, glue);
    assert.ok(Math.abs(r.dx - base.dx * k) < 1e-15 && Math.abs(r.dy - base.dy * k) < 1e-15, `offset at ${t}`);
    assert.equal(r.a, 1);
  }
});

test('collageLeafAt: a piece that is not torn off', () => {
  const p = slam(0);
  assert.equal(collageLeafAt(19.999, ev(), p, glue).a, 0);
  const r = collageLeafAt(20, ev(), p, glue);
  assert.equal(r.a, 1);
  assert.ok(r.s > 1);
  assert.equal(collageLeafAt(20 + 2 / 60, ev(), p, glue).s, 1);
  const q = collageLeafAt(25, ev(), p, glue);
  for (const d of [q.dx, q.dy]) assert.ok(Math.abs(d) >= 2 / 2160 - 1e-12 && Math.abs(d) <= 6 / 2160 + 1e-12);
  assert.equal(collageLeafAt(31, ev(), p, glue).a, 1);
  assert.equal(collageLeafAt(31 + 1.5 * F, ev(), p, glue).a, 0);
  for (const t of [19, 20, 25, 31, 31.01, 31 + TEAR, 40]) assert.equal(collageLeafAt(t, ev(), p, glue).tear, 0);
});

test('collageLeafAt: a piece that is torn off', () => {
  const e = ev({ tear: true });
  const p = slam(3);
  assert.equal(collageLeafAt(31, e, p, glue).tear, 0);
  const m = collageLeafAt(31 + TEAR / 2, e, p, glue);
  assert.ok(m.tear > 0 && m.tear < 1);
  assert.equal(m.a, 1);
  const z = collageLeafAt(31 + TEAR, e, p, glue);
  assert.equal(z.tear, 1);
  assert.equal(z.a, 0);
});

test('collageLeafAt: a develop piece is covered when it has developed', () => {
  const p = { leaf: 7, size: 1, t: 35.24, d: 1.5, note: 3, style: 'develop', from: [0, 0, 0, 1] };
  const e = ev({ off: 35.24 });
  assert.equal(collageLeafAt(35.9, e, p, glue).a, 1);
  assert.equal(collageLeafAt(35.24 + 1.5, e, p, glue).a, 0);
});

test('emergeAt: how far a develop or bleed piece has come up; pieceAt\'s a for both', () => {
  const dv = { leaf: 7, size: 1, t: 35.24, d: 1.5, note: 3, style: 'develop', from: [0, 0, 0, 1] };
  const bl = { ...dv, style: 'bleed', d: 3 };
  assert.equal(emergeAt(35.2, dv), 0);
  assert.equal(emergeAt(35.24, dv), 0);
  assert.ok(Math.abs(emergeAt(35.99, dv) - 0.5) < 1e-9);
  assert.equal(emergeAt(35.24 + 1.5, dv), 1);
  // bleed comes up in 0.5 s whatever its d
  assert.ok(Math.abs(emergeAt(35.49, bl) - 0.5) < 1e-9);
  assert.equal(emergeAt(35.74, bl), 1);
  // develop with d 0: there at once
  assert.equal(emergeAt(35.239, { ...dv, d: 0 }), 0);
  assert.equal(emergeAt(35.24, { ...dv, d: 0 }), 1);
  for (const p of [dv, bl]) {
    for (const t of [35, 35.24, 35.3, 35.6, 36.2, 36.74, 37]) assert.equal(pieceAt(t, p, glue).a, emergeAt(t, p), `${p.style} ${t}`);
  }
});

test('collageLeafAt: under a develop or bleed piece the torn edge, shadow and offset go with the piece', () => {
  const p = { leaf: 7, size: 1, t: 35.24, d: 1.5, note: 3, style: 'develop', from: [0, 0, 0, 1] };
  const e = ev({ off: 35.24 });
  const before = collageLeafAt(35.0, e, p, glue);
  assert.equal(before.rim, 1);
  assert.ok(Math.abs(before.dx) >= 2 / 2160 - 1e-12);
  // rim = 1 - the piece's a, and the offset shrinks with it
  for (const t of [35.4, 35.99, 36.5, 36.73]) {
    const r = collageLeafAt(t, e, p, glue);
    assert.equal(r.a, 1, `still there at ${t}`);
    assert.ok(Math.abs(r.rim - (1 - pieceAt(t, p, glue).a)) < 1e-12, `rim at ${t}`);
    assert.ok(Math.abs(r.dx - before.dx * r.rim) < 1e-15 && Math.abs(r.dy - before.dy * r.rim) < 1e-15, `offset at ${t}`);
  }
  // one frame before the piece is whole almost nothing is left of them, so nothing pops when the fragment goes
  const last = collageLeafAt(35.24 + 1.5 - 1 / 60, e, p, glue);
  assert.ok(last.rim < 0.012 && Math.abs(last.dx) < 0.012 * 6 / 2160, `${last.rim} ${last.dx}`);
  assert.equal(collageLeafAt(35.24 + 1.5, e, p, glue).a, 0);
  // bleed: the same over its 0.5 s
  const b = { ...p, style: 'bleed', d: 3 };
  assert.ok(Math.abs(collageLeafAt(35.49, e, b, glue).rim - 0.5) < 1e-9);
  // a pasted piece, a torn-off fragment, no piece, not there yet: 1
  assert.equal(collageLeafAt(31 + F / 2, ev(), slam(0), glue).rim, 1);
  assert.equal(collageLeafAt(31 + TEAR / 2, ev({ tear: true }), slam(3), glue).rim, 1);
  assert.equal(collageLeafAt(30, ev(), undefined, glue).rim, 1);
  assert.equal(collageLeafAt(19, ev(), p, glue).rim, 1);
});

test('collageLeafAt: under a panel that folds up the fragment is not torn off; it goes as the panel stands', () => {
  const p = { leaf: 7, size: 3, t: 31, d: 0.1, note: 3, style: 'fold', from: [0.1, -0.1, 5, 1.2] };
  const e = ev({ tear: true });
  const D = 10 / 60;
  const before = collageLeafAt(30.9, e, p, glue, D);
  assert.equal(before.rim, 1);
  for (let k = 0; k < 10; k++) {
    const r = collageLeafAt(31 + k / 60, e, p, glue, D);
    assert.equal(r.tear, 0, `no tear at frame ${k}`);
    assert.equal(r.a, 1, `drawn at frame ${k}`);
    assert.ok(Math.abs(r.rim - (1 - k / 10)) < 1e-9, `rim at frame ${k}: ${r.rim}`);
    assert.ok(Math.abs(r.dx - before.dx * r.rim) < 1e-15, `offset at frame ${k}`);
  }
  const up = collageLeafAt(31 + 10 / 60, e, p, glue, D);
  assert.deepEqual([up.a, up.tear, up.rim], [0, 0, 0]);
  assert.equal(collageLeafAt(40, e, p, glue, D).tear, 0, 'never torn');
  // without a fold (0, the default) it is torn off as before
  assert.deepEqual(collageLeafAt(31 + TEAR / 2, e, p, glue, 0), collageLeafAt(31 + TEAR / 2, e, p, glue));
  assert.ok(collageLeafAt(31 + TEAR / 2, e, p, glue).tear > 0);
});

test('collageLeafAt: no offset once the glue has set', () => {
  const r = collageLeafAt(glue + 0.05, ev({ off: 41.4952 }), slam(4, { t: 41.4952 }), glue);
  assert.ok(r.dx === 0 && r.dy === 0);
  assert.equal(r.a, 1);
});

test('collageBlockAt', () => {
  const evs = [{ t: 22, to: 1 }, { t: 23, to: 2 }];
  assert.equal(collageBlockAt(19, 20, 0, evs).cur, -1);
  assert.deepEqual(collageBlockAt(21.9, 20, 0, evs), { cur: 0, prev: -1, u: 1, k: 0 });
  assert.deepEqual(collageBlockAt(22, 20, 0, evs), { cur: 1, prev: 0, u: 0, k: 1 });
  const m = collageBlockAt(22 + PASTE / 2, 20, 0, evs);
  assert.ok(m.u > 0 && m.u < 1);
  assert.deepEqual(collageBlockAt(22 + PASTE, 20, 0, evs), { cur: 1, prev: -1, u: 1, k: 1 });
  const l = collageBlockAt(23.5, 20, 0, evs);
  assert.equal(l.cur, 2);
  assert.equal(l.k, 2);
});

const load = (f) => JSON.parse(readFileSync(new URL(`../assets/${f}`, import.meta.url), 'utf8'));
const score = load('score.json');
const regions = load('regions.json');
const coda = new Set(
  [1, 2, 3, 4, 5].map((k) => `coral_tree_${k}`).concat(['white_square_a', 'white_square_b'])
    .flatMap((g) => regions.groups[g]),
);
const leafIds = score.collage.leaves.map((l) => l.leaf);

test('strengths', () => {
  assert.deepEqual(strengths(score), ['calm', 'mid', 'high']);
  assert.deepEqual(strengths({}), []);
});

for (const strength of ['calm', 'mid', 'high']) {
  test(`real score (${strength}): the collage over time`, () => {
    const on = (t) => {
      const f = frameState(t, score, { strength });
      return { f, set: leafIds.filter((_, i) => f.collage.leaves[i * 4] === 1) };
    };
    assert.equal(on(19.0).set.length, 0);
    assert.equal(on(30.2).set.length, 134);
    const f231 = frameState(23.1, score, { strength });
    for (let i = 0; i < score.flats.length; i++) assert.equal(f231.flats[i * 4], 0, `flat ${i}`);
    const f417 = on(41.7);
    assert.deepEqual(f417.set.slice().sort((a, b) => a - b), [...coda].sort((a, b) => a - b));
    assert.equal(f417.f.collage.loose, 0);
    // a torn-off fragment keeps tear 1 after it is gone (a is 0); among those still on, none is tearing
    assert.ok(leafIds.every((_, i) => f417.f.collage.leaves[i * 4] === 0 || f417.f.collage.tear[i] === 0));
    assert.equal(on(44.9).set.length, 0);
  });

  // design 6.2's 4: while a glass room is a window (score.pip, from its P to the change to its
  // accent in this strength, E; none: to the end) its cuts do not show, the window does
  test(`real score (${strength}): every change shows at its time, but a room's change while it is a window shows the window`, () => {
    const c = score.collage;
    const windows = new Map(
      score.pip.map((p) => {
        const acc = p.accent >= 0 ? c.changes[strength].events.find((e) => e.block === p.block && e.to === p.accent && e.t >= p.t) : undefined;
        return [p.block, { P: p.t, E: acc ? acc.t : Infinity, n: 0 }];
      }),
    );
    assert.equal(windows.size, 3);
    for (const e of c.changes[strength].events) {
      const f = frameState(e.t, score, { strength });
      const w = windows.get(e.block);
      if (w && e.t >= w.P && e.t < w.E) {
        assert.equal(f.collage.blocks[e.block * 4], PIP, `block ${e.block} at ${e.t}: the window`);
        w.n++;
      } else {
        assert.equal(f.collage.blocks[e.block * 4], e.to, `block ${e.block} at ${e.t}`);
      }
    }
    for (const [b, w] of windows) assert.ok(w.n >= 1, `${c.blocks[b].name}: no change asserted as the window`);
  });

  test(`real score (${strength}): nothing changes while the cello draws the lines`, () => {
    const a = frameState(32.0, score, { strength }).collage.blocks;
    const b = frameState(34.0, score, { strength }).collage.blocks;
    for (let i = 0; i < a.length; i += 4) assert.equal(a[i], b[i], `block ${i / 4}`);
  });

  test(`real score (${strength}): stateless`, () => {
    const ts = [];
    for (let i = 0; i < 200; i++) ts.push(((i * 7919) % 200) * 0.2371 + 0.013);
    const asc = ts.slice().sort((a, b) => a - b);
    const ref = new Map(asc.map((t) => [t, frameState(t, score, { strength }).collage]));
    for (const t of ts) {
      const c = frameState(t, score, { strength }).collage;
      const r = ref.get(t);
      assert.deepEqual(Array.from(c.blocks), Array.from(r.blocks));
      assert.deepEqual(Array.from(c.leaves), Array.from(r.leaves));
      assert.deepEqual(Array.from(c.tear), Array.from(r.tear));
      assert.deepEqual(Array.from(c.rim), Array.from(r.rim));
      assert.equal(c.loose, r.loose);
    }
  });
}

test('real score: the rim of the fragments under the developing rooms fades with them, under the folding blocks with the fold, and only theirs', () => {
  const pieceOf = new Map(score.pieces.map((p) => [p.leaf, p]));
  const under = (r) => !r.tear && ['develop', 'bleed'].includes((pieceOf.get(r.leaf) || {}).style);
  const folds = foldingLeaves(score.pieces);
  // the fold: from 1 on the note to 0 when the panel is up
  const fold = (r, t) => 1 - Math.min(Math.max((t - pieceOf.get(r.leaf).t) / FOLD_D, 0), 1);
  for (const t of [30.0, 35.9, 36.3, 36.74, 37.8231 + 3 / 60, 40.0]) {
    const c = frameState(t, score).collage;
    assert.equal(c.rim.length, score.collage.leaves.length);
    score.collage.leaves.forEach((r, i) => {
      const want = under(r) ? 1 - pieceAt(t, pieceOf.get(r.leaf), score.glue).a : folds.has(r.leaf) ? fold(r, t) : 1;
      assert.ok(Math.abs(c.rim[i] - want) < 1e-6, `leaf ${r.leaf} at ${t}: ${c.rim[i]} (want ${want})`);
    });
  }
  // the rooms (35.25 .. 36.76): partway at 36.0
  const mid = frameState(36.0, score).collage;
  assert.ok(score.collage.leaves.some((r, i) => under(r) && mid.rim[i] > 0 && mid.rim[i] < 1 && mid.leaves[i * 4] === 1));
});

test('real score: the torn edge along a fragment under a develop or bleed piece opens with the piece, not in one frame', () => {
  // the photo of each leaf as the timeline takes it (its first event)
  const pieceOf = new Map();
  for (const p of score.pieces) if (!pieceOf.has(p.leaf)) pieceOf.set(p.leaf, p);
  const rows = [];
  score.collage.leaves.forEach((r, i) => {
    const p = pieceOf.get(r.leaf);
    if (p && ['develop', 'bleed'].includes(p.style)) rows.push({ i, leaf: r.leaf, p });
  });
  assert.ok(rows.length > 0, 'no collage leaf under a develop or bleed piece');
  const STEP = 0.05; // the most it may open from one frame to the next
  const LEAD = 0.1; // seconds looked at before the piece starts and after it is whole
  for (const { i, leaf, p } of rows) {
    // the 60 fps frames from LEAD before the piece starts to LEAD after it is whole
    const open = [];
    let k = Math.ceil((p.t - LEAD) * 60);
    let whole = Infinity;
    for (; k / 60 <= whole + LEAD; k++) {
      const t = k / 60;
      if (whole === Infinity && emergeAt(t, p) >= 1) whole = t;
      const c = frameState(t, score).collage;
      // what the block's mesh draws of the leaf (a fragment being torn off or gone: 0), and its rim;
      // the edge is that of a leaf across it that is not developing (own rim 1, openAcross's default)
      const a = c.tear[i] > 0 ? 0 : c.leaves[i * 4];
      open.push({ t, v: openAcross(a, c.rim[i]) });
    }
    const what = `leaf ${leaf} (${p.style} at ${p.t})`;
    assert.equal(open[0].v, 0, `${what}: shut at ${open[0].t}`);
    assert.equal(open[open.length - 1].v, 1, `${what}: open at ${open[open.length - 1].t}`);
    for (let j = 1; j < open.length; j++) {
      const d = open[j].v - open[j - 1].v;
      assert.ok(d >= 0 && d <= STEP, `${what}: ${open[j - 1].v} -> ${open[j].v} at ${open[j].t}`);
    }
  }
});

test('real score: no torn edge opens between the two rooms that develop together; the blue window\'s neighbours open with its rim', () => {
  const leaves = score.collage.leaves;
  const rowOf = (leaf) => leaves.findIndex((r) => r.leaf === leaf);
  const pieceOf = new Map();
  for (const p of score.pieces) if (!pieceOf.has(p.leaf)) pieceOf.set(p.leaf, p);
  // the 60 fps frames from 0.1 s before a piece starts to 0.1 s after it is whole
  const framesOf = (p) => {
    const ts = [];
    let whole = Infinity;
    for (let k = Math.ceil((p.t - 0.1) * 60); k / 60 <= whole + 0.1; k++) {
      if (whole === Infinity && emergeAt(k / 60, p) >= 1) whole = k / 60;
      ts.push(k / 60);
    }
    return ts;
  };
  const drawn = (c, i) => (c.tear[i] > 0 ? 0 : c.leaves[i * 4]); // what the block's mesh draws of a row

  // blue_room (52) and curtain_blue (53): one block, developing at the same time for as long, so
  // their rims are the same at every moment and neither edge opens toward the other while both are
  // drawn (exactly 0: own - cover is 0 for equal rims, on the GPU too)
  const [r52, r53] = [rowOf(52), rowOf(53)];
  const [p52, p53] = [pieceOf.get(52), pieceOf.get(53)];
  assert.equal(leaves[r52].block, leaves[r53].block);
  assert.ok(p52.style === 'develop' && p53.style === 'develop' && p52.t === p53.t && p52.d === p53.d);
  let both = 0;
  for (const t of framesOf(p52)) {
    const c = frameState(t, score).collage;
    if (!(drawn(c, r52) > 0 && drawn(c, r53) > 0)) continue;
    both++;
    assert.equal(openAcross(drawn(c, r53), c.rim[r53], c.rim[r52]), 0, `52 toward 53 at ${t}`);
    assert.equal(openAcross(drawn(c, r52), c.rim[r52], c.rim[r53]), 0, `53 toward 52 at ${t}`);
  }
  assert.ok(both >= 90, `${both} frames with both drawn`);

  // win_blue_low (69): the other leaves of its block are not developing (own rim 1), so their edge
  // along it opens as 1 - its rim while it is drawn, and is open once it has gone
  const r69 = rowOf(69);
  const others = leaves.map((r, i) => i).filter((i) => i !== r69 && leaves[i].block === leaves[r69].block);
  assert.ok(others.length > 0);
  for (const t of framesOf(pieceOf.get(69))) {
    const c = frameState(t, score).collage;
    const a = drawn(c, r69);
    for (const j of others) {
      assert.equal(c.rim[j], 1, `row ${j} at ${t}`);
      assert.equal(openAcross(a, c.rim[r69], c.rim[j]), a > 0 ? 1 - c.rim[r69] : 1, `row ${j} toward 69 at ${t}`);
    }
  }
});

test('real score: an unknown strength is the default', () => {
  const a = frameState(25, score, { strength: 'nonsense' }).collage;
  const b = frameState(25, score, { strength: score.collage.default }).collage;
  assert.equal(a.strength, score.collage.default);
  assert.deepEqual(a, b);
  assert.equal(frameState(25, score).collage.strength, score.collage.default);
});

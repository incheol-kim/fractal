// Picture in picture (Task 10, design 6.2's 4): the three glass rooms of score.pip become windows
// that show the whole frame in miniature (timeline.js pipCollage); frameState's collageBase is the
// collage without them, the innermost miniature. The committed score, in all three strengths; the
// accents' times are read from the score, never typed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameState, PASTE } from '../src/timeline.js';
import { PIP } from '../src/collage.js';
import { realScore, assertStateless } from './helpers.js';

const score = realScore();
// the committed score without its windows: the frame as it is without the picture in picture
const { pip, ...noPip } = score;
const STRENGTHS = ['calm', 'mid', 'high'];
const ROOMS = ['glass_room', 'blue_room', 'red_room'];
const rowOf = (name) => score.collage.blocks.findIndex((b) => b.name === name);
const pipOf = (name) => score.pip.find((p) => p.block === rowOf(name));
// the block's [cur, prev, u, k] in a state's collage (or collageBase)
const block = (c, name) => Array.from(c.blocks.subarray(rowOf(name) * 4, rowOf(name) * 4 + 4));
// the collage leaf rows of a block
const leafRows = (name) => score.collage.leaves.map((l, i) => (l.block === rowOf(name) ? i : -1)).filter((i) => i >= 0);
// E: the time of the room's change to its accent in a strength, at or after its P (none: Infinity)
function accentAt(strength, name) {
  const p = pipOf(name);
  if (p.accent < 0) return Infinity;
  const e = score.collage.changes[strength].events.find((x) => x.block === p.block && x.to === p.accent && x.t >= p.t);
  return e ? e.t : Infinity;
}
const on = (strength) => ({ strength });

test('score.pip: the three glass rooms, in time order', () => {
  assert.deepEqual(score.pip.map((p) => score.collage.blocks[p.block].name), ROOMS);
  assert.ok(score.pip.every((p, i) => i === 0 || p.t > score.pip[i - 1].t));
});

for (const strength of STRENGTHS) {
  test(`pip (${strength}): nothing before the first window; then the central room is one, and collageBase is the frame without it`, () => {
    const P = pipOf('glass_room').t;
    const before = frameState(P - 0.001, score, on(strength));
    assert.equal(before.collageBase, null);
    assert.deepEqual(before.collage, frameState(P - 0.001, noPip, on(strength)).collage);

    const s = frameState(21.0, score, on(strength));
    const o = frameState(21.0, noPip, on(strength));
    assert.equal(block(s.collage, 'glass_room')[0], PIP);
    // the innermost miniature is the room without the window
    assert.deepEqual(s.collageBase, o.collage);
    // the room's leaves that come later without it (24.40 and 25.10 s) are pasted with the window
    const rows = leafRows('glass_room');
    assert.ok(rows.length > 0 && rows.every((i) => score.collage.leaves[i].t > 21.0), 'leaves that arrive after 21 s without the window');
    for (const i of rows) {
      assert.equal(s.collage.leaves[i * 4], 1, `leaf row ${i} in collage`);
      assert.equal(s.collageBase.leaves[i * 4], 0, `leaf row ${i} in collageBase`);
    }
    // nothing else of the collage differs
    const own = new Set(rows);
    s.collage.blocks.forEach((v, j) => j >> 2 === rowOf('glass_room') || assert.equal(v, o.collage.blocks[j], `blocks[${j}]`));
    s.collage.leaves.forEach((v, j) => own.has(j >> 2) || assert.equal(v, o.collage.leaves[j], `leaves[${j}]`));

    const late = frameState(27.5, score, on(strength));
    assert.equal(block(late.collage, 'blue_room')[0], PIP);
    assert.equal(block(late.collage, 'red_room')[0], PIP);
  });

  test(`pip (${strength}): each window is pasted as a new cut is, in PASTE`, () => {
    for (const name of ROOMS) {
      const P = pipOf(name).t;
      assert.ok(!block(frameState(P - 0.001, score, on(strength)).collage, name).includes(PIP), `${name}: not before ${P}`);
      const [cur, , u0] = block(frameState(P, score, on(strength)).collage, name);
      assert.equal(cur, PIP, `${name} at P`);
      assert.equal(u0, 0, `${name}: u at P`);
      const [cur1, prev1, u1] = block(frameState(P + PASTE, score, on(strength)).collage, name);
      assert.deepEqual([cur1, prev1, u1], [PIP, -1, 1], `${name} at P + PASTE`);
    }
  });

  test(`pip (${strength}): the accent is pasted over the window, and the room is as without it from then on`, () => {
    for (const name of ['glass_room', 'red_room']) {
      const E = accentAt(strength, name);
      const { accent } = pipOf(name);
      assert.ok(Number.isFinite(E), `${name} has its accent in ${strength}`);
      assert.equal(block(frameState(E - 0.01, score, on(strength)).collage, name)[0], PIP, `${name} before E`);
      assert.deepEqual(block(frameState(E + 0.01, score, on(strength)).collage, name).slice(0, 2), [accent, PIP], `${name} at E`);
      const t = E + PASTE + 0.01;
      assert.deepEqual(block(frameState(t, score, on(strength)).collage, name), block(frameState(t, noPip, on(strength)).collage, name), `${name} after E`);
    }
    // the blue room has no accent: a window until its photo has developed over it
    assert.equal(pipOf('blue_room').accent, -1);
    assert.equal(block(frameState(35.0, score, on(strength)).collage, 'blue_room')[0], PIP);
    assert.equal(frameState(36.9, score, on(strength)).collageBase, null);
  });

  // A room's leaves that arrive after P are shown from P; from E on the block is the base's, and once
  // no window shows the frame is the base's. A leaf of the room arriving after E would vanish then
  // and come back at its own time: every leaf arrives before E. A room without an accent stays a
  // window until its photo has covered every leaf, so at least until its stop (its photo comes).
  test(`pip (${strength}): every leaf of a room arrives before its accent comes down (without one, before its photo)`, () => {
    for (const name of ROOMS) {
      const E = accentAt(strength, name);
      const { stop } = score.collage.blocks[rowOf(name)];
      const end = Number.isFinite(E) ? E : stop;
      if (!Number.isFinite(E)) {
        const s = frameState(stop - 0.001, score, on(strength));
        assert.equal(block(s.collage, name)[0], PIP, `${name} is a window up to its photo at ${stop}`);
        assert.ok(leafRows(name).some((i) => s.collage.leaves[i * 4] > 0), `${name}: a leaf shows its window up to ${stop}`);
      }
      const last = leafRows(name).reduce((a, i) => (score.collage.leaves[i].t > score.collage.leaves[a].t ? i : a));
      const { leaf, t } = score.collage.leaves[last];
      assert.ok(t < end, `${name}: leaf ${leaf} arrives at ${t}, not before ${Number.isFinite(E) ? `its accent at ${E}` : `its photo at ${stop}`}`);
    }
  });

  test(`pip (${strength}): stateless`, () => {
    assertStateless(score, { strength }, (s) => [[...s.collage.blocks], [...s.collage.leaves], s.collageBase && [...s.collageBase.blocks]]);
  });
}

test('pip: without score.pip there is never a window', () => {
  for (const t of [21, 27.5, 33]) {
    const s = frameState(t, noPip);
    assert.equal(s.collageBase, null);
    assert.ok(!s.collage.blocks.includes(PIP));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetProblems } from '../src/consistency.js';
import { PIP_ROOM } from '../src/collage.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../assets/${name}.json`, import.meta.url), 'utf8'));
const committed = {
  regions: load('regions'), strokes: load('strokes'), palette: load('palette'), score: load('score'), music: load('music'), collage: load('collage'),
  life: load('life'),
};
// a broken copy: change(copy) edits a deep copy of the committed assets
const broken = (change) => {
  const a = structuredClone(committed);
  change(a);
  return assetProblems(a);
};
const mentions = (problems, ...words) => problems.some((p) => words.every((w) => p.includes(w)));

test('assetProblems: the committed assets have none', () => {
  assert.deepEqual(assetProblems(committed), []);
});

test('assetProblems: a leaf without ink (make_regions.py run without make_flat.py)', () => {
  const id = committed.regions.leaves[7].id;
  const p = broken((a) => delete a.regions.leaves[7].ink);
  assert.ok(mentions(p, `leaf ${id}`, 'ink'), p.join('\n'));
  const all = broken((a) => a.regions.leaves.forEach((l) => { delete l.ink; delete l.tone; }));
  assert.ok(mentions(all, 'ink') && mentions(all, 'tone'), all.join('\n'));
  assert.ok(all.length < 40, `the list is capped: ${all.length} lines`);
});

test('assetProblems: an ink index out of range, a tone that is not a number', () => {
  const n = committed.palette.inks.length;
  const id = committed.regions.leaves[3].id;
  const p = broken((a) => { a.regions.leaves[3].ink = n; });
  assert.ok(mentions(p, `leaf ${id}`, 'ink', String(n)), p.join('\n'));
  assert.ok(mentions(broken((a) => { a.regions.leaves[3].ink = -1; }), `leaf ${id}`, 'ink'));
  assert.ok(mentions(broken((a) => { a.regions.leaves[3].ink = 1.5; }), `leaf ${id}`, 'ink'));
  assert.ok(mentions(broken((a) => { a.regions.leaves[3].tone = '0.3'; }), `leaf ${id}`, 'tone'));
  assert.ok(mentions(broken((a) => { a.regions.leaves[3].tone = NaN; }), `leaf ${id}`, 'tone'));
});

test('assetProblems: a score event naming a stroke or a leaf that does not exist', () => {
  const s = broken((a) => { a.score.strokes[12].s = 999999; });
  assert.ok(mentions(s, 'stroke', '999999'), s.join('\n'));
  const f = broken((a) => { a.score.flats[2].leaf = 88888; });
  assert.ok(mentions(f, 'flat', '88888'), f.join('\n'));
  const pc = broken((a) => { a.score.pieces[5].leaf = 77777; });
  assert.ok(mentions(pc, 'piece', '77777'), pc.join('\n'));
  const w = broken((a) => { a.score.washes[1].leaves.push(66666); });
  assert.ok(mentions(w, 'wash', '66666'), w.join('\n'));
  // the stroke file the score points into: a pencil stroke on a leaf that is gone
  const k = committed.strokes.strokes.findIndex((x) => !x.kind.startsWith('wire'));
  const st = broken((a) => { a.strokes.strokes[k].leaf = 55555; });
  assert.ok(mentions(st, 'stroke', '55555'), st.join('\n'));
  // a stroke the page cannot draw (fewer than two points)
  const id = committed.strokes.strokes[k].id;
  const short = broken((a) => { a.strokes.strokes[k].pts = [a.strokes.strokes[k].pts[0]]; });
  assert.ok(mentions(short, `stroke ${id}`, 'point'), short.join('\n'));
});

test('assetProblems: the pieces must be the leaves, one each', () => {
  const leaf = committed.score.pieces[9].leaf;
  const missing = broken((a) => a.score.pieces.splice(9, 1));
  assert.ok(mentions(missing, `leaf ${leaf}`, 'piece'), missing.join('\n'));
  const twice = broken((a) => { a.score.pieces[10].leaf = a.score.pieces[11].leaf; });
  assert.ok(mentions(twice, 'piece', String(committed.score.pieces[11].leaf)), twice.join('\n'));
});

test('assetProblems: material made from another region map', () => {
  // strokes.json and score.json carry the fingerprint of the region map they were made from
  const st = broken((a) => { a.strokes.regions = '0123456789abcdef'; });
  assert.ok(mentions(st, 'strokes', 'make_strokes'), st.join('\n'));
  const sc = broken((a) => { delete a.score.regions; });
  assert.ok(mentions(sc, 'score', 'make_score'), sc.join('\n'));
  const rg = broken((a) => { delete a.regions.fingerprint; });
  assert.ok(mentions(rg, 'make_regions'), rg.join('\n'));
});

test('assetProblems: the palette, the score and the music in their shapes', () => {
  assert.ok(mentions(broken((a) => { a.palette.inks = []; }), 'palette'));
  assert.ok(mentions(broken((a) => { a.palette.inks[2].hex = 'blue'; }), 'palette', 'blue'));
  assert.ok(mentions(broken((a) => { a.palette.paper = 12; }), 'palette', 'paper'));
  assert.ok(mentions(broken((a) => { a.score.camera = []; }), 'score', 'camera'));
  assert.ok(mentions(broken((a) => { delete a.score.glue; }), 'score', 'glue'));
  assert.ok(mentions(broken((a) => { a.score.pieces[0].style = 'drop'; }), 'piece', 'drop'));
  assert.ok(mentions(broken((a) => { delete a.music.sections.C; }), 'music', 'C'));
  assert.ok(mentions(broken((a) => { a.music.env = []; }), 'music', 'env'));
  // missing files altogether come back as problems, not exceptions
  assert.ok(assetProblems({}).length > 0);
});

test('assetProblems: the collage (assets/collage.json) fits the region map', () => {
  const { collage } = committed;
  assert.ok(collage.blocks.length > 0);
  // a block naming a leaf that the region map does not have
  const leaf = broken((a) => { a.collage.blocks[4].leaves.push(99999); });
  assert.ok(mentions(leaf, 'collage', collage.blocks[4].name, '99999'), leaf.join('\n'));
  // made from another region map
  const fp = broken((a) => { a.collage.regions = '0123456789abcdef'; });
  assert.ok(mentions(fp, 'collage', 'make_collage'), fp.join('\n'));
  // an accent that is not one of the picked cuts
  const acc = broken((a) => { a.collage.blocks[0].accent = a.collage.blocks[0].n; });
  assert.ok(mentions(acc, 'collage', collage.blocks[0].name, 'accent'), acc.join('\n'));
  // a cut without a file name, or with a tilt that is not a number
  for (const bad of [undefined, 7, '', null]) {
    const f = broken((a) => { a.collage.blocks[2].cuts[3].file = bad; });
    assert.ok(mentions(f, 'collage', collage.blocks[2].name, 'cut 3', 'file'), `${JSON.stringify(bad)}: ${f.join('\n')}`);
  }
  const t = broken((a) => { a.collage.blocks[2].cuts[1].tilt = '1.5'; });
  assert.ok(mentions(t, 'collage', collage.blocks[2].name, 'tilt'), t.join('\n'));
  // a box or margin that is not positive
  for (const bad of [[0, 300], [400], [-1, 300], 'big', undefined]) {
    const b = broken((a) => { a.collage.blocks[3].box = bad; });
    assert.ok(mentions(b, 'collage', collage.blocks[3].name, 'box'), `${JSON.stringify(bad)}: ${b.join('\n')}`);
  }
  for (const bad of [0, -8, '47', undefined]) {
    const m = broken((a) => { a.collage.blocks[3].margin = bad; });
    assert.ok(mentions(m, 'collage', collage.blocks[3].name, 'margin'), `${JSON.stringify(bad)}: ${m.join('\n')}`);
  }
  // what only records how a cut was made is not looked at (the page does not read it)
  assert.deepEqual(broken((a) => { a.collage.blocks[1].cuts[0].src = 7; a.collage.blocks[1].cuts[0].shift = 'warm'; }), []);
  // a missing collage is a problem, not an exception
  assert.ok(mentions(broken((a) => { delete a.collage; }), 'collage', 'make_collage'));
});

test('assetProblems: a collage block\'s bbox is four numbers, and every cut carries its bake key', () => {
  const { collage } = committed;
  // cutUV and the layer read the box: [x0, y0, x1, y1] with x0 < x1, y0 < y1
  for (const bad of [[0.1, 0.2, 0.3], 'box', undefined, [0.1, 0.2, 0.3, '0.6'], [0.5, 0.2, 0.3, 0.6], [0.1, 0.6, 0.3, 0.6]]) {
    const b = broken((a) => { a.collage.blocks[5].bbox = bad; });
    assert.ok(mentions(b, 'collage', collage.blocks[5].name, 'bbox'), `${JSON.stringify(bad)}: ${b.join('\n')}`);
  }
  // the key the page compares with assets/collage/baked.json (a sha1 from tools/make_collage.py)
  for (const bad of [undefined, '', 'abc', 7, null]) {
    const k = broken((a) => { a.collage.blocks[2].cuts[3].key = bad; });
    assert.ok(mentions(k, 'collage', collage.blocks[2].name, 'cut 3', 'key', 'make_collage'), `${JSON.stringify(bad)}: ${k.join('\n')}`);
  }
});

test('assetProblems: an accent block ends on its accent in every strength (a score left from other picks)', () => {
  const { score, collage } = committed;
  const accents = collage.blocks.map((b, row) => ({ b, row })).filter(({ b }) => b.accent >= 0);
  assert.ok(accents.length > 0, 'the committed collage has accent blocks');
  for (const k of Object.keys(score.collage.changes)) {
    for (const { b, row } of accents) {
      // the block's last change in this strength (its start when it has none) turned to another picked cut
      const p = broken((a) => {
        const ch = a.score.collage.changes[k];
        const own = ch.events.filter((e) => e.block === row);
        const other = (b.accent + 1) % b.n;
        if (own.length) own[own.length - 1].to = other;
        else ch.start[row] = other;
      });
      assert.ok(mentions(p, 'score', 'collage', k, b.name, 'accent', 'make_score'), `${k} ${b.name}: ${p.join('\n')}`);
    }
  }
  // a block without an accent may end anywhere
  const plain = collage.blocks.findIndex((b) => b.accent < 0);
  if (plain >= 0) {
    const k = Object.keys(score.collage.changes)[0];
    assert.deepEqual(broken((a) => { a.score.collage.changes[k].start[plain] = 0; a.score.collage.changes[k].events = a.score.collage.changes[k].events.filter((e) => e.block !== plain); }), []);
  }
});

test('assetProblems: the score\'s collage fits assets/collage.json', () => {
  const { score, collage } = committed;
  assert.equal(score.collage.blocks.length, collage.blocks.length);
  // a block row missing (the score was made from another collage list)
  const row = broken((a) => a.score.collage.blocks.splice(3, 1));
  assert.ok(mentions(row, 'score', 'collage', 'blocks', 'make_score'), row.join('\n'));
  const renamed = broken((a) => { a.score.collage.blocks[2].name = 'no_such_block'; });
  assert.ok(mentions(renamed, 'score', 'collage', 'no_such_block', 'make_score'), renamed.join('\n'));
  // a change to a cut the block does not have, in every strength
  for (const k of Object.keys(score.collage.changes)) {
    const ev = score.collage.changes[k].events[0];
    const n = collage.blocks[ev.block].cuts.length;
    const to = broken((a) => { a.score.collage.changes[k].events[0].to = n; });
    assert.ok(mentions(to, 'score', 'collage', k, collage.blocks[ev.block].name, String(n)), to.join('\n'));
    const start = broken((a) => { a.score.collage.changes[k].start[4] = collage.blocks[4].cuts.length; });
    assert.ok(mentions(start, 'score', 'collage', k, collage.blocks[4].name, 'start'), start.join('\n'));
    const block = broken((a) => { a.score.collage.changes[k].events[0].block = collage.blocks.length; });
    assert.ok(mentions(block, 'score', 'collage', k, 'block'), block.join('\n'));
  }
  // a leaf row naming a leaf that is not there, a leaf listed twice, a block leaf without a row
  const leaf = broken((a) => { a.score.collage.leaves[0].leaf = 99999; });
  assert.ok(mentions(leaf, 'score', 'collage', '99999'), leaf.join('\n'));
  const id = score.collage.leaves[1].leaf;
  const twice = broken((a) => { a.score.collage.leaves[0].leaf = id; });
  assert.ok(mentions(twice, 'score', 'collage', `leaf ${id}`), twice.join('\n'));
  const gone = score.collage.leaves[7].leaf;
  const missing = broken((a) => a.score.collage.leaves.splice(7, 1));
  assert.ok(mentions(missing, 'score', 'collage', `leaf ${gone}`), missing.join('\n'));
  const elsewhere = broken((a) => { a.score.collage.leaves[0].block = (a.score.collage.leaves[0].block + 1) % collage.blocks.length; });
  assert.ok(mentions(elsewhere, 'score', 'collage', `leaf ${score.collage.leaves[0].leaf}`), elsewhere.join('\n'));
  // the default strength is one of the strengths; a flat's until is a number
  const def = broken((a) => { a.score.collage.default = 'loud'; });
  assert.ok(mentions(def, 'score', 'collage', 'default', 'loud'), def.join('\n'));
  const until = broken((a) => { delete a.score.flats[3].until; });
  assert.ok(mentions(until, 'score', 'flat', 'until'), until.join('\n'));
});

test('assetProblems: the life map (assets/life.json) is made from the region map, its channels on its leaves', () => {
  const { life } = committed;
  assert.deepEqual(Object.keys(life.channels), ['flow', 'tremble', 'breath']);
  // made from another region map (or before it had a fingerprint)
  const fp = broken((a) => { a.life.regions = '0123456789abcdef'; });
  assert.ok(mentions(fp, 'life', 'make_life'), fp.join('\n'));
  assert.ok(mentions(broken((a) => { delete a.life.regions; }), 'life', 'make_life'));
  // a channel naming a leaf that the region map does not have, or without its leaves
  const leaf = broken((a) => { a.life.channels.tremble.leaves.push(99999); });
  assert.ok(mentions(leaf, 'life', 'tremble', '99999'), leaf.join('\n'));
  const none = broken((a) => { delete a.life.channels.breath; });
  assert.ok(mentions(none, 'life', 'breath', 'make_life'), none.join('\n'));
  // a missing life.json is a problem, not an exception
  assert.ok(mentions(broken((a) => { delete a.life; }), 'life', 'make_life'));
  assert.ok(mentions(broken((a) => { a.life = null; }), 'life', 'make_life'));
});

test('assetProblems: the picture in picture (score.pip) names the collage\'s blocks with their accents, at a time', () => {
  assert.ok(Array.isArray(committed.score.pip) && committed.score.pip.length === 3, 'the committed score has its three windows');
  const block = broken((a) => { a.score.pip[0].block = 99; });
  assert.ok(mentions(block, 'score', 'pip', '99', 'make_score'), block.join('\n'));
  assert.ok(mentions(broken((a) => { a.score.pip[1].block = 'blue_room'; }), 'score', 'pip'));
  const acc = broken((a) => { a.score.pip[2].accent = 3; });
  assert.ok(mentions(acc, 'score', 'pip', 'accent', 'make_score'), acc.join('\n'));
  assert.ok(mentions(broken((a) => { a.score.pip[0].t = '19.37'; }), 'score', 'pip', 't'));
  assert.ok(mentions(broken((a) => { a.score.pip = { t: 19.37 }; }), 'score', 'pip'));
  // a score without windows has no problem with them (no room is a window)
  assert.deepEqual(broken((a) => { delete a.score.pip; }), []);
});

test('assetProblems: windows need collage.json\'s block PIP_ROOM, whose box sizes the miniatures (renderer.js)', () => {
  assert.ok(committed.collage.blocks.some((b) => b.name === PIP_ROOM));
  const p = broken((a) => { a.collage.blocks.find((b) => b.name === PIP_ROOM).name = 'no_such_room'; });
  assert.ok(mentions(p, 'pip', PIP_ROOM, 'collage.json'), p.join('\n'));
});

test('assetProblems: the shake window must run forward', () => {
  assert.ok(mentions(broken((a) => { a.score.shake.to = 38; }), 'score', 'shake'));
  assert.ok(mentions(broken((a) => { a.score.shake = { from: 'x', to: 41 }; }), 'score', 'shake'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chooseCollageSet, collageFile, staleWeb, webScale } from '../src/collage_set.js';
import { usedCuts, halfPx, cutTexture, collageBytes } from '../src/collage.js';
import { cameraAt, strengths, frameState, PASTE } from '../src/timeline.js';
import { DUR } from '../src/music.js';
import { ZOOM_MIN, LIST, zoomSpans, fullSizePieces, listFor } from '../tools/full_size_pieces.mjs';
import { realScore } from './helpers.js';

const asset = (name) => JSON.parse(readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8'));

// the error chooseCollageSet throws: marked as the choice's (main.js tells it apart), its words in the message
const refused = (args, ...words) =>
  assert.throws(
    () => chooseCollageSet(args),
    (e) => {
      assert.equal(e.pieces, true);
      for (const w of words) assert.ok(e.message.includes(w), `${w} not in: ${e.message}`);
      return true;
    },
  );

test('chooseCollageSet: ?pieces= takes the set it names when the tree has it', () => {
  assert.equal(chooseCollageSet({ query: 'full', sets: ['full', 'web'] }), 'full');
  assert.equal(chooseCollageSet({ query: 'web', sets: ['full', 'web'] }), 'web');
  assert.equal(chooseCollageSet({ query: 'web', sets: ['web'] }), 'web');
  assert.equal(chooseCollageSet({ query: 'full', sets: ['full'] }), 'full');
});

test('chooseCollageSet: ?pieces= naming a set the tree does not have is a clear error, not the other set', () => {
  refused({ query: 'full', sets: ['web'] }, '?pieces=full', 'assets/collage/', 'pieces.json');
  refused({ query: 'web', sets: ['full'] }, '?pieces=web', 'assets/collage-web/', 'pieces.json');
  refused({ query: 'web', sets: [] }, '?pieces=web');
});

test('chooseCollageSet: without ?pieces= the originals when they are there, else the web set', () => {
  assert.equal(chooseCollageSet({ query: null, sets: ['full', 'web'] }), 'full');
  assert.equal(chooseCollageSet({ query: null, sets: ['web', 'full'] }), 'full');
  assert.equal(chooseCollageSet({ query: null, sets: ['full'] }), 'full');
  assert.equal(chooseCollageSet({ query: null, sets: ['web'] }), 'web');
  assert.equal(chooseCollageSet({ sets: ['web'] }), 'web'); // no query at all
  refused({ query: null, sets: [] }, 'no set', 'pieces.json');
});

test('chooseCollageSet: an unknown ?pieces= value or a broken pieces.json is an error naming it', () => {
  refused({ query: 'half', sets: ['full', 'web'] }, '?pieces=half', 'full', 'web');
  refused({ query: '', sets: ['full', 'web'] }, '?pieces=');
  refused({ query: 'FULL', sets: ['full', 'web'] }, '?pieces=FULL');
  refused({ query: null, sets: undefined }, 'pieces.json', 'sets');
  refused({ query: null, sets: 'web' }, 'pieces.json', 'sets');
  refused({ query: null, sets: ['web', 'jpeg'] }, 'pieces.json', 'jpeg');
});

test('collageFile: the originals in collage/ as baked.json names them, the web set in collage-web/ with .jpg (files of assets/)', () => {
  assert.equal(collageFile('full', 'b00_001.webp'), 'collage/b00_001.webp');
  assert.equal(collageFile('web', 'b00_001.webp'), 'collage-web/b00_001.jpg');
  assert.equal(collageFile('web', 'b24_047.webp'), 'collage-web/b24_047.jpg');
  assert.throws(() => collageFile('half', 'b00_001.webp'), /half/);
});

test('staleWeb: a cut web.json does not list, or lists with the key of another cut', () => {
  const list = [
    { row: 0, cut: 0, file: 'collage/b00_000.webp', key: 'aaa' },
    { row: 0, cut: 1, file: 'collage/b00_001.webp', key: 'bbb' },
    { row: 1, cut: 0, file: 'collage/b01_000.webp', key: 'ccc' },
  ];
  const web = {
    scale: 0.5,
    quality: 90,
    cuts: { 'b00_000.jpg': { key: 'aaa', w: 10, h: 6 }, 'b00_001.jpg': { key: 'old', w: 10, h: 6 }, 'b09_000.jpg': { key: 'zzz', w: 4, h: 4 } },
  };
  assert.deepEqual(
    staleWeb(list, web).map((s) => [s.cut.file, s.why]),
    [
      ['collage/b00_001.webp', 'made from another cut (web.json has another key)'],
      ['collage/b01_000.webp', 'not made (no entry in web.json)'],
    ],
  );
  web.cuts['b00_001.jpg'].key = 'bbb';
  web.cuts['b01_000.jpg'] = { key: 'ccc', w: 3, h: 3 };
  assert.deepEqual(staleWeb(list, web), []);
  // a cut without a key is never current; a list that is not web.json's shape: every cut
  assert.equal(staleWeb([{ ...list[0], key: undefined }], web).length, 1);
  assert.equal(staleWeb(list, null).length, 3);
  assert.equal(staleWeb(list, { cuts: ['b00_000.jpg'] }).length, 3);
  assert.equal(staleWeb(list, { 'b00_000.jpg': { key: 'aaa' } }).length, 3); // baked.json's shape
});

test('collage_set.js is pure: no DOM, no fetch, no clock', () => {
  const code = readFileSync(new URL('../src/collage_set.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const word of ['document', 'window', 'globalThis', 'location', 'fetch', 'performance', 'Date', 'Math.random']) {
    assert.ok(!new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(code), `src/collage_set.js uses ${word}`);
  }
  assert.doesNotMatch(code, /\bimport\b/);
});

// ---- the committed material (in the private repository and in the public tree alike)

test('assets/pieces.json names the sets whose folders are there, the originals first', () => {
  const pieces = asset('pieces.json');
  const there = (d) => {
    try {
      return statSync(new URL(`../assets/${d}`, import.meta.url)).isDirectory();
    } catch {
      return false;
    }
  };
  assert.deepEqual(pieces, { sets: [there('collage') && 'full', there('collage-web') && 'web'].filter(Boolean) });
  assert.ok(pieces.sets.includes('web'), 'the web set is in both trees');
});

test('assets/collage-web/web.json: a current web piece for every cut the score uses, full size where the list says so and half size elsewhere, and nothing else', () => {
  const web = asset('collage-web/web.json');
  const full = new Set(JSON.parse(readFileSync(new URL(`../${LIST}`, import.meta.url), 'utf8')).pieces);
  const used = usedCuts(asset('collage.json'), realScore().collage);
  assert.ok(used.length > 0);
  assert.deepEqual(staleWeb(used, web), []);
  assert.equal(web.scale, 0.5);
  assert.equal(web.quality, 90);
  let ones = 0;
  for (const c of used) {
    const name = c.file.slice(c.file.lastIndexOf('/') + 1);
    const e = web.cuts[collageFile('web', name).slice('collage-web/'.length)];
    const w = c.box[0] + 2 * c.margin;
    const h = c.box[1] + 2 * c.margin;
    assert.equal(e.scale, full.has(name) ? 1 : 0.5, c.file);
    assert.deepEqual([e.w, e.h], full.has(name) ? [w, h] : [halfPx(w), halfPx(h)], c.file);
    if (e.scale === 1) ones++;
  }
  assert.equal(ones, full.size);
  const names = used.map((c) => collageFile('web', c.file.slice(c.file.lastIndexOf('/') + 1)).slice('collage-web/'.length)).sort();
  assert.deepEqual(Object.keys(web.cuts).sort(), names);
  const files = readdirSync(new URL('../assets/collage-web/', import.meta.url)).filter((f) => f !== 'web.json').sort();
  assert.deepEqual(files, names);
});

// ---- the web set's full-size pieces (Task 1b, the owner's decision at gate 5a): the pieces the page draws
// on screen while the camera is pushed in to ZOOM_MIN or more (tools/full_size_pieces.mjs)

const realCollage = () => asset('collage.json');
const zoom = (score, t) => cameraAt(t, score.camera).zoom;
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);

test('zoomSpans: where the camera is at ZOOM_MIN or more, its ends found to well under a millisecond', () => {
  const camera = [{ t: 0, zoom: 1, c: [0.5, 0.5] }, { t: 2, zoom: 1.6, c: [0.5, 0.5], hold: 0.1, ease: 0.3 }];
  const spans = zoomSpans(camera, 5);
  assert.equal(spans.length, 1);
  const [from, to] = spans[0];
  assert.ok(Math.abs(from - 2) < 1e-6, from);
  assert.ok(to > 2.1 && to < 2.4, to);
  assert.ok(cameraAt(to - 1e-6, camera).zoom >= ZOOM_MIN && cameraAt(to + 1e-6, camera).zoom < ZOOM_MIN, to);
  assert.deepEqual(zoomSpans([{ t: 0, zoom: 1, c: [0.5, 0.5] }], 5), []);
  assert.deepEqual(zoomSpans([{ t: 0, zoom: 2, c: [0.5, 0.5] }], 5), [[0, 5]]);
});

test('zoomSpans (committed score): the opening, before any collage, and the punch-in after the strike; not the glue chord', () => {
  const score = realScore();
  const spans = zoomSpans(score.camera, DUR);
  assert.equal(spans.length, 2, JSON.stringify(spans));
  const [[a0, b0], [a1, b1]] = spans;
  // the opening: the camera from 8x down to 2x, then the cut to 1x
  const cut = score.camera.find((e) => e.zoom < ZOOM_MIN && e.hold === undefined && e.t > 0);
  assert.equal(a0, 0);
  assert.ok(Math.abs(b0 - cut.t) < 1e-6, `${b0} ${cut.t}`);
  assert.ok(score.collage.blocks.every((b) => b.first > b0), 'no collage block shows in the opening');
  // the punch-in: the camera row with a hold and a zoom of ZOOM_MIN or more; the glue chord's (1.04) is not one
  const punch = score.camera.filter((e) => e.hold !== undefined && e.zoom >= ZOOM_MIN);
  assert.equal(punch.length, 1);
  assert.ok(Math.abs(a1 - punch[0].t) < 1e-6, `${a1} ${punch[0].t}`);
  assert.ok(zoom(score, 2061 / 60) >= ZOOM_MIN && zoom(score, 2062 / 60) < ZOOM_MIN);
  assert.ok(b1 > 2061 / 60 && b1 < 2062 / 60, b1);
  assert.ok(score.camera.some((e) => e.hold !== undefined && e.zoom < ZOOM_MIN), 'the glue chord pushes in below ZOOM_MIN');
});

// The cuts a block shows on the canvas over [a, b], read from the score alone (score.collage.changes and
// score.pip): the one it shows at a (its start, or the last change at or before a; none before its first),
// the one a change is still being pasted over (PASTE after it), and at each change in (a, b] (or its
// first) the same. A glass room of score.pip is a window from its time P until its accent comes (E: its
// first change to the accent at or after P; never for an accent of -1): the canvas shows the miniature
// there, not a cut, but for the cut it is pasted over while it is pasted; and while the accent is pasted
// over the window, what it is pasted over is the miniature.
function cutsByScore(score, strength, row, a, b) {
  const col = score.collage;
  const first = col.blocks[row].first;
  if (first > b) return [];
  const ch = col.changes[strength];
  const evs = ch.events.filter((e) => e.block === row);
  const pip = (score.pip || []).find((p) => p.block === row);
  const accentAt = pip && pip.accent >= 0 ? evs.find((e) => e.to === pip.accent && e.t >= pip.t) : undefined;
  const E = accentAt ? accentAt.t : Infinity;
  const plain = (t, list = evs) => {
    const done = list.filter((e) => e.t <= t);
    const last = done[done.length - 1];
    const cur = last ? last.to : ch.start[row];
    const prev = last && t - last.t < PASTE ? (done.length > 1 ? done[done.length - 2].to : ch.start[row]) : -1;
    return { cur, prev, last };
  };
  const at = (t) => {
    if (t < first) return [];
    if (pip && t >= pip.t && t < E) {
      // a window; while it is pasted, the cut that showed just before it
      return t - pip.t < PASTE && pip.t > first ? [plain(pip.t, evs.filter((e) => e.t < pip.t)).cur] : [];
    }
    const { cur, prev, last } = plain(t);
    const overWindow = pip && last === accentAt; // the accent pasted over the window: prev is the miniature
    return [cur, overWindow ? -1 : prev].filter((k) => k >= 0);
  };
  const out = new Set(at(a));
  for (const e of evs) if (e.t > a && e.t <= b) for (const k of at(e.t)) out.add(k);
  if (first > a) for (const k of at(first)) out.add(k);
  return [...out];
}

test('fullSizePieces (committed score): the pieces drawn in the punch-in, counted again from the score', () => {
  const score = realScore();
  const collage = realCollage();
  const r = fullSizePieces(score, collage, DUR);
  const [from, to] = zoomSpans(score.camera, DUR)[1];
  const union = new Set();
  for (const s of strengths(score)) {
    // a block is drawn in the span unless every leaf of it is gone at its start (torn off, or covered by its
    // photo: neither comes back) or comes after its end
    const st = frameState(from, score, { strength: s }).collage;
    const drawnBlock = (row) =>
      score.collage.leaves.some((ev, i) => ev.block === row && (ev.t > from ? ev.t <= to : st.leaves[i * 4] > 0 && st.tear[i] < 1));
    const want = new Set();
    collage.blocks.forEach((b, row) => {
      if (!drawnBlock(row)) return;
      for (const k of cutsByScore(score, s, row, from, to)) want.add(baseName(b.cuts[k].file));
    });
    assert.deepEqual([...r.strengths[s]].sort(), [...want].sort(), s);
    assert.ok(want.size >= 20, `${s}: ${want.size}`);
    for (const n of want) union.add(n);
  }
  assert.deepEqual(r.pieces, [...union].sort());
  // a few by name: block 0's cut through the punch-in, and both cuts of a block that changes during it
  const b0 = collage.blocks[0].cuts[cutsByScore(score, 'high', 0, from, to)[0]].file;
  assert.ok(r.strengths.high.includes(baseName(b0)), b0);
  const change = score.collage.changes.high.events.find((e) => e.t > from && e.t <= to);
  assert.ok(change, 'a block changes during the punch-in');
  const both = cutsByScore(score, 'high', change.block, change.t, change.t);
  assert.equal(both.length, 2);
  for (const k of both) assert.ok(r.strengths.high.includes(baseName(collage.blocks[change.block].cuts[k].file)), String(k));
  // every piece is one the score uses (a baked original, a web piece)
  const used = new Set(usedCuts(collage, score.collage).map((c) => baseName(c.file)));
  for (const n of r.pieces) assert.ok(used.has(n), n);
});

test(`${LIST}: the committed list is the one the score and the collage's list make now`, () => {
  const scoreBytes = readFileSync(new URL('../assets/score.json', import.meta.url));
  const collageBytes = readFileSync(new URL('../assets/collage.json', import.meta.url));
  const committed = JSON.parse(readFileSync(new URL(`../${LIST}`, import.meta.url), 'utf8'));
  assert.deepEqual(committed, listFor(scoreBytes, collageBytes));
  assert.equal(committed.inputs['assets/score.json'], createHash('sha256').update(scoreBytes).digest('hex'));
});

test("webScale: a web piece's own scale, else the list's (0.5): 1 or 0.5, anything else null", () => {
  const web = { scale: 0.5, quality: 90, cuts: {} };
  assert.equal(webScale(web, { key: 'k', scale: 1, w: 2, h: 2 }), 1);
  assert.equal(webScale(web, { key: 'k', scale: 0.5, w: 1, h: 1 }), 0.5);
  assert.equal(webScale(web, { key: 'k', w: 1, h: 1 }), 0.5);
  assert.equal(webScale({ ...web, scale: 1 }, { key: 'k' }), 1);
  for (const s of [2, 0.25, '1', null]) assert.equal(webScale(web, { key: 'k', scale: s }), null, String(s));
  assert.equal(webScale(web, undefined), null);
});

test('staleWeb: a piece web.json gives a scale it cannot have', () => {
  const list = [{ row: 0, cut: 0, file: 'collage/b00_000.webp', key: 'aaa' }];
  assert.deepEqual(staleWeb(list, { scale: 0.5, cuts: { 'b00_000.jpg': { key: 'aaa', scale: 1, w: 9, h: 9 } } }), []);
  const bad = staleWeb(list, { scale: 0.5, cuts: { 'b00_000.jpg': { key: 'aaa', scale: 0.3, w: 9, h: 9 } } });
  assert.equal(bad.length, 1);
  assert.ok(bad[0].why.includes('scale'), bad[0].why);
});

test('cutTexture: the original as it is or decoded at half size; a web piece at the size its scale gives, whatever tex says', () => {
  const c = { box: [101, 55], margin: 1 }; // 103 x 57
  assert.deepEqual(cutTexture(c), { w: 103, h: 57, decode: 'as is' });
  assert.deepEqual(cutTexture(c, { set: 'full', tex: 'half' }), { w: 52, h: 29, decode: 'half' });
  assert.deepEqual(cutTexture(c, { set: 'web', scale: 0.5 }), { w: 52, h: 29, decode: 'as is' });
  assert.deepEqual(cutTexture(c, { set: 'web', scale: 0.5, tex: 'half' }), { w: 52, h: 29, decode: 'as is' });
  assert.deepEqual(cutTexture(c, { set: 'web', scale: 1 }), { w: 103, h: 57, decode: 'as is' });
  assert.deepEqual(cutTexture(c, { set: 'web', scale: 1, tex: 'half' }), { w: 103, h: 57, decode: 'as is' });
  assert.throws(() => cutTexture(c, { set: 'web', scale: 0.3 }), /scale/);
});

test('collageBytes: each cut at its own size when the size is given per cut', () => {
  const a = { box: [101, 55], margin: 1 };
  const b = { box: [10, 10], margin: 0 };
  const per = (c) => (c === a ? 'full' : 'half');
  assert.equal(collageBytes([a, b], per), (103 * 57 + 5 * 5) * 4 * (4 / 3));
});

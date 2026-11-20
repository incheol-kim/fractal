import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cutUV, collageBytes, halfPx, memoryNotice, lostCollageNotice, decodeNotice, usedCuts, staleCuts, acrossOutline, coverAcross, openAcross, OWN_RIM_MIN,
  tearMotion, TEAR_FADE, pipHeight, pipUV, pipSizes, pipBytes, PIP, PIP_FIT, PIP_LEVELS, PIP_SS,
} from '../src/collage.js';
import { closedRibbon } from '../src/geometry.js';

// The amendment's example: the box [0.25, 0.25, 0.75, 0.75] is 1930 x 1080 px at 4K
// (collage_lib.box_and_margin), its margin 47 px, so the baked cut is 2024 x 1174.
const block = { bbox: [0.25, 0.25, 0.75, 0.75], box: [1930, 1080], margin: 47 };
const TW = 2024;
const TH = 1174;
const at = (m, x, y) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
const near = (got, want, what, eps = 1e-9) => {
  assert.ok(Math.abs(got[0] - want[0]) <= eps && Math.abs(got[1] - want[1]) <= eps, `${what}: [${got}] is not [${want}]`);
};

test('cutUV: tilt 0 lays the box on the middle bw x bh pixels of the baked cut', () => {
  const m = cutUV(block, 0, 1);
  assert.equal(m.length, 6);
  near(at(m, 0.25, 0.25), [47 / TW, 47 / TH], 'top left corner');
  near(at(m, 0.75, 0.75), [1977 / TW, 1127 / TH], 'bottom right corner');
  near(at(m, 0.5, 0.5), [0.5, 0.5], 'centre');
  near(at(m, 0.75, 0.25), [1977 / TW, 47 / TH], 'top right corner');
});

test('cutUV: the content turns by tilt x loose about the box centre, as on the sheets', () => {
  const m = cutUV(block, 2, 1);
  near(at(m, 0.5, 0.5), [0.5, 0.5], 'centre');
  // the middle of the box's right side, in baked px from the centre
  const [u, v] = at(m, 0.75, 0.5);
  const du = (u - 0.5) * TW;
  const dv = (v - 0.5) * TH;
  assert.ok(Math.abs(Math.hypot(du, dv) - 1930 / 2) <= 1e-6, `distance ${Math.hypot(du, dv)}`);
  // cv2.getRotationMatrix2D: a positive tilt turns the content counter-clockwise on the screen, so
  // the screen point right of the centre shows the cut's point 2 degrees clockwise of its right
  // (y down: below the horizontal)
  assert.ok(Math.abs((Math.atan2(dv, du) * 180) / Math.PI - 2) <= 1e-9, `angle ${(Math.atan2(dv, du) * 180) / Math.PI}`);
  // the same the other way round for a negative tilt, and loose scales the angle
  const n = at(cutUV(block, -2, 1), 0.75, 0.5);
  assert.ok(Math.abs((Math.atan2((n[1] - 0.5) * TH, (n[0] - 0.5) * TW) * 180) / Math.PI + 2) <= 1e-9);
  const h = at(cutUV(block, 2, 0.5), 0.75, 0.5);
  assert.ok(Math.abs((Math.atan2((h[1] - 0.5) * TH, (h[0] - 0.5) * TW) * 180) / Math.PI - 1) <= 1e-9);
});

test('cutUV: the tilt does not grow past loose 1 (the baked margin holds a tilt of 2 degrees only)', () => {
  assert.deepEqual(cutUV(block, 2, 1.5), cutUV(block, 2, 1));
  assert.deepEqual(cutUV(block, -2, 1.2), cutUV(block, -2, 1));
});

test('cutUV: loose 0 is the same as tilt 0', () => {
  const flat = cutUV(block, 0, 1);
  const pressed = cutUV(block, 1.59, 0);
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(flat[i] - pressed[i]) <= 1e-12, `${i}: ${flat[i]} vs ${pressed[i]}`);
});

test('tearMotion: the fragment leaves from its first frame, slows as it goes and fades from TEAR_FADE on (a start value)', () => {
  assert.deepEqual(tearMotion(0), [0, 1]);
  const [m1, f1] = tearMotion(1);
  assert.equal(m1, 1);
  assert.equal(f1, 0);
  // at 60 fps a tear (timeline.js TEAR = 8 / 60) is 8 frames: already well on its way after one
  assert.ok(tearMotion(1 / 8)[0] > 0.2, `${tearMotion(1 / 8)[0]}`);
  const steps = 120;
  const at = (i) => tearMotion(i / steps);
  for (let i = 0; i <= steps; i++) {
    const tear = i / steps;
    const [move, fade] = at(i);
    assert.ok(move >= 0 && move <= 1 && fade >= 0 && fade <= 1, `${tear}: ${move}, ${fade}`);
    if (tear <= TEAR_FADE) assert.equal(fade, 1, `whole until TEAR_FADE (${tear})`);
    else assert.ok(fade < 1, `fading after TEAR_FADE (${tear})`);
    if (i === 0) continue;
    assert.ok(move > at(i - 1)[0], `move rises (${tear})`);
    assert.ok(fade <= at(i - 1)[1], `fade falls (${tear})`);
    // eases out: each step goes no farther than the one before
    if (i >= 2) assert.ok(move - at(i - 1)[0] <= at(i - 1)[0] - at(i - 2)[0] + 1e-12, `slows (${tear})`);
  }
  // out of range is clamped
  assert.deepEqual(tearMotion(-0.5), [0, 1]);
  assert.deepEqual(tearMotion(1.5), [1, 0]);
});

test('collageBytes: (bw + 2m) x (bh + 2m) x 4 x 4/3 for each cut loaded; at half size the textures as they are', () => {
  const cut = { box: [1930, 1080], margin: 47 };
  const small = { box: [118, 145], margin: 12 };
  const full = 2024 * 1174 * 4 * (4 / 3) * 3 + 142 * 169 * 4 * (4 / 3);
  assert.ok(Math.abs(collageBytes([cut, cut, cut, small]) - full) < 1e-3);
  assert.ok(Math.abs(collageBytes([cut, cut, cut, small], 'full') - full) < 1e-3);
  // half of each side rounded half up (halfPx): 1012 x 587 and 71 x 85 (169 / 2 = 84.5), not a quarter of 142 x 169
  const half = 1012 * 587 * 4 * (4 / 3) * 3 + 71 * 85 * 4 * (4 / 3);
  assert.ok(Math.abs(collageBytes([cut, cut, cut, small], 'half') - half) < 1e-3);
  assert.notEqual(half, full / 4);
  assert.equal(collageBytes([]), 0);
});

test('halfPx: half a side rounded half up, at least 1 (the page decodes at this size; tools/make_collage_web.py half())', () => {
  assert.deepEqual([57, 101, 1, 2, 3, 64, 2024, 1174, 169].map(halfPx), [29, 51, 1, 1, 2, 32, 1012, 587, 85]);
});

test('memoryNotice: the size in GB, the GPU and a link to the half-size pictures', () => {
  const gpu = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const m = memoryNotice(1.5e9, gpu, 'http://localhost:5173/');
  assert.equal(typeof m, 'string');
  assert.ok(m.includes('1.4 GB'), m); // 1.5e9 / 2^30 = 1.397
  assert.ok(m.includes(gpu), m);
  assert.ok(m.includes('http://localhost:5173/?tex=half'), m);
  const kept = memoryNotice(1.5e9, gpu, 'http://localhost:5173/?hud=1#t=20');
  assert.ok(kept.includes('http://localhost:5173/?hud=1&tex=half#t=20'), kept);
});

test('memoryNotice: no link once the page is on tex=half', () => {
  const gpu = 'ANGLE (NVIDIA …)';
  const m = memoryNotice(1.5e9 / 4, gpu, 'http://localhost:5173/?tex=half&hud=1#t=20');
  assert.ok(m.includes('0.3 GB'), m);
  assert.ok(m.includes(gpu), m);
  assert.ok(!m.includes('http'), m);
  assert.ok(!m.includes('tex=half'), m);
});

test('lostCollageNotice: a lost context with the collage on the GPU: memory may be the cause, not surely', () => {
  const gpu = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const m = lostCollageNotice(1.5e9, gpu, 'http://localhost:5173/?hud=1#t=20');
  assert.ok(m.includes('1.4 GB'), m);
  assert.ok(m.includes(gpu), m);
  assert.ok(m.includes('may have used up the memory'), m);
  assert.ok(!m.includes('Out of graphics memory'), m); // not memoryNotice's certain cause
  assert.ok(m.includes('http://localhost:5173/?hud=1&tex=half#t=20'), m);
  const h = lostCollageNotice(1.5e9 / 4, gpu, 'http://localhost:5173/?tex=half');
  assert.ok(h.includes('0.3 GB') && !h.includes('http'), h);
});

test('decodeNotice: a cut that could not be decoded: the file, the size of the collage and the half-size link, no bake advice', () => {
  const m = decodeNotice('collage/b03_007.webp', 'EncodingError: The source image cannot be decoded.', 1.5e9, 'http://localhost:5173/?hud=1#t=20');
  assert.ok(m.includes('assets/collage/b03_007.webp'), m);
  assert.ok(m.includes('cannot be decoded'), m);
  assert.ok(m.includes('1.4 GB'), m);
  assert.ok(m.includes('http://localhost:5173/?hud=1&tex=half#t=20'), m);
  assert.ok(!m.includes('--bake'), m);
  const h = decodeNotice('collage/b03_007.webp', 'x', 1.5e9 / 4, 'http://localhost:5173/?tex=half');
  assert.ok(h.includes('0.3 GB') && !h.includes('http'), h);
});

// The web set's pieces are lighter already (half size for most of the piece) and ?tex=half leaves them so
// (assets.js getCut): with that set the notices say so and offer ?tex=half for the other big pictures only.
// With the originals (and before the set is known) they are word for word what they were.
test('the collage notices with the web set: the pieces are lighter already; ?tex=half for the other pictures', () => {
  const gpu = 'ANGLE (NVIDIA …)';
  const href = 'http://localhost:5173/fractal/?hud=1#t=20';
  const link = 'http://localhost:5173/fractal/?hud=1&tex=half#t=20';
  const already = 'The collage pieces are already the lighter web set, half size for most of the piece.';
  const notices = [
    (set, h) => memoryNotice(4e8, gpu, h, set),
    (set, h) => lostCollageNotice(4e8, gpu, h, set),
    (set, h) => decodeNotice('collage-web/b03_007.jpg', 'x', 4e8, h, set),
  ];
  for (const notice of notices) {
    const w = notice('web', href);
    assert.ok(w.includes(already), w);
    assert.ok(w.includes(link), w);
    assert.ok(w.includes('other large pictures'), w);
    assert.ok(!w.includes('Open with half-size pictures'), w); // halfHint's offer, which would halve the pieces
    const on = notice('web', 'http://localhost:5173/fractal/?tex=half');
    assert.ok(on.includes(already) && !on.includes('http'), on);
    assert.ok(on.includes('The other large pictures are already at half size too.'), on);
    // the originals and an unknown set: as before
    for (const set of ['full', null, undefined]) {
      assert.equal(notice(set, href), notice('full', href));
      assert.ok(!notice(set, href).includes(already));
    }
  }
  assert.equal(memoryNotice(4e8, gpu, href, 'full'), memoryNotice(4e8, gpu, href));
  assert.equal(lostCollageNotice(4e8, gpu, href, 'full'), lostCollageNotice(4e8, gpu, href));
  assert.equal(decodeNotice('collage/b03_007.webp', 'x', 4e8, href, 'full'), decodeNotice('collage/b03_007.webp', 'x', 4e8, href));
});

test('acrossOutline: the leaf of the block just outside each outline point, or -1', () => {
  // A (0..10) with a hole (6..8 x 3..5), B right of it (10..20), C below it (0..10 x 10..20)
  const ring = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]];
  const hole = [[6, 3], [8, 3], [8, 5], [6, 5]];
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const others = [
    { polys: [sq(10, 0, 20, 10)], box: [10, 0, 20, 10] },
    { polys: [sq(0, 10, 10, 20)], box: [0, 10, 10, 20] },
  ];
  const own = [ring, hole];
  const rib = closedRibbon(ring);
  const nb = acrossOutline(rib, own, others);
  assert.equal(nb.length, rib.points.length);
  const at = (x, y) => nb[rib.points.findIndex((p) => p[0] === x && p[1] === y)];
  assert.equal(at(10, 5), 0, 'right edge: B');
  assert.equal(at(5, 10), 1, 'bottom edge: C');
  assert.equal(at(5, 0), -1, 'top edge: nothing');
  assert.equal(at(0, 5), -1, 'left edge: nothing');
  assert.equal(at(10, 0), -1, 'a corner looks along its mitre: past B');
  // a hole's outline: the outside of the leaf is the hole, where no leaf of the block is
  const h = acrossOutline(closedRibbon(hole), own, others);
  assert.ok(h.every((v) => v === -1), `${[...h]}`);
  // a box that does not hold the point is not looked into
  const far = acrossOutline(rib, own, [{ polys: others[0].polys, box: [30, 30, 40, 40] }]);
  assert.equal(far[rib.points.findIndex((p) => p[0] === 10 && p[1] === 5)], -1);
});

test('openAcross: the torn edge along a leaf of the block is shut while that leaf is pasted, opens as its rim fades, open once it is gone', () => {
  assert.equal(openAcross(1, 1), 0);
  assert.equal(openAcross(1, 0.25), 0.75);
  assert.equal(openAcross(1, 0), 1);
  assert.equal(openAcross(0, 1), 1);
});

test('coverAcross: a leaf covers the outline it shares with its block by its rim while the block mesh draws it, not at all once it does not', () => {
  assert.equal(coverAcross(1, 1), 1);
  assert.equal(coverAcross(1, 0.3), 0.3);
  assert.equal(coverAcross(1, 0), 0);
  assert.equal(coverAcross(0, 0.3), 0);
  assert.equal(coverAcross(0, 1), 0);
});

test('openAcross with the leaf\'s own rim: the white along the outline is max(0, own - cover), no seam between leaves that develop together', () => {
  const rims = [0, 1e-4, OWN_RIM_MIN, 0.0111, 0.25, 0.5, 0.75, 0.9857, 1];
  const owns = [OWN_RIM_MIN, 2 * OWN_RIM_MIN, 0.0111, 0.0333, 0.25, 0.5, 0.75, 1];
  // own 1 (a leaf that is not developing): the brief's rule, 1 - rim while the leaf across is drawn, 1 once it is not
  for (const rim of rims) {
    assert.equal(openAcross(1, rim, 1), openAcross(1, rim), `default own (${rim})`);
    assert.ok(Math.abs(openAcross(1, rim, 1) - (1 - rim)) <= 1e-12, `1 - rim (${rim})`);
    assert.equal(openAcross(0, rim, 1), 1, `gone (${rim})`);
  }
  // the white the edge shows (its opacity is the own rim times how far it is open) is own - cover, never below 0
  for (const own of owns) {
    for (const rim of rims) {
      const cover = coverAcross(1, rim);
      assert.ok(Math.abs(own * openAcross(1, rim, own) - Math.max(0, own - cover)) <= 1e-12, `own ${own}, cover ${cover}`);
    }
    assert.equal(openAcross(0, 0.5, own), 1, `nothing across: open (own ${own})`);
  }
  // continuous at the moment the leaf across goes: its cover falls to 0 with its rim, then it is 0
  for (const own of owns) {
    const r = 1e-6;
    assert.ok(Math.abs(openAcross(1, r, own) - openAcross(0, r, own)) <= r / own + 1e-12, `own ${own}`);
  }
  // two leaves with the same rim: shut at every moment, below OWN_RIM_MIN too
  for (const r of [1e-9, 1e-6, OWN_RIM_MIN / 2, OWN_RIM_MIN, 0.0111, 0.5, 0.9857, 1]) assert.equal(openAcross(1, r, r), 0, `same rim ${r}`);
  // as the own rim falls to 0 (OWN_RIM_MIN keeps it from dividing by 0) the white shown moves by at
  // most twice as much as the rim does, and is never more than own - cover
  const step = OWN_RIM_MIN / 100;
  for (const cover of [0, OWN_RIM_MIN / 4, OWN_RIM_MIN / 2, OWN_RIM_MIN, 2 * OWN_RIM_MIN]) {
    let last = null;
    for (let k = 400; k >= 0; k--) {
      const own = k * step;
      const shown = own * openAcross(1, cover, own);
      assert.ok(Number.isFinite(shown) && shown >= 0 && shown <= Math.max(0, own - cover) + 1e-15, `cover ${cover}, own ${own}: ${shown}`);
      if (last !== null) assert.ok(Math.abs(shown - last) <= 2 * step + 1e-15, `cover ${cover}, own ${own}: ${last} -> ${shown}`);
      last = shown;
    }
  }
});

test('usedCuts: every cut a strength starts on or changes to, once, by block then cut', () => {
  const collage = {
    blocks: [
      { box: [10, 20], margin: 3, cuts: [0, 1, 2, 3].map((k) => ({ file: `collage/b00_00${k}.webp`, tilt: 0, key: `key0${k}` })) },
      { box: [30, 40], margin: 5, cuts: [0, 1, 2].map((k) => ({ file: `collage/b01_00${k}.webp`, tilt: 0, key: `key1${k}` })) },
    ],
  };
  const sc = {
    changes: {
      calm: { start: [0, 0], events: [{ t: 1, block: 1, to: 1 }] },
      high: { start: [0, 2], events: [{ t: 1, block: 0, to: 3 }, { t: 2, block: 1, to: 1 }, { t: 3, block: 0, to: 1 }] },
    },
  };
  const used = usedCuts(collage, sc);
  assert.deepEqual(
    used.map((c) => [c.row, c.cut, c.file]),
    [
      [0, 0, 'collage/b00_000.webp'],
      [0, 1, 'collage/b00_001.webp'],
      [0, 3, 'collage/b00_003.webp'],
      [1, 0, 'collage/b01_000.webp'],
      [1, 1, 'collage/b01_001.webp'],
      [1, 2, 'collage/b01_002.webp'],
    ],
  );
  assert.deepEqual(used[4].box, [30, 40]);
  assert.equal(used[4].margin, 5);
  // each carries its cut's bake key, for the check against baked.json (staleCuts)
  assert.deepEqual(used.map((c) => c.key), ['key00', 'key01', 'key03', 'key10', 'key11', 'key12']);
  assert.deepEqual(usedCuts(collage, null), []);
});

test('staleCuts: a cut whose file baked.json does not record, or records with the key of another cut', () => {
  const list = [
    { row: 0, cut: 0, file: 'collage/b00_000.webp', key: 'aaa' },
    { row: 0, cut: 1, file: 'collage/b00_001.webp', key: 'bbb' },
    { row: 1, cut: 0, file: 'collage/b01_000.webp', key: 'ccc' },
  ];
  const baked = { 'b00_000.webp': 'aaa', 'b00_001.webp': 'old', 'b09_000.webp': 'zzz' };
  assert.deepEqual(
    staleCuts(list, baked).map((s) => [s.cut.file, s.why]),
    [
      ['collage/b00_001.webp', 'baked from another cut'],
      ['collage/b01_000.webp', 'not baked (no key in baked.json)'],
    ],
  );
  assert.deepEqual(staleCuts(list, { 'b00_000.webp': 'aaa', 'b00_001.webp': 'bbb', 'b01_000.webp': 'ccc' }), []);
  // a cut without a key (a list from before the keys) is never taken for current
  assert.equal(staleCuts([{ ...list[0], key: undefined }], baked).length, 1);
  // baked.json not an object: every cut
  assert.equal(staleCuts(list, null).length, 3);
  assert.equal(staleCuts(list, ['aaa']).length, 3);
});

test('PIP and its starting values: the miniature is not a cut position, 93 % of the fit, three levels, 1.25 texels per px', () => {
  assert.equal(PIP, -2);
  assert.equal(PIP_FIT, 0.93);
  assert.equal(PIP_LEVELS, 3);
  assert.equal(PIP_SS, 1.25);
});

test('pipHeight: the screen fits the box on its tighter side, times PIP_FIT', () => {
  assert.ok(Math.abs(pipHeight(160, 90, 16 / 9) - 90 * 0.93) <= 1e-9, `${pipHeight(160, 90, 16 / 9)}`);
  // a box wider than the screen: its height decides; a taller one: its width
  assert.ok(Math.abs(pipHeight(200, 90, 16 / 9) - 83.7) <= 1e-9, `${pipHeight(200, 90, 16 / 9)}`);
  assert.ok(Math.abs(pipHeight(160, 120, 16 / 9) - 83.7) <= 1e-9, `${pipHeight(160, 120, 16 / 9)}`);
  assert.ok(Math.abs(pipHeight(160, 90, 16 / 9, 1) - 90) <= 1e-9);
});

test('pipUV: the box centre goes to the miniature\'s centre, v up (a render target), the box\'s edges are bezel', () => {
  const m = pipUV({ bbox: [0.4, 0.3, 0.6, 0.5] }, 16 / 9, 2944 / 1648);
  assert.equal(m.length, 6);
  near(at(m, 0.5, 0.4), [0.5, 0.5], 'centre');
  const [uL] = at(m, 0.4, 0.4);
  const [uR] = at(m, 0.6, 0.4);
  const [, vT] = at(m, 0.5, 0.3);
  const [, vB] = at(m, 0.5, 0.5);
  assert.ok(uL > -0.06 && uL < 0, `left edge u ${uL}`);
  assert.ok(uR > 1 && uR < 1.06, `right edge u ${uR}`);
  assert.ok(vT > 1 && vT < 1.06, `top edge v ${vT} (upright: the picture's top is the texture's top)`);
  assert.ok(vB > -0.06 && vB < 0, `bottom edge v ${vB}`);
  // the miniature keeps the screen's aspect: one picture unit across is aspect times as far in u as in v, per screen
  const A = 2944 / 1648;
  assert.ok(Math.abs(m[0] / A / -m[4] - 1 / (16 / 9)) <= 1e-12, 'aspect');
});

test('pipSizes: the miniatures\' targets for the central room of the committed collage, as the spike measured', () => {
  const collage = JSON.parse(readFileSync(new URL('../assets/collage.json', import.meta.url), 'utf8'));
  const room = collage.blocks.find((b) => b.name === 'glass_room');
  const pic = { w: 2944, h: 1648 };
  assert.deepEqual(pipSizes(3840, 2160, room.bbox, pic), [[752, 423], [148, 83], [28, 16]]);
  assert.deepEqual(pipSizes(1920, 1080, room.bbox, pic), [[375, 211], [73, 41], [14, 8]]);
  assert.equal(pipSizes(1920, 1080, room.bbox, pic, 2).length, 2);
  // never below 8 px high, the width from that height
  assert.deepEqual(pipSizes(64, 36, room.bbox, pic).at(-1), [14, 8]);
});

test('pipBytes: per level 4x MSAA colour and depth, the mipmapped colour, its ground\'s colour and depth', () => {
  assert.equal(pipBytes([[752, 423], [148, 83], [28, 16]]), (752 * 423 + 148 * 83 + 28 * 16) * (16 + 16 + 16 / 3 + 8));
  assert.equal(pipBytes([]), 0);
});

test('usedCuts: the committed score, against the cuts counted from the score itself (all strengths and each one)', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../assets/${f}`, import.meta.url), 'utf8'));
  const collage = read('collage.json');
  const score = read('score.json');
  const changes = score.collage.changes;
  const names = Object.keys(changes);
  assert.ok(names.length > 0, 'the score has no collage strength');
  // every (block, cut) a strength starts on or changes to, counted here without usedCuts
  const pairs = (list) => {
    const s = new Set();
    for (const ch of list) {
      ch.start.forEach((cut, block) => s.add(`${block}:${cut}`));
      for (const e of ch.events) s.add(`${e.block}:${e.to}`);
    }
    return s;
  };
  const used = usedCuts(collage, score.collage);
  const all = pairs(Object.values(changes));
  assert.equal(used.length, all.size);
  assert.deepEqual(new Set(used.map((c) => `${c.row}:${c.cut}`)), all);
  for (const name of names) {
    const one = usedCuts(collage, { changes: { [name]: changes[name] } }).length;
    assert.equal(one, pairs([changes[name]]).size, name);
  }
});

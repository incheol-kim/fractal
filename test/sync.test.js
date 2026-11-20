// The sync check (tools/check_sync.mjs) and its pure part (tools/sync_lib.mjs): the marked moments
// read from the committed score and region map, the frame in which each one's change first shows
// for a shutter, and where a row of frame differences starts to change; the tool on a small made-up
// file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realScore, realRegions } from './helpers.js';
import { DUR } from '../src/music.js';
import { inPolys } from '../src/geometry.js';
import { MOMENTS, expectedFrame, onset, meanAbsDiff, frameDiffs, windowOf, innerRect, measureSize, judge, TOLERANCE, WINDOW, GRID, CHANGE, PRESS_CHANGE } from '../tools/sync_lib.mjs';

// the box [x0, y0, x1, y1] round regions.json leaves
const boxOf = (leaves) => [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...leaves.map((l) => l.bbox[i])));

test('expectedFrame: the frame whose shutter window holds the time, else the next one', () => {
  // floor 2044 (34.0667 s); its window 34.0667 ... 34.0750 does not hold 34.0788
  assert.equal(expectedFrame(34.0788, 0.5), 2045);
  assert.equal(expectedFrame(34.07, 0.5), 2044);
  assert.equal(expectedFrame(DUR, 0.5), 2825);
  // shutter 0: the first frame time at or after t
  for (const t of [34.0788, 34.07, 30.3183, 37.8154, 41.4952, DUR, 0.01, 12.3456]) assert.equal(expectedFrame(t, 0), Math.ceil(t * 60), `t ${t}`);
  // a frame time itself is in its own frame, with or without a shutter
  for (const k of [0, 1, 1819, 2045, 2825, 3124]) {
    assert.equal(expectedFrame(k / 60, 0), k);
    assert.equal(expectedFrame(k / 60, 0.5), k);
  }
  // the window's end belongs to the next frame; a full shutter holds the whole frame
  assert.equal(expectedFrame(2044.5 / 60 + 1e-9, 0.5), 2045);
  assert.equal(expectedFrame(2044.5 / 60 - 1e-9, 0.5), 2044);
  assert.equal(expectedFrame(2044.99 / 60, 1), 2044);
});

test('onset: the first difference over the threshold (-1 when none is)', () => {
  assert.equal(onset([0, 0, 1, 0, 40, 38, 2], 10), 4);
  assert.equal(onset([0, 0, 1, 0, 10, 38, 2], 10), 5); // over, not equal
  assert.equal(onset([0, 3, 2], 10), -1);
  assert.equal(onset([], 10), -1);
});

test('meanAbsDiff and frameDiffs: the mean absolute difference of two frames, and of each frame from the one before', () => {
  const a = Buffer.from([0, 10, 20, 30, 40, 50]);
  const b = Buffer.from([0, 13, 17, 30, 44, 50]);
  assert.equal(meanAbsDiff(a, a), 0);
  assert.equal(meanAbsDiff(a, b), (0 + 3 + 3 + 0 + 4 + 0) / 6);
  assert.equal(meanAbsDiff(b, a), meanAbsDiff(a, b));
  assert.throws(() => meanAbsDiff(a, Buffer.alloc(3)), /size/);
  assert.deepEqual(frameDiffs([a, a, b, b]), [0, 0, meanAbsDiff(a, b), 0]);
  assert.deepEqual(frameDiffs([a]), [0]);
});

test('MOMENTS: the five marked moments of the committed score, read from it and the code, in time order', () => {
  const score = realScore();
  const regions = realRegions();
  const m = MOMENTS(score, regions);
  assert.equal(m.length, 5);
  assert.deepEqual(m.map((x) => x.name), ['sky', 'strike', 'fold', 'press', 'blackout']);
  for (let i = 1; i < m.length; i++) assert.ok(m[i].t > m[i - 1].t, `${m[i].name} after ${m[i - 1].name}`);
  const at = Object.fromEntries(m.map((x) => [x.name, x]));
  // where each time comes from
  const sky = regions.leaves.find((l) => l.kind === 'sky');
  assert.equal(at.sky.t, score.pieces.find((p) => p.leaf === sky.id).t);
  assert.equal(at.sky.t, 30.3183);
  assert.equal(at.strike.t, 34.0769); // the camera's cut to the push-in
  assert.ok(score.camera.some((e) => e.t === at.strike.t && e.hold !== undefined));
  assert.equal(at.fold.t, 37.8154);
  // the glue chord itself (its breath starts two frames before it, too small to be seen in the first
  // of them: tools/README.md "싱크 검사")
  assert.equal(at.press.t, score.glue);
  assert.equal(at.press.t, 41.4952);
  assert.equal(at.blackout.t, DUR);
  // the thresholds: one for all, the press's above its breath
  assert.deepEqual(m.map((x) => x.threshold), [CHANGE, CHANGE, CHANGE, PRESS_CHANGE, CHANGE]);
  assert.ok(PRESS_CHANGE > CHANGE);
  // the clips: inside the frame; the strike, press and blackout are the whole frame
  for (const x of m) {
    const [cx, cy, cw, ch] = x.clip;
    assert.ok(cx >= 0 && cy >= 0 && cw > 0 && ch > 0 && cx + cw <= 1 + 1e-12 && cy + ch <= 1 + 1e-12, `${x.name} clip ${x.clip}`);
  }
  for (const name of ['strike', 'press', 'blackout']) assert.deepEqual(at[name].clip, [0, 0, 1, 1]);
  const corners = ([x, y, w, h]) => [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  const meets = ([x, y, w, h], [x0, y0, x1, y1]) => x < x1 && x + w > x0 && y < y1 && y + h > y0;
  const holds = (clip, [x0, y0, x1, y1]) => clip[0] <= x0 && clip[1] <= y0 && clip[0] + clip[2] >= x1 - 1e-12 && clip[1] + clip[3] >= y1 - 1e-12;
  const leaf = new Map(regions.leaves.map((l) => [l.id, l]));
  // the sky's: a large rectangle inside the sky leaf (the sky at the right edge, x 0.885 ... 1,
  // y 0 ... 0.62), clear of the tower's collage that changes six frames before the sky
  const shrunk = ([x, y, w, h]) => [x + 1e-6, y + 1e-6, w - 2e-6, h - 2e-6];
  for (const [x, y] of corners(shrunk(at.sky.clip))) assert.ok(inPolys(x, y, sky.polys), `sky clip corner ${x}, ${y} in the sky`);
  assert.ok(at.sky.clip[2] * at.sky.clip[3] > 0.06, `sky clip ${at.sky.clip} is large`);
  assert.deepEqual(at.sky.clip.map((v) => Math.round(v * 1000) / 1000), [0.885, 0, 0.115, 0.62]);
  const block = (name) => {
    const b = score.collage.blocks.findIndex((x) => x.name === name);
    return boxOf(score.collage.leaves.filter((r) => r.block === b).map((r) => leaf.get(r.leaf)));
  };
  for (const name of ['wing_left', 'coral_tree_1', 'yellow_block', 'bldg_top_mid', 'wall_coral', 'bldg_white_mid', 'bldg_low_dark', 'tree_green', 'tree_top_b']) {
    assert.ok(!meets(at.sky.clip, block(name)), `sky clip clear of the collage block ${name}`);
  }
  // the fold's: the box round the first folding cut-out's leaves (red_block_left and its windows),
  // widened, clear of red_block_top's collage that changes two frames before
  for (const id of [38, 80, 81, 82, 83, 84]) assert.ok(holds(at.fold.clip, leaf.get(id).bbox), `fold clip holds leaf ${id}`);
  assert.ok(at.fold.clip[0] < 0.1848 && at.fold.clip[1] < 0.4976 && at.fold.clip[0] + at.fold.clip[2] > 0.4124 && at.fold.clip[1] + at.fold.clip[3] > 0.7367, 'widened');
  assert.ok(!meets(at.fold.clip, block('red_block_top')), 'fold clip clear of red_block_top');
  // the first frame each one shows in, with the 0.5 shutter and without one
  assert.deepEqual(m.map((x) => expectedFrame(x.t, 0.5)), [1819, 2045, 2269, 2490, 2825]);
  assert.deepEqual(m.map((x) => expectedFrame(x.t, 0)), [1820, 2045, 2269, 2490, 2825]);
});

test('innerRect: the largest rectangle of whole grid cells inside an outline', () => {
  // an L: the left column 0 ... 0.25 full height, and the bottom row 0.5 ... 1 full width
  const L = [[[0, 0], [0.25, 0], [0.25, 0.5], [1, 0.5], [1, 1], [0, 1]]];
  assert.deepEqual(innerRect(L, [4, 4]), [0, 0.5, 1, 0.5]); // 4 x 2 cells beats 1 x 4
  // a hole (even-odd) splits it
  const holed = [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0.25, 0], [0.5, 0], [0.5, 1], [0.25, 1]]];
  assert.deepEqual(innerRect(holed, [4, 4]), [0.5, 0, 0.5, 1]);
  // a cell is inside only when its corners are: a thin outline holds none
  assert.equal(innerRect([[[0, 0], [1, 0], [1, 0.1], [0, 0.1]]], [4, 4]), null);
});

test('measureSize and judge: a clip in cells of the grid; an onset within one frame of its frame', () => {
  assert.deepEqual(GRID, [192, 108]);
  assert.deepEqual(measureSize([0, 0, 1, 1]), [192, 108]);
  assert.deepEqual(measureSize([0.5, 0.5, 0.25, 0.5]), [48, 54]);
  assert.deepEqual(measureSize([0, 0, 0.001, 0.001]), [1, 1]);
  const d = [0, 0.1, 1, 0.2, 30, 3];
  // the change starts at index 4: frame 104
  assert.deepEqual(judge(d, 100, 4, 104), { onset: 104, off: 0, ok: true });
  assert.deepEqual(judge(d, 100, 4, 105), { onset: 104, off: -1, ok: true });
  assert.deepEqual(judge(d, 100, 4, 103), { onset: 104, off: 1, ok: true });
  assert.deepEqual(judge(d, 100, 4, 106), { onset: 104, off: -2, ok: false });
  assert.deepEqual(judge(d, 100, 4, 102), { onset: 104, off: 2, ok: false });
  assert.deepEqual(judge(d, 100, 40, 104), { onset: null, off: null, ok: false });
});

test('windowOf: a moment is checked when its frames before and after lie in the file', () => {
  assert.equal(WINDOW, 12);
  assert.equal(TOLERANCE, 1);
  // a file of frames 2010 ... 2129 (t3_hit) holds the strike's window 2033 ... 2057
  assert.deepEqual(windowOf(2045, 2010, 120), { first: 2033, count: 25 });
  assert.deepEqual(windowOf(2033 + 12, 2033, 25), { first: 2033, count: 25 });
  // a window cut by either end of the file is not checked
  assert.equal(windowOf(2045, 2034, 120), null);
  assert.equal(windowOf(2045, 2010, 47), null);
  assert.equal(windowOf(2825, 0, 3125).first, 2813);
});

// is ffmpeg on PATH? (the next test runs it, and the tool)
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('check_sync on a made-up file: in sync, a frame off, two frames off, no side file', { skip: !hasFfmpeg && 'no ffmpeg on PATH' }, () => {
  // frames 2030 ... 2060 of 384 x 216 (H.264, like an export), with shutter 0.5: the strike is
  // expected in frame 2045. Before the change a gradient with a new grain every 5 frames (the 12 fps
  // steps, a few levels per pixel); from the frame `at` on another picture over the whole frame.
  const [W, H, K0, N] = [384, 216, 2030, 31];
  const frame = (k, at) => {
    const b = Buffer.alloc(W * H * 3);
    let seed = Math.floor(k / 5) * 7919 + 1;
    for (let i = 0; i < W * H; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const grain = ((seed >>> 16) % 9) - 4;
      const v = k >= at ? 230 - ((i % W) * 150) / W : 60 + ((i % W) * 150) / W;
      b.fill(Math.max(0, Math.min(255, Math.round(v + grain))), i * 3, i * 3 + 3);
    }
    return b;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const make = (name, at, side = true) => {
    const file = path.join(dir, `${name}_4K.mov`);
    const raw = Buffer.concat(Array.from({ length: N }, (_, i) => frame(K0 + i, at)));
    const enc = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${W}x${H}`, '-framerate', '60', '-i', 'pipe:0',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-g', '60', file], { input: raw, windowsHide: true, maxBuffer: 1 << 28 });
    assert.equal(enc.status, 0, String(enc.stderr));
    if (side) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ k0: K0, frames: N, fps: 60, sub: 16, shutter: 0.5, jitter: true }));
    return file;
  };
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check_sync.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  try {
    for (const [at, code, starts] of [[2045, 0, 'starts 2045 (+0)'], [2046, 0, 'starts 2046 (+1)'], [2044, 0, 'starts 2044 (-1)'], [2047, 1, 'starts 2047 (+2)'], [2043, 1, 'starts 2043 (-2)']]) {
      const r = run(make(`at${at}`, at));
      assert.equal(r.status, code, r.stdout + r.stderr);
      const line = r.stdout.split('\n').find((l) => / strike /.test(l));
      assert.ok(line.startsWith(code ? 'FAIL' : 'PASS') && line.endsWith(`expected 2045, ${starts}`), line);
      assert.match(r.stdout, /--  sky .*not in this file/); // the moments outside the file are only listed
      assert.match(r.stdout.trim().split('\n').pop(), code ? /^FAIL: 1 of 1 moments out of sync/ : /^PASS: 1 moment in sync/);
    }
    // without a side file: the flags give k0 and the shutter, else the command is wrong
    const bare = make('bare', 2045, false);
    assert.equal(run(bare).status, 2);
    const r = run(bare, '--k0=2030', '--shutter=0.5');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS {2}strike .*starts 2045 \(\+0\)/);
    // a side file and the flags: the command is wrong
    assert.equal(run(path.join(dir, 'at2045_4K.mov'), '--k0=2030', '--shutter=0.5').status, 2);
    // a file that holds no moment fails
    const none = run(bare, '--k0=100', '--shutter=0.5');
    assert.equal(none.status, 1);
    assert.match(none.stdout, /FAIL: no marked moment lies in this file/);
    // a side file that gives another number of frames than the file holds is not this file's: it
    // stops before measuring anything
    fs.writeFileSync(path.join(dir, 'at2045.json'), JSON.stringify({ k0: K0, frames: N + 1, fps: 60, sub: 16, shutter: 0.5, jitter: true }));
    const other = run(path.join(dir, 'at2045_4K.mov'));
    assert.equal(other.status, 1, other.stdout + other.stderr);
    assert.match(other.stdout, /^FAIL: the side file at2045\.json gives 32 frames, the file holds 31/m);
    assert.doesNotMatch(other.stdout, /strike/, 'nothing measured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

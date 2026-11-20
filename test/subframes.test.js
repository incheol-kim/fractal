// Sub-frames (src/subframes.js, design 10.3): a video frame can be the average of n sub-frames, their
// times spread over a shutter window that opens forward from the frame's time (never across a 1/60 s
// step, so never across the 12 fps steps of the grain and the tremor) and stops short of a cut, each
// shifted by a sub-pixel jitter (Halton 2, 3) unless the jitter is switched off (jittersFor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DUR } from '../src/music.js';
import { cameraAt } from '../src/timeline.js';
import { subFrameTimes, subPixelJitter, jittersFor, averagingBytes, cutTimes, FPS } from '../src/subframes.js';
import { realScore } from './helpers.js';

const FRAMES = 3125; // t = k / 60, k = 0 ... 3124: the video

test('subFrameTimes: n times spread evenly over a window that opens forward from the frame time', () => {
  const ts = subFrameTimes(10, 4, 60, 0.5);
  const want = [0.125, 0.375, 0.625, 0.875].map((u) => 10 + (u * 0.5) / 60);
  assert.equal(ts.length, 4);
  ts.forEach((t, k) => assert.ok(Math.abs(t - want[k]) < 1e-12, `${k}: ${t}, want ${want[k]}`));
  assert.ok(ts.every((t) => t >= 10 && t < 10 + 0.5 / 60), ts.join(', '));
  assert.deepEqual(subFrameTimes(10, 4, 60, 0), [10, 10, 10, 10], 'shutter 0: all at the frame time');
  assert.deepEqual(subFrameTimes(10, 16, 60, 0), Array(16).fill(10));
  assert.equal(FPS, 60);
});

test('subFrameTimes: one sub-frame without a shutter is the frame itself, at every frame of the video', () => {
  const cuts = cutTimes(realScore());
  for (let k = 0; k < FRAMES; k++) assert.deepEqual(subFrameTimes(k / 60, 1, 60, 0, cuts), [k / 60], `frame ${k}`);
});

test('subFrameTimes: no frame of the video reaches the next 1/60 s, so its sub-frames share one 12 fps tick', () => {
  for (let k = 0; k < FRAMES; k++) {
    const t = k / 60;
    const ts = subFrameTimes(t, 16, 60, 0.5);
    const tick = Math.floor(t * 12);
    for (const s of ts) {
      assert.ok(s >= t && s < (k + 1) / 60, `frame ${k}: ${s}`);
      assert.equal(Math.floor(s * 12), tick, `frame ${k}: ${s} is in another 12 fps tick`);
    }
  }
});

test("subFrameTimes: the picture's last frame (2824) stays before DUR, the first black one (2825) after it", () => {
  assert.ok(subFrameTimes(2824 / 60, 16, 60, 0.5, [DUR]).every((t) => t < DUR));
  assert.ok(subFrameTimes(2825 / 60, 16, 60, 0.5, [DUR]).every((t) => t >= DUR));
});

test('subFrameTimes: with a longer shutter (1.0) the times past a cut are held just before it', () => {
  const t = 2824 / 60;
  const free = subFrameTimes(t, 16, 60, 1.0);
  const cut = subFrameTimes(t, 16, 60, 1.0, [DUR]);
  const past = free.filter((s) => s >= DUR).length;
  assert.ok(past > 0 && past < 16, `without the cut ${past} of 16 times are at or past DUR`);
  free.forEach((s, k) => {
    if (s >= DUR) assert.equal(cut[k], DUR - 1e-6, `${k}: ${cut[k]}`);
    else assert.equal(cut[k], s, `${k}: changed though before the cut`);
  });
  // a cut before the frame time, or two cuts in either order: the earliest one after t holds
  assert.deepEqual(subFrameTimes(t, 16, 60, 1.0, [40, DUR]), cut);
  const two = [t + 0.3 / 60, t + 0.6 / 60];
  assert.deepEqual(subFrameTimes(t, 16, 60, 1.0, two), subFrameTimes(t, 16, 60, 1.0, [...two].reverse()));
  assert.ok(subFrameTimes(t, 16, 60, 1.0, two).every((s) => s < two[0]));
  // a cut a hair after the frame time: never before the frame time
  assert.ok(subFrameTimes(t, 16, 60, 1.0, [t + 1e-7]).every((s) => s >= t));
});

test("cutTimes: the score's camera cuts (every camera entry after the first: cameraAt jumps there) and DUR", () => {
  const score = realScore();
  const cuts = cutTimes(score);
  assert.deepEqual(cuts, [...score.camera.slice(1).map((e) => e.t), DUR]);
  assert.deepEqual(cuts, [4.6462, 8.2154, 11.9625, 34.0769, 41.4952, DUR]);
  // each camera cut is a jump between two frames, not a continuous move (the punch-ins too: they
  // jump in and then ease back)
  for (const c of cuts.slice(0, -1)) {
    const a = cameraAt(c - 1e-6, score.camera);
    const b = cameraAt(c, score.camera);
    assert.ok(Math.abs(b.zoom - a.zoom) > 0.03, `${c}: zoom ${a.zoom} -> ${b.zoom}`);
  }
});

test('cutTimes: at shutter 0.5 no cut falls inside a frame of the video (each lies behind its window)', () => {
  const cuts = cutTimes(realScore());
  for (let k = 0; k < FRAMES; k++) {
    assert.deepEqual(subFrameTimes(k / 60, 16, 60, 0.5, cuts), subFrameTimes(k / 60, 16, 60, 0.5), `frame ${k}`);
  }
  for (const c of cuts) {
    const k = Math.floor(c * 60);
    assert.ok(c - k / 60 >= 0.5 / 60, `${c}: inside frame ${k}'s window`);
  }
});

test('subPixelJitter: none for one sub-frame; for 16, distinct offsets inside the pixel, centred (Halton 2, 3)', () => {
  assert.deepEqual(subPixelJitter(1), [[0, 0]]);
  const j = subPixelJitter(16);
  assert.equal(j.length, 16);
  assert.ok(j.every(([x, y]) => x >= -0.5 && x < 0.5 && y >= -0.5 && y < 0.5), JSON.stringify(j));
  assert.equal(new Set(j.map(([x, y]) => `${x},${y}`)).size, 16, 'two offsets are the same');
  const mx = j.reduce((s, p) => s + p[0], 0) / 16;
  const my = j.reduce((s, p) => s + p[1], 0) / 16;
  assert.ok(Math.abs(mx) < 0.05 && Math.abs(my) < 0.05, `mean ${mx}, ${my}`);
  // Halton 2 and 3 from index 1: (1/2, 1/3), (1/4, 2/3), (3/4, 1/9), ...
  [[1 / 2, 1 / 3], [1 / 4, 2 / 3], [3 / 4, 1 / 9]].forEach(([hx, hy], k) => {
    assert.ok(Math.abs(j[k][0] - (hx - 0.5)) < 1e-15 && Math.abs(j[k][1] - (hy - 0.5)) < 1e-15, `${k}: ${j[k]}`);
  });
});

test('jittersFor: the Halton offsets with the jitter on; with it off every sub-frame at [0, 0] (they differ in time only)', () => {
  for (const n of [1, 2, 4, 16]) {
    assert.deepEqual(jittersFor(n, true), subPixelJitter(n), `on, ${n}`);
    assert.deepEqual(jittersFor(n, false), Array.from({ length: n }, () => [0, 0]), `off, ${n}`);
  }
  // the offsets are fresh arrays (a renderer may not change another sub-frame's by changing one)
  const off = jittersFor(4, false);
  assert.notEqual(off[0], off[1]);
});

test("averagingBytes: the sub-frame targets' GPU memory, 56 bytes a canvas pixel; none before they are made", () => {
  assert.equal(averagingBytes(null), 0);
  assert.equal(averagingBytes([1920, 1080]), 1920 * 1080 * 56);
  assert.equal(averagingBytes([3840, 2160]), 464486400); // 0.43 GiB
});

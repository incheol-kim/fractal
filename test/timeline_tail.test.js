// Signs of life (design 7, 8 and 10.4): from the cello's last note (score.end, 44.87) to the end of
// the picture (DUR, the audio's end) the finished picture lives a little: the clouds drift, the
// leaves tremble, the wires sway and the rooms' lights breathe (timeline.js lifeAt, frameState's
// life). While it is on the plate stays the plate (plateToKey 0); off (fx off) the plate turns into
// the key image as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DUR } from '../src/music.js';
import { lifeAt, frameState, LIFE_IN, LIFE_MAX, LIFE_FLOW, LIFE_TREMBLE, LIFE_BREATH } from '../src/timeline.js';
import { VIDEO_END } from '../src/card.js';
import { realScore, assertStateless } from './helpers.js';

const END = 44.87;
const KEYS = ['k', 'drift', 'tremble', 'breath', 'sway', 'phase'];
// the committed life map's description (tools/make_life.py): each channel's feather, picture px
const lifeMap = JSON.parse(readFileSync(new URL('../assets/life.json', import.meta.url), 'utf8'));
// picture px to a screen height: 1648 at 16:9 (the picture covers the stage by its height), and
// never more (renderer.js: pic.h / hP, hP >= 1)
const PIC_H = 1648;

const allZero = (r) => KEYS.every((k) => Object.is(r[k], 0));
const shown = (r) => JSON.stringify(r);

test('lifeAt: nothing before and on the last note; full strength LIFE_IN after it; the drift LIFE_FLOW a second', () => {
  for (const t of [44.0, END]) {
    const r = lifeAt(t, END, true);
    assert.deepEqual(Object.keys(r).sort(), [...KEYS].sort());
    assert.ok(allZero(r), `t=${t}: ${shown(r)}`);
  }
  assert.equal(lifeAt(END + 0.8, END, true).k, 1);
  assert.ok(lifeAt(END + LIFE_IN / 2, END, true).k < 1);
  // the drift is the strength's integral: 2 s on it is LIFE_IN / 2 seconds' drift behind a full one
  const r = lifeAt(46.87, END, true);
  assert.ok(Math.abs(r.drift - LIFE_FLOW * (2 - LIFE_IN / 2)) < 1e-12, shown(r));
});

test('lifeAt: the drift\'s speed rises to LIFE_FLOW and never passes it; the drift never goes back', () => {
  // frame by frame from before the last note to past LIFE_MAX, where the drift is held
  let last = lifeAt(END - 1 / 60, END, true).drift;
  let fastest = 0;
  for (let i = 0; END + i / 60 <= END + LIFE_MAX + 0.5; i++) {
    const t = END + i / 60;
    const drift = lifeAt(t, END, true).drift;
    const step = drift - last;
    assert.ok(step >= 0, `t=${t}: the drift goes back by ${-step}`);
    // a frame's step is at most LIFE_FLOW / 60 (up to the rounding of t - END)
    assert.ok(step <= (LIFE_FLOW / 60) * (1 + 1e-9), `t=${t}: a step of ${step / (LIFE_FLOW / 60)} x LIFE_FLOW / 60`);
    fastest = Math.max(fastest, step);
    last = drift;
  }
  assert.ok(fastest > (LIFE_FLOW / 60) * 0.999, `the fastest step is ${fastest / (LIFE_FLOW / 60)} x LIFE_FLOW / 60`);
});

// the picture shows to DUR, the audio's end (then the end card's black covers it): the signs of life
// do not stop before; LIFE_MAX only holds them after
test("lifeAt goes on to the picture's end: the drift only grows, the breath stays within LIFE_BREATH", () => {
  const score = realScore();
  assert.ok(LIFE_MAX >= DUR - score.end, `LIFE_MAX ${LIFE_MAX} < ${DUR - score.end}`);
  let last = 0;
  for (let i = 0; END + i / 60 <= DUR; i++) {
    const t = END + i / 60;
    const r = lifeAt(t, END, true);
    assert.ok(r.drift >= last, `t=${t}: drift ${r.drift} < ${last}`);
    assert.ok(r.drift <= LIFE_FLOW * LIFE_MAX, `t=${t}: drift ${r.drift}`);
    assert.ok(Math.abs(r.breath) <= LIFE_BREATH, `t=${t}: breath ${r.breath}`);
    last = r.drift;
  }
  // the picture's last frame (2824) and the audio's end: still flowing
  assert.ok(lifeAt(DUR, END, true).drift > lifeAt(2824 / 60, END, true).drift);
  assert.ok(lifeAt(2824 / 60, END, true).drift > lifeAt(2823 / 60, END, true).drift);
});

test('lifeAt: the clouds, the leaves, the wires and the rooms\' lights all live; fx off is nothing', () => {
  const r = lifeAt(46, END, true);
  assert.ok(r.drift > 0 && r.tremble > 0, shown(r));
  assert.ok(r.sway > 0 && r.breath !== 0 && r.phase > 0, shown(r));
  for (const t of [44.0, END, 46, DUR, VIDEO_END]) assert.ok(allZero(lifeAt(t, END, false)), `fx off at ${t}`);
});

test('the limits (committed assets/life.json): no displacement reaches the feather of its channel, so the picture never folds', () => {
  const { flow, tremble } = lifeMap.channels;
  assert.equal(lifeMap.h, PIC_H);
  assert.ok(LIFE_FLOW * LIFE_MAX * PIC_H < flow.feather, `drift ${LIFE_FLOW * LIFE_MAX * PIC_H} px, feather ${flow.feather}`);
  assert.ok(LIFE_TREMBLE * PIC_H < tremble.feather, `tremble ${LIFE_TREMBLE * PIC_H} px, feather ${tremble.feather}`);
});

test('frameState (committed score): life is lifeAt of score.end; the plate stays the plate while it is on', () => {
  const score = realScore();
  assert.equal(score.end, END);
  assert.equal(frameState(46, score).plateToKey, 0);
  assert.equal(frameState(46, score, { fx: false }).plateToKey, 1);
  for (const opts of [{}, { fx: false }]) {
    assert.equal(frameState(44.0, score, opts).plateToKey, 0, JSON.stringify(opts));
  }
  for (const [opts, fx] of [[{}, true], [{ fx: false }, false]]) {
    for (const t of [44.0, END, 45.5, DUR, VIDEO_END]) {
      assert.deepEqual(frameState(t, score, opts).life, lifeAt(t, END, fx), `${JSON.stringify(opts)} at ${t}`);
    }
  }
  assertStateless(score, {}, (s) => s.life);
});

// the page's time runs on after the picture through the end card and ends with it, at the video's end
// (src/card.js VIDEO_END): any later time is the last frame
test('frameState (committed score): the time runs through the end card; the frame at 60 s is the last frame', () => {
  const score = realScore();
  const end = VIDEO_END;
  assert.equal(frameState(49, score).t, 49);
  assert.notDeepEqual(frameState(49, score), frameState(end, score));
  assert.ok(60 > end);
  assert.deepEqual(frameState(60, score), frameState(end, score));
  assert.deepEqual(frameState(60, score, { fx: false }), frameState(end, score, { fx: false }));
});

// The end card (src/card.js): when the picture ends, at the audio's end (DUR), the screen cuts to
// black and Fractal and Incheol Kim come and go with Echolocation's end card's timing (cardAt), in
// Geo at 1.8 times Echolocation's size, the name at 85 % of the ink; frameState carries it as card.
// The video ends when the card does (VIDEO_END).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DUR } from '../src/music.js';
import { cubicBezier } from '../src/ease.js';
import { CARD, CARD_LEN, VIDEO_END, CARD_FONT, CARD_SCALE, CARD_NAME_ALPHA, cardAt } from '../src/card.js';
import { frameState } from '../src/timeline.js';
import { realScore, assertStateless } from './helpers.js';

const ease = cubicBezier(0.25, 0.1, 0.25, 1);

test("card: Echolocation's 5 s from the audio's end; the video ends with it, at DUR + 5", () => {
  assert.equal(CARD_LEN, 5);
  assert.equal(CARD_LEN, CARD.in + CARD.hold + CARD.out + CARD.black);
  assert.ok(Math.abs(VIDEO_END - (DUR + 5)) < 1e-12, `VIDEO_END ${VIDEO_END}`);
  assert.ok(Math.abs(VIDEO_END - 52.076938) < 1e-9, `VIDEO_END ${VIDEO_END}`);
});

test("cardAt: nothing before the audio's end; on it all black, with no text yet", () => {
  assert.deepEqual(cardAt(DUR - 0.001, DUR), { black: 0, a: 0 });
  assert.equal(cardAt(DUR, DUR).black, 1);
  assert.deepEqual(cardAt(DUR, DUR), { black: 1, a: 0 });
  assert.deepEqual(cardAt(0, DUR), { black: 0, a: 0 });
});

test('cardAt: the text comes in by CSS ease over 0.6 s, holds 2.5 s, goes by ease-in-out over 1.5 s, then 0.4 s of black', () => {
  for (const dt of [0.1, 0.3, 0.45]) {
    const { black, a } = cardAt(DUR + dt, DUR);
    assert.equal(black, 1, `+${dt}`);
    assert.ok(Math.abs(a - ease(dt / 0.6)) < 1e-9, `+${dt}: ${a}, ease ${ease(dt / 0.6)}`);
  }
  for (const dt of [0.6, 1.5, 3.0, 3.1]) assert.equal(cardAt(DUR + dt, DUR).a, 1, `+${dt}`);
  let last = 1;
  for (let k = 0; k <= 30; k++) {
    const dt = 3.1 + k * 0.05;
    const { a } = cardAt(DUR + dt, DUR);
    assert.ok(a <= last, `+${dt}: ${a} after ${last}`);
    last = a;
  }
  const half = cardAt(DUR + 3.1 + 0.75, DUR).a;
  assert.ok(half > 0.3 && half < 0.7, `half way out: ${half}`);
  for (const dt of [4.6, 4.8, 5.0, 9]) assert.deepEqual(cardAt(DUR + dt, DUR), { black: 1, a: 0 }, `+${dt}`);
});

test("the look the owner chose: Geo (upright), 1.8 times Echolocation's size, the name at 85 % of the ink", () => {
  assert.deepEqual(CARD_FONT, { family: 'Geo', file: 'geo/Geo-Regular.ttf', weight: 400 });
  assert.equal(CARD_SCALE, 1.8);
  assert.equal(CARD_NAME_ALPHA, 0.85);
});

test("frameState (committed score): card is nothing before the audio's end, the text at 49 s, black with no text at the video's end", () => {
  const score = realScore();
  for (const opts of [{}, { fx: false }]) {
    const what = JSON.stringify(opts);
    assert.deepEqual(frameState(47.0, score, opts).card, { black: 0, a: 0 }, what);
    assert.deepEqual(frameState(49.0, score, opts).card, { black: 1, a: 1 }, what);
    assert.deepEqual(frameState(VIDEO_END, score, opts).card, { black: 1, a: 0 }, what);
    // any time is cardAt of the time as clampT has it, for the picture that ends at DUR
    for (const t of [0, 46.5, 47.07, DUR, 47.1, 48, 50.5, 51.9, 60]) {
      assert.deepEqual(frameState(t, score, opts).card, cardAt(Math.min(t, VIDEO_END), DUR), `${what} t=${t}`);
    }
  }
});

// frame 2825 is 6.4 ms after the audio's end, so the text has begun (a 0.0048: 1.2 levels of the ink's
// 244 where a letter covers its pixel whole)
test("frameState: on the video's 60 fps grid frame 2824 is the picture's last (no card), frame 2825 the card's first (all black), frame 3124 the video's last (black)", () => {
  const score = realScore();
  assert.ok(2824 / 60 < DUR && 2825 / 60 >= DUR);
  assert.deepEqual(frameState(2824 / 60, score).card, { black: 0, a: 0 });
  const first = frameState(2825 / 60, score).card;
  assert.equal(first.black, 1);
  assert.ok(first.a > 0 && first.a < 0.005, `the text at frame 2825: ${first.a}`);
  assert.ok(3124 / 60 < VIDEO_END && 3125 / 60 >= VIDEO_END, 'frame 3124 is the last before the video ends');
  assert.deepEqual(frameState(3124 / 60, score).card, { black: 1, a: 0 });
});

test('frameState: card depends on t alone', () => {
  assertStateless(realScore(), {}, (s) => s.card);
});

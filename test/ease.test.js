import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, lerp, smooth, outBack, hash11, hash21, noise1, cubicBezier } from '../src/ease.js';

test('clamp and lerp', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
  assert.equal(lerp(2, 4, 0.5), 3);
  assert.equal(lerp(2, 4, 1), 4);
});

test('smooth runs 0..1 and is monotone', () => {
  assert.equal(smooth(1, 2, 0.5), 0);
  assert.equal(smooth(1, 2, 1), 0);
  assert.equal(smooth(1, 2, 1.5), 0.5);
  assert.equal(smooth(1, 2, 2), 1);
  assert.equal(smooth(1, 2, 9), 1);
});

test('outBack starts at 0, ends at exactly 1, overshoots between', () => {
  assert.equal(outBack(0), 0);
  assert.equal(outBack(1), 1);
  assert.ok(outBack(0.7) > 1);
});

test('hash values are in [0,1) and deterministic', () => {
  for (let i = 0; i < 500; i++) {
    const a = hash11(i);
    const b = hash21(i, i * 7 + 3);
    assert.ok(a >= 0 && a < 1);
    assert.ok(b >= 0 && b < 1);
    assert.equal(a, hash11(i));
    assert.equal(b, hash21(i, i * 7 + 3));
  }
  assert.notEqual(hash11(1), hash11(2));
  assert.notEqual(hash21(1, 2), hash21(2, 1));
});

test('smooth with e1 <= e0 is a step, never NaN', () => {
  assert.equal(smooth(2, 2, 1.999), 0);
  assert.equal(smooth(2, 2, 2), 1);
  assert.equal(smooth(2, 2, 3), 1);
  assert.equal(smooth(2, 1, 0), 0);
  assert.equal(smooth(2, 1, 1), 1);
});

test('noise1: hash21 at whole numbers, smooth between, within -1..1, a seed apart', () => {
  for (const i of [-3, 0, 1, 7, 100]) assert.equal(noise1(i, 7001), hash21(i, 7001) * 2 - 1);
  for (let k = 0; k < 1000; k++) {
    const x = k * 0.0731 - 20;
    assert.ok(Math.abs(noise1(x, 7001)) <= 1, `x=${x}`);
    assert.ok(Math.abs(noise1(x + 1e-4, 7001) - noise1(x, 7001)) < 1e-3, `x=${x}`);
  }
  let differ = 0;
  for (let k = 0; k < 20; k++) if (noise1(k + 0.5, 7001) !== noise1(k + 0.5, 7002)) differ++;
  assert.ok(differ >= 19);
});

// CSS's timing functions (the end card's, src/card.js): ease = cubic-bezier(0.25, 0.1, 0.25, 1)
test("cubicBezier: CSS's ease is exactly 0 and 1 at its ends and 0.8024 / 0.4085 at 0.5 / 0.25", () => {
  const ease = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(-0.5), 0);
  assert.equal(ease(2), 1);
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 2e-3, `ease(0.5) = ${ease(0.5)}`);
  assert.ok(Math.abs(ease(0.25) - 0.4085) < 2e-3, `ease(0.25) = ${ease(0.25)}`);
});

test('cubicBezier: ease-in-out is symmetric about 0.5; both curves rise and stay in 0..1', () => {
  const inOut = cubicBezier(0.42, 0, 0.58, 1);
  assert.ok(Math.abs(inOut(0.5) - 0.5) < 1e-9, `inOut(0.5) = ${inOut(0.5)}`);
  for (const f of [inOut, cubicBezier(0.25, 0.1, 0.25, 1)]) {
    let last = 0;
    for (let k = 1; k <= 1000; k++) {
      const y = f(k / 1000);
      assert.ok(y >= last && y <= 1, `at ${k / 1000}: ${y} after ${last}`);
      last = y;
    }
  }
  for (const x of [0.1, 0.3, 0.45]) assert.ok(Math.abs(inOut(x) + inOut(1 - x) - 1) < 1e-9, `x=${x}`);
});

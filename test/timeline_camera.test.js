import test from 'node:test';
import assert from 'node:assert/strict';
import { shakeAt, SHAKE, SHAKE_COVER, cameraAt, frameState } from '../src/timeline.js';
import { realScore, assertStateless } from './helpers.js';

const sh = { from: 39, to: 41.1 };
const ZERO = { x: 0, y: 0, zoom: 1 };

test('shakeAt is exactly nothing outside its window and without a shake', () => {
  assert.deepEqual(shakeAt(38.99, sh), ZERO);
  assert.deepEqual(shakeAt(39, sh), ZERO);
  assert.deepEqual(shakeAt(41.1, sh), ZERO);
  assert.deepEqual(shakeAt(45, sh), ZERO);
  assert.deepEqual(shakeAt(40, undefined), ZERO);
});

test('shakeAt: small, smooth, wandering, and the push-in always covers the shift', () => {
  const { amp } = SHAKE;
  let maxX = 0;
  for (let t = 39; t <= 41.1; t += 1 / 240) {
    const s = shakeAt(t, sh);
    assert.ok(Math.abs(s.x) <= amp + 1e-12 && Math.abs(s.y) <= amp + 1e-12, `t=${t}`);
    assert.ok(Math.abs(s.x) <= (s.zoom - 1) / 2 + 1e-12, `t=${t}: paper at the side`);
    assert.ok(Math.abs(s.y) <= (s.zoom - 1) / 2 + 1e-12, `t=${t}: paper at the top`);
    assert.ok(s.zoom <= 1 + SHAKE_COVER * amp + 1e-12);
    const n = shakeAt(t + 1 / 60, sh);
    assert.ok(Math.abs(n.x - s.x) <= 0.5 * amp && Math.abs(n.y - s.y) <= 0.5 * amp, `t=${t}: not smooth`);
    maxX = Math.max(maxX, Math.abs(s.x));
  }
  assert.ok(maxX > 0.3 * amp, 'hardly moves');
});

test('the committed score: a push-in under 1%, nothing outside the window, the punch-in untouched', () => {
  const score = realScore();
  const z = frameState(40, score).camera.zoom;
  assert.ok(z > 1 && z < 1.01, `zoom ${z}`);
  for (const t of [38.9, 41.2]) {
    const s = frameState(t, score);
    assert.deepEqual(s.shake, [0, 0]);
    assert.deepEqual(s.camera, cameraAt(t, score.camera));
  }
  assert.ok(Math.abs(frameState(41.4952, score).camera.zoom - 1.04) < 1e-9);
  const on = frameState(40, score, { fx: true });
  const off = frameState(40, score, { fx: false });
  assert.deepEqual(off.shake, on.shake);
  assert.deepEqual(off.camera, on.camera);
  assert.ok(on.shake[0] !== 0 || on.shake[1] !== 0);
  assertStateless(score, {}, (s) => [s.shake, s.camera]);
});

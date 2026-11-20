import test from 'node:test';
import assert from 'node:assert/strict';
import { toneThreshold } from '../src/halftone.js';

// the screen of common.glsl halftoneScreen, in cell units
const screen = (x, y) => 0.5 + 0.25 * (Math.cos(2 * Math.PI * x) + Math.cos(2 * Math.PI * y));

function inkFraction(tone) {
  const thr = toneThreshold(tone);
  const n = 512;
  let ink = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) if (screen((i + 0.5) / n, (j + 0.5) / n) > thr) ink++;
  }
  return ink / (n * n);
}

test('toneThreshold: no tone is solid, the threshold rises with the tone', () => {
  assert.equal(toneThreshold(0), -1);
  assert.ok(toneThreshold(0.2) < toneThreshold(0.6));
  assert.ok(toneThreshold(0.6) < toneThreshold(1));
});

test('toneThreshold: the printed fraction is the wanted coverage', () => {
  assert.ok(Math.abs(inkFraction(1) - 0.25) < 0.005, `tone 1: ${inkFraction(1)}`);
  assert.ok(Math.abs(inkFraction(0.5) - 0.625) < 0.005, `tone 0.5: ${inkFraction(0.5)}`);
});

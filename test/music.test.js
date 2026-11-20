import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initMusic, sectionAt, barAt, envAt, music } from '../src/music.js';

initMusic(JSON.parse(readFileSync(new URL('../assets/music.json', import.meta.url), 'utf8')));

test('sectionAt', () => {
  assert.equal(sectionAt(0.5), 'pre');
  assert.equal(sectionAt(0.93), 'A');
  assert.equal(sectionAt(15.7), 'B');
  assert.equal(sectionAt(30.31), 'C');
  assert.equal(sectionAt(41.6), 'coda');
  assert.equal(sectionAt(46), 'tail');
  assert.equal(sectionAt(48), 'end');
});

test('barAt', () => {
  assert.equal(barAt(0.93), 1);
  assert.equal(barAt(34.2), 19);
  assert.equal(barAt(0.5), 0);
  assert.equal(barAt(46), 0);
});

test('envAt interpolates within 0..1', () => {
  const e = music().env;
  assert.equal(envAt(0.005), (e[0] + e[1]) / 2 / 1000);
  assert.equal(envAt(-1), e[0] / 1000);
  assert.equal(envAt(1000), e[e.length - 1] / 1000);
  for (let t = 0; t < 47; t += 0.37) {
    const v = envAt(t);
    assert.ok(v >= 0 && v <= 1);
  }
});

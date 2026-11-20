// Shared by the tests: the committed material, seeded times through the video, and the
// statelessness check of frameState.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIDEO_END } from '../src/card.js';
import { frameState } from '../src/timeline.js';

const asset = (name) => JSON.parse(readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8'));

// the committed score and region map (a fresh copy each call, so a test may change its own)
export const realScore = () => asset('score.json');
export const realRegions = () => asset('regions.json');

// n seeded pseudo-random times in [0, VIDEO_END), the video's whole time (the picture and the end
// card after it), in the order they are drawn (not sorted)
export function times(n = 200) {
  const ts = [];
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    ts.push((x / 4294967296) * VIDEO_END);
  }
  return ts;
}

// frameState(t, score, opts) depends on t alone: pick(state) as JSON is the same whether the times
// are called in times()'s shuffled order or in ascending order
export function assertStateless(score, opts, pick) {
  const ts = times();
  const snap = (t) => JSON.stringify(pick(frameState(t, score, opts)));
  const shuffled = new Map(ts.map((t) => [t, snap(t)]));
  for (const t of [...ts].sort((a, b) => a - b)) {
    assert.equal(snap(t), shuffled.get(t), `t=${t}: another state after other times were drawn`);
  }
}

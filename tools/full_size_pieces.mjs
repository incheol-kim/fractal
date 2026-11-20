// The web set's full-size pieces (plan 5, Task 1b: the owner's decision at gate 5a, after comparing the
// two sets, that only the places where the half-size pieces show most are kept at the original's size).
// The collage pieces the page draws on screen while the camera is pushed in to ZOOM_MIN or more stay at
// the original's size in the web set (tools/make_collage_web.py reads the list this writes); every other
// web piece is half size. Everything is read from the score, the collage's list and the page's own code:
//   - the spans: where score.camera's zoom (timeline.js cameraAt) is ZOOM_MIN or more, found on a STEP grid
//     over the picture's time and each end refined by halving. With the committed score there are two: the
//     opening (8x down to 2x, 0 to 11.9625 s), before any collage block shows, and the punch-in right after
//     the strike (1.6x at 34.0769 s, held 0.1 s and eased back over 0.3 s; frames 2045 to 2061 at 60 fps).
//     The glue chord's push-in (1.04x) is not one;
//   - the pieces: frameState (timeline.js) at every STEP of each span and at every time of the score's
//     collage that falls in it (a change, a leaf's arrival and the start of its tear), in each of the score's
//     strengths (the page offers all three: ?collage=, the keys 1, 2 and 3). Of its state.collage, what the
//     canvas's own frame draws (the miniatures of a picture in picture draw it again, small), each block's
//     cuts as the collage layer binds them (drawnCuts; layers/collage.js update).
//
//   node tools/full_size_pieces.mjs        writes data/collage_full_size.json
//
// The list records the sha256 of the two files it is made from (assets/score.json, assets/collage.json):
// tools/make_collage_web.py stops on a stale list and its --check says so when either has changed, and
// test/collage_set.test.js makes the list again and compares it with the committed one.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cameraAt, frameState, strengths } from '../src/timeline.js';
import { PIP, tearMotion } from '../src/collage.js';
import { DUR } from '../src/music.js';
import { ROOT } from './paths.mjs';

export const ZOOM_MIN = 1.2; // the camera's zoom from which a piece is drawn larger than it was made for the web
export const STEP = 0.001; // seconds between the times looked at (a paste lasts 2/60 s, a tear 8/60 s)
export const LIST = 'data/collage_full_size.json';
const INPUTS = ['assets/score.json', 'assets/collage.json'];

// Where camera's zoom (cameraAt) is min or more over 0..end -> [[from, to], ...]: from the first such time
// to the last, each end found on a step grid and then halved to under 1e-9 s.
export function zoomSpans(camera, end, min = ZOOM_MIN, step = STEP) {
  const on = (t) => cameraAt(t, camera).zoom >= min;
  // on(lo) !== on(hi): the last time on (an end) or the first time on (a start) between them
  const edge = (lo, hi) => {
    const was = on(lo);
    while (hi - lo > 1e-10) {
      const m = (lo + hi) / 2;
      if (on(m) === was) lo = m;
      else hi = m;
    }
    return was ? lo : hi;
  };
  const spans = [];
  let start = on(0) ? 0 : null;
  let t0 = 0;
  for (let i = 1, n = Math.ceil(end / step); i <= n; i++) {
    const t = Math.min(i * step, end);
    if (on(t) !== on(t0)) {
      const x = edge(t0, t);
      if (start === null) start = x;
      else {
        spans.push([start, x]);
        start = null;
      }
    }
    t0 = t;
  }
  if (start !== null) spans.push([start, end]);
  return spans;
}

// The cuts the collage layer binds for c, a frameState's collage (layers/collage.js update): a block whose
// cur shows something (a cut, or the miniature PIP) is drawn while a leaf of it is shown (a > 0 and not
// tearing) or is being torn off (0 < tear < 1 with its fade, tearMotion, above 0); it binds its cur and,
// while it is pasted over it, its prev. The miniature is no piece. leafRows[row]: the block's rows of
// score.collage.leaves. -> [[row, cut], ...]
export function drawnCuts(c, leafRows) {
  const out = [];
  leafRows.forEach((rows, row) => {
    const cur = c.blocks[row * 4];
    const prev = c.blocks[row * 4 + 1];
    if (!(cur >= 0 || cur === PIP)) return;
    const shown = rows.some((i) => (c.tear[i] > 0 ? 0 : c.leaves[i * 4]) > 0);
    const tearing = rows.some((i) => c.leaves[i * 4] > 0 && c.tear[i] > 0 && c.tear[i] < 1 && tearMotion(c.tear[i])[1] > 0);
    if (!shown && !tearing) return;
    for (const k of [cur, prev]) if (k >= 0) out.push([row, k]);
  });
  return out;
}

const fileName = (file) => file.slice(file.lastIndexOf('/') + 1);

// score: assets/score.json, collage: assets/collage.json. -> { spans, strengths: { name: [file names] },
// pieces: [file names] } (the original's names as baked.json records them, sorted; pieces: of every strength).
export function fullSizePieces(score, collage, end = DUR) {
  const spans = zoomSpans(score.camera, end);
  const col = score.collage;
  const byStrength = {};
  if (!col) return { spans, strengths: byStrength, pieces: [] };
  const leafRows = collage.blocks.map(() => []);
  col.leaves.forEach((ev, i) => leafRows[ev.block].push(i));
  // no block shows before its first (timeline.js collageBlockAt)
  const first = Math.min(...col.blocks.map((b) => b.first));
  const marks = [
    ...Object.values(col.changes).flatMap((ch) => ch.events.map((e) => e.t)),
    ...col.leaves.flatMap((ev) => [ev.t, ev.off]).filter(Number.isFinite),
  ];
  const all = new Set();
  for (const s of strengths(score)) {
    const names = new Set();
    for (const [a, b] of spans) {
      const from = Math.max(a, first);
      if (from > b) continue;
      const ts = [b, ...marks.filter((m) => m >= from && m <= b)];
      for (let i = 0; from + i * STEP < b; i++) ts.push(from + i * STEP);
      for (const t of ts) {
        for (const [row, k] of drawnCuts(frameState(t, score, { strength: s }).collage, leafRows)) {
          names.add(fileName(collage.blocks[row].cuts[k].file));
        }
      }
    }
    byStrength[s] = [...names].sort();
    for (const n of names) all.add(n);
  }
  return { spans, strengths: byStrength, pieces: [...all].sort() };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The list as data/collage_full_size.json holds it, from the bytes of assets/score.json and
// assets/collage.json.
export function listFor(scoreBytes, collageBytes) {
  const r = fullSizePieces(JSON.parse(scoreBytes.toString('utf8')), JSON.parse(collageBytes.toString('utf8')));
  return {
    rule: `the collage pieces drawn on screen while the camera's zoom is ${ZOOM_MIN} or more, in any strength: the web set keeps them at the original's size (tools/full_size_pieces.mjs)`,
    zoom: ZOOM_MIN,
    spans: r.spans.map(([a, b]) => [round6(a), round6(b)]),
    inputs: { [INPUTS[0]]: sha256(scoreBytes), [INPUTS[1]]: sha256(collageBytes) },
    strengths: Object.fromEntries(Object.entries(r.strengths).map(([s, n]) => [s, n.length])),
    pieces: r.pieces,
  };
}

function main() {
  const [scoreBytes, collageBytes] = INPUTS.map((rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
  const list = listFor(scoreBytes, collageBytes);
  const out = path.join(ROOT, ...LIST.split('/'));
  fs.writeFileSync(out + '.tmp', JSON.stringify(list, null, 1) + '\n');
  fs.renameSync(out + '.tmp', out);
  const spans = list.spans.map(([a, b]) => `${a}-${b} s`).join(', ');
  const per = Object.entries(list.strengths).map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`${LIST}: ${list.pieces.length} pieces at full size (${per}); zoom >= ${ZOOM_MIN} in ${spans}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

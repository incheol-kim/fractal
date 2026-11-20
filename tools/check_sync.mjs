// The sync check (design 10.4): in an exported file, at each marked moment the picture starts to
// change within one frame of the moment's time.
//
//   node tools/check_sync.mjs <name>_4K.mov|<name>_1080p.mov [--k0=K --shutter=X]
//
// The file's first frame number and shutter come from its side file <name>.json (written by
// tools/export_video.mjs; without one, --k0 and --shutter give them); a side file that gives another
// number of frames than the file holds is not this file's, and the check stops there. For each moment of
// tools/sync_lib.mjs MOMENTS whose frames lie in the file (a passage holds only some): the frame its
// change should first show in (expectedFrame, by the shutter), the WINDOW frames before and after it
// decoded as a player shows them (tools/video_io.mjs), each one's clip reduced to the measure's
// cells (measureSize), each frame's mean absolute difference from the one before, and the frame
// where the change starts: the first whose difference is over the moment's threshold. It is in
// sync when that frame is within TOLERANCE of the expected one. Prints a line per moment with the
// differences, then PASS when every moment in the file is in sync (FAIL when one is not, or when the
// file holds none) and exits 0 or 1 (2: the command was wrong).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { sideFile } from './export_lib.mjs';
import { probe, decodeFrames, ffmpegCheck } from './video_io.mjs';
import { MOMENTS, expectedFrame, frameDiffs, windowOf, measureSize, judge, TOLERANCE, GRID } from './sync_lib.mjs';

const USAGE = 'usage: node tools/check_sync.mjs <name>_4K.mov|<name>_1080p.mov [--k0=K --shutter=X] (the flags only for a file without its side file)';
const args = process.argv.slice(2);
const flag = (k) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a === undefined ? undefined : a.slice(k.length + 3);
};
const usage = (why) => {
  console.error(`${why}\n${USAGE}`);
  process.exit(2);
};
// a printed path: from the project folder, else its name alone (paths on this machine can hold a person's name)
function show(p) {
  const r = path.relative(ROOT, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.basename(p);
}
const json = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', name), 'utf8'));

const files = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && !/^--(k0|shutter)=/.test(a));
if (files.length !== 1 || unknown.length) usage(unknown.length ? `unknown: ${unknown.join(' ')}` : 'one video file');
const file = path.resolve(ROOT, files[0]);
if (!fs.existsSync(file)) usage(`no such file: ${show(file)}`);
const ff = ffmpegCheck(); // before anything is read: an ffmpeg too old stops here
if (ff.problem) usage(ff.problem);

// the file's first frame and shutter: its side file, or the flags
const sf = sideFile(file);
let k0;
let shutter;
let about;
let sideFrames = null; // the frames the side file gives
if (sf && fs.existsSync(sf)) {
  if (flag('k0') !== undefined || flag('shutter') !== undefined) usage(`the side file ${path.basename(sf)} gives k0 and shutter`);
  const side = JSON.parse(fs.readFileSync(sf, 'utf8'));
  ({ k0, shutter } = side);
  sideFrames = side.frames;
  about = `side file ${path.basename(sf)}: first frame ${k0}, ${side.frames} frames, sub ${side.sub} shutter ${shutter} jitter ${side.jitter ? 1 : 0}`;
} else {
  if (flag('k0') === undefined || flag('shutter') === undefined) usage(`no side file${sf ? ` ${path.basename(sf)}` : ''}: give --k0 and --shutter`);
  [k0, shutter] = [Number(flag('k0')), Number(flag('shutter'))];
  about = `flags: first frame ${k0}, shutter ${shutter}`;
}
if (!(Number.isInteger(k0) && k0 >= 0)) usage(`the first frame is a frame number (not ${k0})`);
if (!(shutter >= 0 && shutter <= 1)) usage(`the shutter is 0 to 1 (not ${shutter})`);

const { video } = await probe(file);
if (!video) usage(`${show(file)}: no video stream`);
const n = video.frames;
const last = k0 + n - 1;
console.log(`check_sync ${show(file)} (${video.width}x${video.height}, ${n} frames: ${k0}..${last}); ${about}`);
if (sideFrames !== null && sideFrames !== n) {
  // its frame numbers would be off: a side file of another export, or a file cut or grown since
  console.log(`FAIL: the side file ${path.basename(sf)} gives ${sideFrames} frames, the file holds ${n}: it is not this file's side file (or the file was changed after the export); nothing measured`);
  process.exit(1);
}
console.log(`  a moment's change starts at the first frame whose clip differs from the frame before by more than its threshold`);
console.log(`  (the mean absolute difference, in levels, of the clip reduced to cells of 1/${GRID[1]} of the frame's height); in sync within ${TOLERANCE} frame of the expected one`);

let checked = 0;
let bad = 0;
for (const m of MOMENTS(json('score.json'), json('regions.json'))) {
  const e = expectedFrame(m.t, shutter);
  const head = `${m.name.padEnd(8)} ${m.t.toFixed(4)} s, clip ${m.clip.map((v) => v.toFixed(3)).join(' ')}, threshold ${m.threshold}: expected ${e}`;
  const w = windowOf(e, k0, n);
  if (!w) {
    console.log(`  --  ${head}; not checked: ${e >= k0 && e <= last ? 'the file cuts its frames before or after it' : 'not in this file'}`);
    continue;
  }
  const frames = await decodeFrames(file, w.first - k0, w.count, { clip: m.clip, size: measureSize(m.clip) });
  const diffs = frameDiffs(frames);
  const r = judge(diffs, w.first, m.threshold, e);
  checked++;
  if (!r.ok) bad++;
  const starts = r.onset === null ? 'no change over the threshold' : `starts ${r.onset} (${r.off >= 0 ? '+' : ''}${r.off})`;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${head}, ${starts}`);
  const cells = diffs.map((d, i) => (w.first + i === r.onset ? `[${d.toFixed(2)}]` : d.toFixed(2)));
  console.log(`      ${w.first}..${w.first + w.count - 1}: ${cells.join(' ')}`);
}
if (!checked) {
  console.log('FAIL: no marked moment lies in this file');
  process.exit(1);
}
console.log(bad ? `FAIL: ${bad} of ${checked} moments out of sync` : `PASS: ${checked} moment${checked > 1 ? 's' : ''} in sync`);
process.exit(bad ? 1 : 0);

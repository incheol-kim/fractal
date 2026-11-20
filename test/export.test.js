// The export (tools/export_video.mjs) and its pure part (tools/export_lib.mjs): the video's frames
// k = 0 ... 3124 at t = k / 60, cut into resumable lossless chunks; 800 audio samples a frame; the
// ffmpeg arguments (lossless RGB chunks; one encode at the end with one conversion to limited-range
// BT.709 Y'CbCr for both sizes; the WAV's PCM handed to the MOV untouched); the WAV's samples sliced
// and padded byte for byte; what --verify looks at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_END } from '../src/card.js';
import { DUR } from '../src/music.js';
import {
  FPS,
  frameAt,
  frameCount,
  chunks,
  audioSamples,
  encodeArgs,
  chunkArgs,
  muxArgs,
  wavInfo,
  pcmSlice,
  verifyFrames,
  frameError,
  strayTags,
  sideFile,
  reencodeProblem,
  scrubPaths,
  TUNES,
  EXPORT_DEFAULTS,
  nameProblem,
  replaceProblems,
  renameTogether,
  RENDER_FILE,
  metadataRanges,
  privateKinds,
  FFMPEG_MIN,
  ffmpegProblem,
} from '../tools/export_lib.mjs';
import { frameReceiver, readFrame } from '../tools/frame_reader.mjs';
import { privateText } from '../tools/video_io.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// the frames a list of chunks covers, in order
const covered = (list) => list.flatMap((c) => Array.from({ length: c.k1 - c.k0 + 1 }, (_, i) => c.k0 + i));

test('the video is 3,125 frames at 60 fps, and 2,500,000 audio samples', () => {
  assert.equal(FPS, 60);
  assert.equal(frameCount(VIDEO_END), 3125);
  assert.equal(audioSamples(3125), 2500000);
  assert.equal(audioSamples(1), 800);
  // the picture's last frame is 2824, the first black frame 2825 (DUR lies between them)
  assert.equal(frameCount(DUR), 2825);
});

test('frameAt: the frame that holds a time; frameCount: the frames before a time', () => {
  assert.equal(frameAt(0), 0);
  assert.equal(frameAt(29.5), 1770);
  assert.equal(frameAt(33.5), 2010);
  assert.equal(frameAt(46.5), 2790);
  assert.equal(frameAt(34.083333333333336), 2045);
  assert.equal(frameAt(34.0833), 2044, 'a rounded time is in the frame before');
  assert.equal(frameAt(-1), 0);
  for (let k = 0; k < 3125; k++) assert.equal(frameAt(k / 60), k, `frame ${k}`);
  assert.equal(frameCount(42), 2520, 'k / 60 < 42: frames 0 ... 2519');
  assert.equal(frameCount(35.5), 2130);
  assert.equal(frameCount(0), 0);
  for (let k = 1; k < 3125; k++) assert.equal(frameCount(k / 60), k, `before frame ${k}`);
});

test('chunks: the whole video is covered once, without gaps or overlaps, ending at frame 3124', () => {
  const list = chunks(0, VIDEO_END, 10);
  const ks = covered(list);
  assert.equal(ks.length, 3125);
  ks.forEach((k, i) => assert.equal(k, i));
  assert.equal(list[0].k0, 0);
  assert.equal(list.at(-1).k1, 3124);
  assert.deepEqual(list.map((c) => c.k1 - c.k0 + 1), [600, 600, 600, 600, 600, 125]);
});

test('chunks: a passage from the frame that holds --from up to the frames before --to', () => {
  const list = chunks(29.5, 42, 10);
  assert.equal(list[0].k0, 1770);
  assert.equal(list.at(-1).k1, 2519);
  assert.equal(covered(list).length, 750);
  // the trial runs: two chunks of one second each; the passage with the cut to black
  assert.deepEqual(chunks(33.5, 35.5, 1).map((c) => [c.k0, c.k1]), [[2010, 2069], [2070, 2129]]);
  const cut = chunks(46.5, 48, 10);
  assert.deepEqual(cut.map((c) => [c.k0, c.k1]), [[2790, 2879]]);
});

test('chunks: --to is cut at the end of the video, and without it the passage runs to the end', () => {
  assert.equal(chunks(43.5, 52.1, 10).at(-1).k1, 3124);
  assert.equal(chunks(43.5, 1000, 10).at(-1).k1, 3124);
  assert.equal(chunks(43.5, undefined, 10).at(-1).k1, 3124);
  assert.equal(covered(chunks(43.5, undefined, 10)).length, 3125 - 2610);
  assert.deepEqual(chunks(60, undefined, 10), [], 'nothing after the end');
  assert.deepEqual(chunks(10, 10, 10), [], 'nothing in an empty passage');
});

test('chunks: the same arguments give the same tags, and a tag is made of the chunk\'s first and last frame', () => {
  const a = chunks(29.5, 42, 10);
  const b = chunks(29.5, 42, 10);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((c) => c.tag), ['01770-02369', '02370-02519']);
  assert.equal(new Set(chunks(0, VIDEO_END, 1).map((c) => c.tag)).size, chunks(0, VIDEO_END, 1).length);
  assert.throws(() => chunks(0, 10, 0), /chunk/);
});

test('encodeArgs: H.264 High, CRF, GOP of 60, one conversion to limited-range BT.709 4:2:0, tagged as such', () => {
  const a = encodeArgs({ w: 1920, h: 1080, crf: 14, tune: 'none' });
  const s = a.join(' ');
  assert.ok(s.includes('yuv420p'), s);
  assert.ok(s.includes('bt709'), s);
  assert.equal(a[a.indexOf('-crf') + 1], '14');
  assert.equal(a[a.indexOf('-c:v') + 1], 'libx264');
  assert.equal(a[a.indexOf('-preset') + 1], 'slow');
  assert.equal(a[a.indexOf('-profile:v') + 1], 'high');
  assert.equal(a[a.indexOf('-g') + 1], '60');
  assert.equal(a[a.indexOf('-map') + 1], '0:v:0');
  assert.ok(!a.includes('-tune'), 'tune none: x264 as it is');
  const grain = encodeArgs({ w: 1920, h: 1080, crf: 14, tune: 'grain' });
  assert.equal(grain[grain.indexOf('-tune') + 1], 'grain');
  assert.deepEqual(grain.filter((x) => x !== '-tune' && x !== 'grain'), a, 'grain changes nothing else');
  assert.throws(() => encodeArgs({ w: 1920, h: 1080, crf: 14, tune: 'film' }), /tune/);
  // the one conversion: the scaler, Lanczos to the output size, into BT.709 limited range
  const vf = a[a.indexOf('-vf') + 1];
  const scales = vf.split(',').filter((f) => f.startsWith('scale='));
  assert.equal(scales.length, 1, vf);
  assert.match(scales[0], /^scale=1920:1080:/);
  assert.match(scales[0], /flags=lanczos\b/);
  assert.match(scales[0], /out_color_matrix=bt709/);
  assert.match(scales[0], /out_range=tv/);
  // the tags: matrix, primaries, transfer and range, on the frames and on the encoder
  for (const k of ['color_primaries=bt709', 'color_trc=bt709', 'colorspace=bt709', 'range=tv']) assert.ok(vf.includes(k), k);
  for (const k of ['-colorspace', '-color_primaries', '-color_trc']) assert.equal(a[a.indexOf(k) + 1], 'bt709', k);
  assert.equal(a[a.indexOf('-color_range') + 1], 'tv');
  const big = encodeArgs({ w: 3840, h: 2160, crf: 18, tune: 'none' });
  assert.equal(big[big.indexOf('-crf') + 1], '18');
  assert.equal(big[big.indexOf('-vf') + 1].replace('3840:2160', 'W:H'), vf.replace('1920:1080', 'W:H'), 'the same filter but for the size');
});

test('chunkArgs: the RGBA frames from the standard input into a lossless RGB chunk', () => {
  const a = chunkArgs({ size: [3840, 2160], out: '01770-02369.part.mp4' });
  assert.equal(a.filter((x) => x === '-i').length, 1);
  assert.equal(a[a.indexOf('-i') + 1], 'pipe:0');
  assert.equal(a[a.indexOf('-pix_fmt') + 1], 'rgba');
  assert.equal(a[a.indexOf('-video_size') + 1], '3840x2160');
  assert.equal(a[a.indexOf('-framerate') + 1], '60');
  assert.equal(a[a.indexOf('-c:v') + 1], 'libx264rgb', 'H.264 in RGB, no conversion to Y\'CbCr');
  assert.equal(a[a.indexOf('-qp') + 1], '0', 'lossless');
  assert.equal(a[a.lastIndexOf('-pix_fmt') + 1], 'rgb24');
  assert.ok(!a.includes('-vf') && !a.includes('-crf'), 'no filter, no rate control');
  assert.equal(a.at(-1), '01770-02369.part.mp4');
});

test('muxArgs: one run encodes every size from the chunks; the PCM is stream-copied as pcm_s24le, untouched', () => {
  const outputs = [
    { w: 3840, h: 2160, crf: 14, tune: 'none', out: 'Fractal_4K.part.mov' },
    { w: 1920, h: 1080, crf: 14, tune: 'none', out: 'Fractal_1080p.part.mov' },
  ];
  const a = muxArgs({ video: 'list.txt', pcm: 'audio.s24le', outputs });
  const s = a.join(' ');
  assert.ok(a.includes('pcm_s24le'), s);
  assert.ok(!/aac/i.test(s), s);
  assert.ok(!a.includes('-ar'), s);
  for (const x of ['-af', '-filter:a', '-filter_complex', '-lavfi', 'aresample', 'volume', 'loudnorm', 'dynaudnorm', 'apad', 'atrim', '-b:a', 'dither']) {
    assert.ok(!s.includes(x), `${x} in ${s}`);
  }
  // the two inputs: the chunks joined (concat list) and the raw PCM, 48 kHz stereo signed 24-bit LE
  assert.equal(a.filter((x) => x === '-i').length, 2);
  assert.equal(a[a.indexOf('-f') + 1], 'concat');
  assert.equal(a[a.indexOf('-i') + 1], 'list.txt');
  assert.equal(a[a.indexOf('-f', a.indexOf('-i') + 1) + 1], 's24le', 'the second input');
  assert.equal(a[a.indexOf('-sample_rate') + 1], '48000');
  assert.equal(a[a.indexOf('-ch_layout') + 1], 'stereo');
  // every output: the video encoded (encodeArgs), the audio copied, the title the only metadata
  for (const [i, o] of outputs.entries()) {
    const end = a.indexOf(o.out);
    const start = i ? a.indexOf(outputs[i - 1].out) + 1 : a.indexOf('audio.s24le') + 1; // after the inputs
    const part = a.slice(start, end);
    assert.deepEqual(part.slice(0, encodeArgs(o).length), encodeArgs(o), `${o.out}: the video as encodeArgs says`);
    assert.equal(part[part.indexOf('-map', encodeArgs(o).length) + 1], '1:a:0');
    assert.equal(part[part.indexOf('-c:a') + 1], 'copy', 'the audio is copied, never decoded');
    assert.ok(part.includes('title=Fractal'));
    assert.equal(part.filter((x) => x === '-metadata').length, 1);
    assert.equal(part[part.indexOf('-map_metadata') + 1], '-1');
  }
  assert.equal(a.at(-1), 'Fractal_1080p.part.mov');
});

// is ffmpeg on PATH? (the next test runs it)
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;

test('a chunk is lossless: the frames decoded from it are the bytes that were sent', { skip: !hasFfmpeg && 'no ffmpeg on PATH' }, () => {
  // three frames that leave the encoder nothing to round away unseen: every value of every channel,
  // noise, flat areas and a moving edge; alpha 255, as the canvas gives (alpha is not kept)
  const [w, h, n] = [640, 360, 3];
  const sent = Buffer.alloc(w * h * 4 * n);
  let x = 7;
  for (let f = 0; f < n; f++) {
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w; i++) {
        const p = ((f * h + y) * w + i) * 4;
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        const noise = x >>> 24;
        const flat = i > w / 2 && y < h / 2;
        sent[p] = flat ? 200 : (i + f * 37) & 255;
        sent[p + 1] = flat ? 120 : (y * 3 + i) & 255;
        sent[p + 2] = flat ? 40 : i < 60 * (f + 1) ? noise : 255 - noise;
        sent[p + 3] = 255;
      }
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-'));
  try {
    const out = path.join(dir, 'c.mp4');
    const args = chunkArgs({ size: [w, h], out });
    const enc = spawnSync('ffmpeg', args, { input: sent, windowsHide: true, maxBuffer: 1 << 28 });
    assert.equal(enc.status, 0, String(enc.stderr));
    const dec = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', out, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 28 });
    assert.equal(dec.status, 0, String(dec.stderr));
    assert.equal(dec.stdout.length, sent.length, 'every frame');
    assert.ok(dec.stdout.equals(sent), 'byte for byte');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// a 24-bit stereo 48 kHz WAV with other chunks before its data (as the final WAV has: JUNK, fmt,
// fact, bext, acid), the data byte i = (i * 7 + 3) & 255 so that every byte is checked
function wav(samples, { odd = false } = {}) {
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(48000 * 6, 8);
  fmt.writeUInt16LE(6, 12);
  fmt.writeUInt16LE(24, 14);
  const data = Buffer.from(Array.from({ length: samples * 6 }, (_, i) => (i * 7 + 3) & 255));
  const parts = [chunk('JUNK', Buffer.alloc(28)), chunk('fmt ', fmt), chunk('fact', Buffer.from([1, 2, 3, 4])), chunk('bext', Buffer.alloc(odd ? 601 : 602, 0x41)), chunk('data', data)];
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...parts]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return { bytes: Buffer.concat([riff, body]), data };
}

test('reencodeProblem: --as re-encodes a render only as it was drawn, and only when all its chunks are there', () => {
  const render = { size: [3840, 2160], sub: 1, shutter: 0, jitter: false, commit: 'abc', chunk: ['-c:v', 'libx264rgb'] };
  const tags = ['02040-02069', '02070-02099'];
  assert.equal(reencodeProblem('r', render, { ...render }, tags, tags), null, 'the same settings, every chunk: go on');
  assert.equal(reencodeProblem('r', render, { ...render }, [...tags, '02100-02129'], tags), null, 'more chunks than needed are fine');
  const sub = reencodeProblem('r', render, { ...render, sub: 16 }, tags, tags);
  assert.match(sub, /render r/);
  assert.match(sub, /sub: the render has 1, this run asks for 16/);
  const two = reencodeProblem('r', render, { ...render, shutter: 0.5, commit: 'def' }, tags, tags);
  assert.match(two, /shutter: the render has 0, this run asks for 0\.5/);
  assert.match(two, /commit: the render has "abc", this run asks for "def"/, 'a changed page is named too');
  assert.match(reencodeProblem('r', null, render, [], tags), /no render r/);
  const missing = reencodeProblem('r', render, { ...render }, ['02040-02069'], tags);
  assert.match(missing, /02070-02099/);
  assert.match(missing, /has 02040-02069/, 'what the render has');
});

test('scrubPaths: the project folder, the home folder and the user name never reach a log', () => {
  const where = { root: 'C:\\work\\proj', home: 'C:\\Users\\bob', user: 'bob' };
  const stack = [
    'Error: ffmpeg exit 1 in chunk 00000-00059: C:\\work\\proj\\local-only\\temp\\export\\x\\00000-00059.part.mp4: No space left',
    '    at worker (file:///C:/work/proj/tools/export_video.mjs:351:19)',
    '    at c:/work/proj/tools/frame_reader.mjs:20:3',
    '    profile C:\\Users\\bob\\AppData\\Local\\Temp\\edge-shot-1 for bob',
  ].join('\n');
  const s = scrubPaths(stack, where);
  assert.ok(!/work.proj|Users|bob/i.test(s), s);
  assert.match(s, /local-only\\temp\\export\\x\\00000-00059\.part\.mp4/);
  assert.match(s, /at worker \(tools\/export_video\.mjs:351:19\)/);
  assert.match(s, /at tools\/frame_reader\.mjs:20:3/);
  assert.match(s, /profile ~\\AppData\\Local\\Temp\\edge-shot-1 for <user>/);
  assert.equal(scrubPaths('nothing to hide', where), 'nothing to hide');
});

test('scrubPaths: the user name only as a word of its own; the project folder by itself too', () => {
  // a short name is part of many words: only the name itself is taken out
  const ed = { root: 'C:\\work\\proj', home: 'C:\\Users\\ed', user: 'ed' };
  assert.equal(scrubPaths('started, removed and finished', ed), 'started, removed and finished');
  assert.equal(scrubPaths('ed ran it; so did Ed. (ed)', ed), '<user> ran it; so did <user>. (<user>)');
  assert.equal(scrubPaths('a file of ed_2', ed), 'a file of <user>_2', 'an underscore is not part of a name');
  // another user's home folder that only starts like this one's is not this home folder
  assert.equal(scrubPaths('C:\\Users\\eddie\\x and C:\\Users\\ed\\y', ed), 'C:\\Users\\eddie\\x and ~\\y');
  // the project folder by itself (no path inside it): the project folder, "."
  const where = { root: 'C:\\work\\proj', home: 'C:\\Users\\bob', user: 'bob' };
  assert.equal(scrubPaths('cwd C:\\work\\proj', where), 'cwd .');
  assert.equal(scrubPaths("in 'c:/work/proj': no", where), "in '.': no");
  assert.equal(scrubPaths('at file:///C:/work/proj, then', where), 'at ., then');
  assert.equal(scrubPaths('C:\\work\\proj\\tools and C:\\work\\proj', where), 'tools and .');
  // a folder beside it whose name only starts like it is another folder
  assert.equal(scrubPaths('C:\\work\\proj2\\x and C:\\work\\proj.old\\y', where), 'C:\\work\\proj2\\x and C:\\work\\proj.old\\y');
});

// A stand-in for an open page (tools/browser.mjs openBrowser) whose canvas is w x h RGBA rows,
// bottom first as readPixels gives them: ev() answers readFrame's injected code by posting `sent`
// (or what `post` makes of it) to the URL in that code, the way the page's fetch does.
function fakePage(w, h, { glError = 0, logs = [], post = (url, body) => [url, body] } = {}) {
  const pixels = Buffer.from(Array.from({ length: w * h * 4 }, (_, i) => (i * 31 + (i >> 9)) & 255));
  return {
    pixels,
    logs,
    async ev(expr) {
      const target = expr.match(/fetch\("([^"]+)"/)[1];
      if (glError) return [w, h, glError, 0];
      const [url, body] = post(target, pixels);
      const r = await fetch(url, { method: 'POST', body });
      return [w, h, 0, r.status];
    },
  };
}

test('readFrame: the posted pixels, rows turned top first, exactly as readCanvas gives them', async () => {
  const rx = await frameReceiver();
  try {
    assert.match(rx.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only');
    const [w, h] = [7, 5];
    const B = fakePage(w, h);
    const img = await readFrame(B, rx, 'test');
    assert.deepEqual([img.w, img.h], [w, h]);
    for (let y = 0; y < h; y++) {
      const want = B.pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4);
      assert.ok(Buffer.from(img.px.subarray(y * w * 4, (y + 1) * w * 4)).equals(want), `row ${y}`);
    }
  } finally {
    await rx.close();
  }
});

test('readFrame: a short frame, a WebGL error, a page error or bytes sent elsewhere is an error, never a frame', async () => {
  const rx = await frameReceiver();
  try {
    const short = fakePage(8, 4, { post: (url, body) => [url, body.subarray(0, body.length - 4)] });
    await assert.rejects(readFrame(short, rx, 'short'), /bytes came, wanted 8x4x4/);
    await assert.rejects(readFrame(fakePage(8, 4, { glError: 0x502 }), rx, 'gl'), /WebGL error 0x502/);
    await assert.rejects(readFrame(fakePage(8, 4, { logs: ['error: lost'] }), rx, 'logged'), /the page reported errors/);
    // posted under another frame's id (a stray or late body): refused, and this read fails
    const stray = fakePage(8, 4, { post: (url, body) => [url.replace(/\/frame\/\d+$/, '/frame/999999'), body] });
    await assert.rejects(readFrame(stray, rx, 'stray'), /not taken \(HTTP 404\)/);
    // the receiver still works after all that
    assert.equal((await readFrame(fakePage(8, 4), rx, 'after')).px.length, 8 * 4 * 4);
  } finally {
    await rx.close();
  }
});

test('wavInfo: finds the PCM data past the other chunks', () => {
  for (const odd of [false, true]) {
    const { bytes, data } = wav(1000, { odd });
    const w = wavInfo(bytes);
    assert.deepEqual([w.rate, w.channels, w.bits, w.samples], [48000, 2, 24, 1000]);
    assert.ok(bytes.subarray(w.offset, w.offset + data.length).equals(data));
  }
  const bad = wav(10).bytes;
  bad.writeUInt16LE(16, bad.indexOf('fmt ') + 8 + 14); // 16-bit
  assert.throws(() => wavInfo(bad), /24-bit/);
  assert.throws(() => wavInfo(Buffer.from('not a wav at all')), /WAV/);
});

test('pcmSlice: the WAV\'s samples byte for byte from a frame\'s time, then zero bytes to the length', () => {
  const { bytes, data } = wav(5000);
  // inside the WAV
  assert.ok(pcmSlice(bytes, 800, 1600).equals(data.subarray(800 * 6, 2400 * 6)));
  // over its end: the rest are zeros
  const tail = pcmSlice(bytes, 4000, 2400);
  assert.equal(tail.length, 2400 * 6);
  assert.ok(tail.subarray(0, 1000 * 6).equals(data.subarray(4000 * 6)));
  assert.ok(tail.subarray(1000 * 6).every((b) => b === 0));
  // past its end: all zeros
  const after = pcmSlice(bytes, 6000, 800);
  assert.equal(after.length, 800 * 6);
  assert.ok(after.every((b) => b === 0));
  // the whole of it
  assert.ok(pcmSlice(bytes, 0, 5000).equals(data));
});

test('verifyFrames: ten frames, the first, the last, both sides of the cut to black, the rest spread', () => {
  const all = verifyFrames(0, 3125);
  assert.equal(all.length, 10);
  for (const k of [0, 3124, 2824, 2825]) assert.ok(all.includes(k), `${k} in ${all}`);
  assert.deepEqual(all, [...all].sort((a, b) => a - b));
  // spread: no two of them closer than a twentieth of the video, but the two at the cut
  const gaps = all.slice(1).map((k, i) => k - all[i]).filter((g) => g > 1);
  assert.ok(Math.min(...gaps) > 3125 / 20, `${all}`);
  const hit = verifyFrames(2010, 120);
  assert.equal(hit.length, 10);
  assert.equal(hit[0], 2010);
  assert.equal(hit.at(-1), 2129);
  assert.equal(new Set(hit).size, 10);
  assert.ok(hit.every((k) => k >= 2010 && k <= 2129));
  const cut = verifyFrames(2790, 90);
  for (const k of [2790, 2879, 2824, 2825]) assert.ok(cut.includes(k), `${k} in ${cut}`);
  assert.deepEqual(verifyFrames(100, 4), [100, 101, 102, 103], 'a short file: every frame');
});

test('frameError: PSNR and the mean signed and absolute error per channel', () => {
  const a = Buffer.from([10, 20, 30, 40, 50, 60]);
  assert.equal(frameError(a, a).psnr, Infinity);
  const b = Buffer.from([12, 20, 29, 42, 50, 59]); // R +2 +2, G 0 0, B -1 -1
  const e = frameError(a, b);
  assert.deepEqual(e.bias, [2, 0, -1]);
  assert.deepEqual(e.mae, [2, 0, 1]);
  assert.equal(e.max, 2);
  assert.ok(Math.abs(e.psnr - 10 * Math.log10((255 * 255) / (10 / 6))) < 1e-9);
  assert.throws(() => frameError(a, Buffer.alloc(3)), /size/);
});

test('strayTags: only the title Fractal and the technical tags ffmpeg writes itself', () => {
  const tech = { major_brand: 'qt  ', minor_version: '512', compatible_brands: 'qt  ', encoder: 'Lavf63.1.102' };
  assert.deepEqual(strayTags({ ...tech, title: 'Fractal' }, { title: true }), []);
  assert.deepEqual(strayTags({ language: 'und', handler_name: 'VideoHandler', vendor_id: '[0][0][0][0]', encoder: 'Lavc63.1.102 libx264' }), []);
  assert.deepEqual(strayTags({ title: 'Fractal' }), ['title=Fractal'], 'no title on a stream');
  assert.deepEqual(strayTags({ title: 'Other' }, { title: true }), ['title=Other']);
  assert.deepEqual(strayTags({ comment: 'x', artist: 'y' }, { title: true }), ['comment=x', 'artist=y']);
  assert.deepEqual(strayTags({ handler_name: 'C:\\Users\\someone\\x.mp4' }), ['handler_name=C:\\Users\\someone\\x.mp4'], 'a path in a technical tag');
});

test('sideFile: the side file of a video is <name>.json beside it', () => {
  assert.equal(sideFile('a/b/t3_hit_4K.mov').replace(/\\/g, '/'), 'a/b/t3_hit.json');
  assert.equal(sideFile('a/b/Fractal_1080p.mov').replace(/\\/g, '/'), 'a/b/Fractal.json');
  assert.equal(sideFile('a/b/other.mov'), null);
});

test('the export\'s defaults are the video\'s settings, as the owner decided them at gate 4a', () => {
  // motion blur on (16 sub-frames over half a frame), sub-pixel jitter off, x264's grain tuning on;
  // CRF 14 for both sizes; the whole video, named Fractal, two workers
  assert.deepEqual({ ...EXPORT_DEFAULTS }, { sub: 16, shutter: 0.5, jitter: false, tune: 'grain', crf4k: 14, crf1080: 14, chunk: 10, workers: 2, name: 'Fractal' });
  assert.ok(TUNES.includes(EXPORT_DEFAULTS.tune));
  assert.ok(Object.isFrozen(EXPORT_DEFAULTS), 'nothing changes them while a tool runs');
});

test('nameProblem: --name and --as are a plain name, never a path, a dot or dots', () => {
  for (const n of ['Fractal', 'fx_defaults', 'test_a_plain_grain', 'a.b', 'a-b', 'x1']) assert.equal(nameProblem(n), null, n);
  // "." and ".." would make the chunk folder the temp folder or the one above it; Windows drops a
  // final dot, so "x." would be the render "x"
  for (const n of ['.', '..', '...', '.x', 'x.', 'a/b', 'a\\b', '../x', '', 'C:x', 'a b']) assert.ok(nameProblem(n), JSON.stringify(n));
});

// the export tool with flags it refuses before it touches anything. --workers=0 is refused too, after
// the names: should the names ever pass, the tool stops there all the same, drawing nothing
const exportTool = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'export_video.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

test('export_video.mjs: the usage names the defaults; a name that is not a plain name is refused at once', () => {
  const u = exportTool('--no-such-flag');
  assert.equal(u.status, 2, u.stdout + u.stderr);
  assert.match(u.stderr, /\[--sub=16\] \[--shutter=0\.5\] \[--jitter=0\]/);
  assert.match(u.stderr, /\[--crf4k=14\] \[--crf1080=14\]/);
  assert.match(u.stderr, /\[--tune=grain\|none\]/);
  assert.match(u.stderr, /\[--replace\]/);
  for (const bad of ['--name=..', '--name=.', '--as=.x', '--name=a/b', '--as=a\\b', '--name=x.']) {
    const r = exportTool(bad, '--workers=0', '--out=local-only/temp/never');
    assert.equal(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.startsWith(bad.split('=')[0] + '='), `${bad}: ${r.stderr}`);
  }
});

test('replaceProblems: a run replaces no chunks and no files made otherwise, unless --replace', () => {
  const render = { size: [3840, 2160], sub: 16, shutter: 0.5, jitter: false, commit: 'abc', chunk: ['-c:v', 'libx264rgb'] };
  const side = { k0: 0, frames: 3125, fps: 60, sub: 16, shutter: 0.5, jitter: false, crf4k: 14, crf1080: 14, tune: 'grain', commit: 'abc', wav: 'final.wav', render: 'Fractal' };
  const text = (o) => JSON.stringify(o, null, 2) + '\n';
  const files = ['Fractal_4K.mov', 'Fractal_1080p.mov'];
  const tags = ['00000-00599', '00600-01199'];
  const run = ({ had = render, want = render, chunks = tags, sideText = text(side), wantSide = side, there = files, reencode = false } = {}) =>
    replaceProblems({ render: reencode ? null : { name: 'Fractal', had, want, chunks }, outputs: { as: 'Fractal', files: there, side: sideText, want: wantSide } });

  // the same settings: it resumes the render, or encodes again, as before
  assert.deepEqual(run(), []);
  // a new name: nothing is there
  assert.deepEqual(run({ had: null, chunks: [], sideText: null, there: [] }), []);
  // each setting of the render that differs, while it has chunks
  for (const [k, v] of Object.entries({ size: [1920, 1080], sub: 1, shutter: 0, jitter: true, commit: 'def', chunk: ['-c:v', 'ffv1'] })) {
    const p = run({ want: { ...render, [k]: v } });
    assert.equal(p.length, 1, `${k}: ${p}`);
    assert.match(p[0], /render Fractal/);
    assert.ok(p[0].includes(`${k}: the chunks have `), `${k}: ${p[0]}`);
  }
  assert.match(run({ want: { ...render, jitter: true } })[0], /jitter: the chunks have false, this run true/);
  assert.match(run({ want: { ...render, jitter: true } })[0], /2 chunks/);
  // other settings, but no chunk drawn: nothing to lose
  assert.deepEqual(run({ want: { ...render, jitter: true }, chunks: [] }), []);
  // chunks without a settings.json: what they were drawn with is not known
  assert.match(run({ had: null }).join(), /no settings\.json/);
  // each key of the side file that differs
  for (const [k, v] of Object.entries({ k0: 2040, frames: 60, fps: 30, sub: 1, shutter: 0, jitter: true, crf4k: 18, crf1080: 18, tune: 'none', commit: 'def', wav: 'other.wav', render: 'other' })) {
    const p = run({ wantSide: { ...side, [k]: v } });
    assert.equal(p.length, 1, `${k}: ${p}`);
    assert.match(p[0], /Fractal_4K\.mov, Fractal_1080p\.mov and Fractal\.json/);
    assert.ok(p[0].includes(`${k}: the files have `), `${k}: ${p[0]}`);
  }
  // a passage against the whole video
  const part = run({ wantSide: { ...side, k0: 2040, frames: 60 } }).join();
  assert.match(part, /k0: the files have 0, this run 2040/);
  assert.match(part, /frames: the files have 3125, this run 60/);
  // videos without their side file: what they hold is not known
  assert.match(run({ sideText: null }).join(), /Fractal_4K\.mov and Fractal_1080p\.mov are there without the side file Fractal\.json/);
  assert.match(run({ sideText: null, there: ['Fractal_1080p.mov'] }).join(), /Fractal_1080p\.mov is there without/);
  // a side file that cannot be read, or that lacks a key, is not the same
  assert.match(run({ sideText: '{ not json' }).join(), /Fractal\.json cannot be read/);
  const { tune, ...older } = side;
  assert.equal(tune, 'grain');
  assert.match(run({ sideText: text(older) }).join(), /tune: the files have nothing, this run "grain"/);
  // only the side file there: replaced only when it is the same
  assert.deepEqual(run({ there: [] }), []);
  assert.match(run({ there: [], wantSide: { ...side, tune: 'none' } }).join(), /^Fractal\.json holds/);
  // a re-encode (--as) never removes chunks: only its own files are looked at
  assert.deepEqual(run({ reencode: true, want: { ...render, sub: 1 } }), []);
  assert.equal(run({ reencode: true, wantSide: { ...side, crf4k: 18 } }).length, 1);
  // both at once
  assert.equal(run({ want: { ...render, jitter: true }, wantSide: { ...side, jitter: true } }).length, 2);
});

// A stand-in for the file system: names -> contents. fail(op, a, b) says which calls fail, as
// Windows refuses to move or remove a file a player holds open (EBUSY).
function fakeFs(files, fail = () => false) {
  const all = new Map(Object.entries(files));
  const busy = (op, a, b) => {
    if (fail(op, a, b)) throw Object.assign(new Error(`EBUSY: resource busy or locked, ${op} '${a}'`), { code: 'EBUSY' });
  };
  return {
    files: all,
    now: () => Object.fromEntries([...all].sort()),
    exists: (p) => all.has(p),
    rename(a, b) {
      busy('rename', a, b);
      if (!all.has(a)) throw Object.assign(new Error(`ENOENT: ${a}`), { code: 'ENOENT' });
      all.set(b, all.get(a));
      all.delete(a);
    },
    remove(p) {
      busy('remove', p);
      all.delete(p);
    },
  };
}

test('renameTogether: the new files take the old ones\' places all together, or none does', () => {
  const moves = [['v_4K.part.mov', 'v_4K.mov'], ['v_1080p.part.mov', 'v_1080p.mov'], ['v.json.part', 'v.json']].map(([from, to]) => ({ from, to }));
  const fresh = { 'v_4K.part.mov': 'new 4K', 'v_1080p.part.mov': 'new 1080p', 'v.json.part': 'new side' };
  const old = { 'v_4K.mov': 'old 4K', 'v_1080p.mov': 'old 1080p', 'v.json': 'old side' };
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
  const done = sorted({ 'v_4K.mov': 'new 4K', 'v_1080p.mov': 'new 1080p', 'v.json': 'new side' });
  // nothing there before
  let f = fakeFs(fresh);
  assert.deepEqual(renameTogether(moves, f), { replaced: [], left: [] });
  assert.deepEqual(f.now(), done);
  // the old ones replaced, nothing of them left
  f = fakeFs({ ...fresh, ...old });
  assert.deepEqual(renameTogether(moves, f), { replaced: ['v_4K.mov', 'v_1080p.mov', 'v.json'], left: [] });
  assert.deepEqual(f.now(), done);
  // a player holds one of the old files: the old ones stay as they were, the new ones keep their
  // temporary names, and the message says so
  for (const held of Object.keys(old)) {
    f = fakeFs({ ...fresh, ...old }, (op, a) => a === held);
    assert.throws(() => renameTogether(moves, f), (e) => {
      assert.ok(e.message.startsWith(`moving ${held} aside failed (EBUSY: is a player or another program holding it open?)`), e.message);
      assert.match(e.message, /the old files are as they were \(v_4K\.mov, v_1080p\.mov, v\.json\); the new ones are under their temporary names: v_4K\.part\.mov, v_1080p\.part\.mov, v\.json\.part$/);
      return true;
    }, held);
    assert.deepEqual(f.now(), sorted({ ...fresh, ...old }), held);
  }
  // a new file that cannot be moved in (the last): the ones moved in go back, the old ones too
  f = fakeFs({ ...fresh, ...old }, (op, a) => op === 'rename' && a === 'v.json.part');
  assert.throws(() => renameTogether(moves, f), /^Error: moving v\.json\.part to v\.json failed \(EBUSY.*the old files are as they were/);
  assert.deepEqual(f.now(), sorted({ ...fresh, ...old }));
  // when putting one back fails too, the message says what each name holds now
  f = fakeFs({ ...fresh, ...old }, (op, a, b) => op === 'rename' && (a === 'v.json.part' || (a === 'v_1080p.mov' && b === 'v_1080p.part.mov') || a === 'v_1080p.mov.old'));
  assert.throws(() => renameTogether(moves, f), (e) => {
    assert.match(e.message, /putting them back failed: v_4K\.mov holds the old file \(the new one is v_4K\.part\.mov\); v_1080p\.mov holds the new file \(the old one is v_1080p\.mov\.old\); v\.json holds the old file \(the new one is v\.json\.part\)$/);
    return true;
  });
  assert.deepEqual(f.now(), sorted({ 'v_4K.mov': 'old 4K', 'v_4K.part.mov': 'new 4K', 'v_1080p.mov': 'new 1080p', 'v_1080p.mov.old': 'old 1080p', 'v.json': 'old side', 'v.json.part': 'new side' }));
  // the old one put back over a new one that could not go back: the old files are whole again
  f = fakeFs({ ...fresh, ...old }, (op, a, b) => op === 'rename' && (a === 'v.json.part' || (a === 'v_1080p.mov' && b === 'v_1080p.part.mov')));
  assert.throws(() => renameTogether(moves, f), /v_1080p\.mov holds the old file \(the new one is lost: the old one was put back over it\)/);
  assert.equal(f.files.get('v_1080p.mov'), 'old 1080p');
  // a name that held nothing before
  f = fakeFs({ ...fresh, 'v_4K.mov': 'old 4K' }, (op, a, b) => op === 'rename' && (a === 'v.json.part' || (a === 'v_4K.mov' && b === 'v_4K.part.mov')));
  assert.throws(() => renameTogether(moves, f), /v_4K\.mov holds the old file \(the new one is lost: the old one was put back over it\); v_1080p\.mov holds nothing \(the new one is v_1080p\.part\.mov\); v\.json holds nothing \(the new one is v\.json\.part\)$/);
  // an old file that cannot be removed at the end: the new ones are in place; it is named
  f = fakeFs({ ...fresh, ...old }, (op, a) => op === 'remove' && a === 'v.json.old');
  assert.deepEqual(renameTogether(moves, f), { replaced: ['v_4K.mov', 'v_1080p.mov', 'v.json'], left: ['v.json.old'] });
  assert.equal(f.files.get('v.json'), 'new side');
});

test('RENDER_FILE: the files the export makes in a chunk folder, and nothing else', () => {
  for (const n of ['00000-00599.mp4', '02010-02069.part.mp4', 'settings.json', 'list.txt', 'audio.s24le']) assert.ok(RENDER_FILE.test(n), n);
  for (const n of ['notes.txt', '00000-00599.mp4.bak', '0000-00599.mp4', 'Fractal_4K.mov', 'export', 'settings.json.old', 'video', '']) assert.ok(!RENDER_FILE.test(n), n);
});

// QuickTime atoms: a 32-bit size; 1 and a 64-bit size after the type; or 0, to the end of the file
function atom(type, body, form = 32) {
  if (form === 64) {
    const h = Buffer.alloc(16);
    h.writeUInt32BE(1, 0);
    h.write(type, 4, 'latin1');
    h.writeBigUInt64BE(BigInt(16 + body.length), 8);
    return Buffer.concat([h, body]);
  }
  const h = Buffer.alloc(8);
  h.writeUInt32BE(form === 0 ? 0 : 8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const reader = (buf) => (pos, n) => buf.subarray(pos, pos + n);

test('metadataRanges: all of a file but the payload of its media data atoms', () => {
  const ftyp = atom('ftyp', Buffer.from('qt  \0\0\x02\0qt  ', 'latin1'));
  const moov = atom('moov', atom('udta', Buffer.from('some metadata')));
  const media = Buffer.alloc(1000, 7);
  const a = Buffer.concat([ftyp, moov, atom('mdat', media)]); // faststart: the metadata first
  assert.deepEqual(metadataRanges(reader(a), a.length), [[0, ftyp.length + moov.length + 8]]);
  // the media first, in the large form, then the metadata
  const b = Buffer.concat([ftyp, atom('wide', Buffer.alloc(0)), atom('mdat', media, 64), moov, atom('free', Buffer.alloc(4))]);
  const m0 = ftyp.length + 8;
  assert.deepEqual(metadataRanges(reader(b), b.length), [[0, m0 + 16], [m0 + 16 + media.length, b.length]]);
  // to the end of the file
  const c = Buffer.concat([ftyp, moov, atom('mdat', media, 0)]);
  assert.deepEqual(metadataRanges(reader(c), c.length), [[0, ftyp.length + moov.length + 8]]);
  // a cut file: its media data runs to the end
  const d = a.subarray(0, a.length - 300);
  assert.deepEqual(metadataRanges(reader(d), d.length), [[0, ftyp.length + moov.length + 8]]);
  // what is not an atom ends the walk: from there on all is looked at
  const e = Buffer.concat([ftyp, Buffer.from([0, 0, 0, 3, 1, 2, 3, 4]), atom('mdat', media)]);
  assert.deepEqual(metadataRanges(reader(e), e.length), [[0, e.length]]);
  assert.deepEqual(metadataRanges(reader(Buffer.alloc(0)), 0), []);
});

test('privateKinds: a name in a file\'s metadata is found; the same bytes in its media data are not', () => {
  const kinds = [["the user's name", 'qzxkv'], ['the project folder', 'my-proj'], ['an empty one', '']];
  const name = Buffer.from('qzxkv');
  const media = Buffer.concat(Array.from({ length: 300 }, () => name)); // compressed data that holds it by chance
  const ftyp = atom('ftyp', Buffer.from('qt  '));
  const scan = (buf, block) => privateKinds(reader(buf), buf.length, kinds, block);
  const clean = Buffer.concat([ftyp, atom('moov', atom('udta', Buffer.from('title Fractal'))), atom('mdat', media)]);
  assert.ok(clean.includes(name), 'the bytes hold it');
  assert.deepEqual(scan(clean), []);
  // in the metadata, before or after the media, in UTF-8 or UTF-16, in blocks that cut it in two
  const meta = (text, enc = 'utf8') => atom('moov', atom('udta', Buffer.from(text, enc)));
  for (const block of [undefined, 3, 7, 64]) {
    assert.deepEqual(scan(Buffer.concat([ftyp, meta('C:\\Users\\qzxkv\\x'), atom('mdat', media)]), block), ["the user's name"], `block ${block}`);
    assert.deepEqual(scan(Buffer.concat([ftyp, atom('mdat', media), meta('C:/Users/qzxkv/x', 'utf16le')]), block), ["the user's name"], `block ${block}`);
    assert.deepEqual(scan(Buffer.concat([ftyp, atom('mdat', media), meta('D:\\my-proj\\a and qzxkv')]), block).sort(), ['the project folder', "the user's name"], `block ${block}`);
  }
  // in an atom of its own after the media
  assert.deepEqual(scan(Buffer.concat([ftyp, atom('mdat', media), atom('free', Buffer.from('xx qzxkv'))])), ["the user's name"]);
});

test('privateText on files ffmpeg wrote: a name in the tags is found, the same bytes in the audio are not', { skip: !hasFfmpeg && 'no ffmpeg on PATH' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-'));
  try {
    // a second of audio whose samples spell the name over and over, copied into the file as it is
    const pcm = Buffer.alloc(48000 * 6);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 'qzxkv'.charCodeAt(i % 5);
    const raw = path.join(dir, 'a.s24le');
    fs.writeFileSync(raw, pcm);
    const make = (name, meta) => {
      const out = path.join(dir, name);
      const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 's24le', '-sample_rate', '48000', '-ch_layout', 'stereo', '-i', raw, '-c:a', 'copy', '-map_metadata', '-1', ...meta, out], { windowsHide: true });
      assert.equal(r.status, 0, String(r.stderr));
      return out;
    };
    const kinds = [["the user's name", 'qzxkv']];
    const clean = make('clean.mov', ['-metadata', 'title=Fractal']);
    assert.ok(fs.readFileSync(clean).includes(Buffer.from('qzxkv')), 'the bytes hold it, in the audio');
    assert.deepEqual(privateText(clean, kinds), []);
    const tagged = make('tagged.mov', ['-metadata', 'title=Fractal', '-metadata', 'comment=C:\\Users\\qzxkv\\render']);
    assert.deepEqual(privateText(tagged, kinds), ["the user's name"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpegProblem: these tools need ffmpeg 5.1 or later (-fps_mode, -ch_layout), told by its release or its libavcodec', () => {
  assert.deepEqual(FFMPEG_MIN, { release: [5, 1], libavcodec: [59, 37] });
  const lib = (v) => `\nlibavutil      57. 28.100 / 57. 28.100\nlibavcodec     ${v} / ${v}\n`;
  assert.equal(ffmpegProblem('ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 16.2.0' + lib('63.  1.102')), null);
  for (const v of ['5.1', '5.1.4', 'n5.1.2', '6.0', '7.1.1-essentials_build-www.gyan.dev', '10.0']) assert.equal(ffmpegProblem(`ffmpeg version ${v} Copyright`), null, v);
  for (const v of ['5.0.1', '4.4.2-0ubuntu0.22.04.1', 'n4.3']) assert.match(ffmpegProblem(`ffmpeg version ${v} Copyright`), /^ffmpeg \S+ is too old: these tools need 5\.1 or later/, v);
  // a build from git names no release: its libavcodec tells
  assert.equal(ffmpegProblem('ffmpeg version N-113000-g0123abcd Copyright' + lib('60.  3.100')), null);
  assert.equal(ffmpegProblem('ffmpeg version 2024-03-04-git-e30369bc1c-full_build-www.gyan.dev' + lib('61.  1.100')), null);
  assert.equal(ffmpegProblem('ffmpeg version N-1 Copyright' + lib('59. 37.100')), null);
  assert.match(ffmpegProblem('ffmpeg version N-105000-gabc Copyright' + lib('59. 18.100')), /libavcodec 59\.18 is too old: these tools need 5\.1 or later \(libavcodec 59\.37\)/);
  assert.match(ffmpegProblem('ffmpeg version N-1 Copyright'), /cannot tell/);
});

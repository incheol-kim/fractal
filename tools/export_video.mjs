// The video export (design 10.3): every frame drawn by the page in headless Edge at 4K and kept
// losslessly in chunks; at the end one ffmpeg run encodes the 4K file and the 1080p file (the same
// frames reduced with Lanczos) from them and puts the final WAV's PCM into each MOV untouched.
//
//   node tools/export_video.mjs [--from=S] [--to=S] [--sub=16] [--shutter=0.5] [--jitter=0] [--chunk=10]
//                               [--workers=2] [--name=Fractal] [--as=<name>] [--out=<local-only/video>]
//                               [--crf4k=14] [--crf1080=14] [--tune=grain|none] [--drop-chunks] [--replace]
//   node tools/export_video.mjs --verify=<name>_4K.mov|<name>_1080p.mov [--k0=K --sub=N --shutter=X --jitter=0|1]
//
// The defaults are the video's settings, as the owner decided them at gate 4a (export_lib.mjs
// EXPORT_DEFAULTS: motion blur on, 16 sub-frames over a shutter of 0.5; sub-pixel jitter off; x264's
// grain tuning on; CRF 14 for both sizes): a bare `node tools/export_video.mjs` makes the video.
// --name and --as are plain names (export_lib.mjs nameProblem: no path, no leading or final dot).
//
// Frames: k = 0 ... 3124 drawn at t = k / 60 (the time is computed in the page, never printed and read
// back) by renderFrame(t, { sub, shutter, jitter }) (src/main.js) at 3840 x 2160, read as RGBA from
// the canvas (no HUD, no controls) as raw bytes posted to this process (tools/frame_reader.mjs: the
// same bytes as tools/browser.mjs readCanvas, about ten times sooner; each page's first frame is read
// both ways and the export stops if they differ). --from starts at the frame that
// holds that second, --to stops before the frames from that second on (cut at the end of the video;
// without it, to the end). --sub=1 is the picture as the browser shows it: --shutter and --jitter are
// then 0 (and must not be given otherwise). Paths are taken from the project folder.
//
// The render (--name): the passage is cut into chunks of --chunk seconds (tools/export_lib.mjs
// chunks). --workers browsers draw different chunks at once (a frame does not depend on which worker
// draws it), each streaming its frames into its own ffmpeg, which keeps them lossless
// (export_lib.mjs chunkArgs) in <TEMP>/export/<name>/<tag>.part.mp4, renamed to <tag>.mp4 when
// finished. A run that was stopped (killed, power, a closed window) and started again skips the
// finished chunks and makes a half-written one again. The folder's settings.json holds what the
// pictures depend on: the canvas size, sub, shutter, jitter, the page's commit and the chunks' format
// (each chunk's frames are in its tag); chunks drawn with others are never used. The encoder's
// settings are not in it: encoding again never draws again.
//
// The encode (--as, default --name): the chunks are read in order and one ffmpeg run encodes both
// sizes from them (export_lib.mjs muxArgs: --crf4k, --crf1080, --tune), so the chunks' seams leave
// nothing in the video, and copies in the audio: the WAV's samples from the first frame's time (frame
// k0: sample k0 x 800), sliced byte for byte in this process and padded with zero bytes to 800
// samples a frame, as raw pcm_s24le. It writes <out>/<as>_4K.mov, <out>/<as>_1080p.mov and the side
// file <out>/<as>.json ({ k0, frames, fps, sub, shutter, jitter, crf4k, crf1080, tune, commit, wav,
// render }: wav the file's name only, render the chunk folder's name) that --verify and the sync check
// read, each first under a temporary name (.part.mov, .json.part; a stopped encode is simply done
// again), the three then put in place together (export_lib.mjs renameTogether: should a player hold
// an old one, the old three stay as they were and it says so), and the log <out>/<as>.log
// (appended). The only metadata a person wrote is title=Fractal. With all chunks there, the render is
// skipped: --as with other encoder settings makes another encode of the same frames. An --as other
// than --name only re-encodes: when that render was made with other settings or lacks a chunk of the
// passage, it says what differs and stops, drawing and removing nothing. Finished chunks and videos are
// flushed to the disk before they are renamed. The log never holds a path of this machine
// (scrubPaths).
//
// Nothing made otherwise is replaced without --replace (export_lib.mjs replaceProblems): a run that
// would remove chunks drawn with other settings (or with settings not known), or replace files whose
// side file names another passage or other settings (or that have none), stops before it draws,
// writes or removes anything and says what differs. A run with the same settings resumes the render
// or encodes again, as it always did. In a chunk folder the export removes only its own files
// (export_lib.mjs RENDER_FILE). --drop-chunks removes the render's chunk folder (its chunks of every
// passage, its settings and list) once the files are in place, and logs what it removed.
//
// Processes: the browsers, the ffmpegs and the keep-awake PowerShell are started attached, and Node
// (libuv) puts every process it starts in a Windows job object that is closed, ending them, when
// this process ends in any way (an error, Ctrl+C, or killed from outside). Edge's own child processes
// (renderer, GPU, utilities) are not in the job (libuv lets its members' children break away): they
// end because their browser process has (Chromium's children quit when it goes). On an error or
// Ctrl+C everything is also closed here first. The frame receivers (one a page, 127.0.0.1 only, a
// free port) are closed with their page, and a killed process's ports are freed with it.
//
// --verify=<file> checks a written file against its side file (or --k0, --sub, --shutter, --jitter
// when there is none; a missing --jitter is the export's default): (a) the video's codec, size, rate,
// colour tags, frame count and length, every start time 0, the audio's format and length; the tags
// (title=Fractal and ffmpeg's technical ones only) and no path or name in the file's bytes outside its
// media data (video_io.mjs privateText: in hundreds of megabytes of compressed frames any short text
// turns up by chance); (b) the audio byte for byte against the WAV's same samples, then all zero;
// (c) ten frames (verifyFrames) decoded as a player shows them against renderFrame at the same time
// with the same sub-frames (the 1080p file's against the 4K frame reduced with the same Lanczos):
// PSNR at least 30 dB and a mean signed error of at most one level per channel (the right frame in
// the right colours; the encoder's fidelity is judged by eye), and, while the render's chunks are
// there, the same frames decoded from the chunks: PSNR at least 60 dB (two draws of a frame differ
// only in a few 4x MSAA edge pixels). When the page has changed since the export (the side file's
// commit against the page now), (c) is not made and fails. It writes nothing. Prints PASS or FAIL
// and exits 0 or 1.
//
// The export and --verify first check that ffmpeg is 5.1 or later (video_io.mjs ffmpegCheck).
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arg, subArg, startServer, openBrowser, readCanvas, freePort, pngSize, toRGB } from './browser.mjs';
import { ROOT, LOCAL, TEMP, VIDEO } from './paths.mjs';
import { FPS, SAMPLE_BYTES, TUNES, EXPORT_DEFAULTS, chunks, audioSamples, chunkArgs, muxArgs, wavInfo, pcmSlice, verifyFrames, frameError, strayTags, sideFile, nameProblem, reencodeProblem, replaceProblems, renameTogether, RENDER_FILE, scrubPaths } from './export_lib.mjs';
import { probe, decodeFrames, decodeAudio, resizeRGB, privateText, ffmpegCheck } from './video_io.mjs';
import { frameReceiver, readFrame } from './frame_reader.mjs';
import { VIDEO_END, CARD_TEXT } from '../src/card.js';

const WAV = path.join(ROOT, 'resources', 'Mixdown', '2026-11-07 fractal', '2026-11-07 fractal - final.wav');
// the final WAV is in the private repository only: without it the export and --verify stop, saying so
const needWav = () => {
  if (!fs.existsSync(WAV)) usage(`the final WAV is missing: ${show(WAV)} (the public repository does not include it)`);
};
const SIZE = [3840, 2160]; // the frames are drawn, read and kept at this size
const OUTPUTS = { '4K': [3840, 2160], '1080p': [1920, 1080] };
// what the page is made of: the chunks' commit is the last one that changed these
const PAGE = ['index.html', 'src', 'assets', 'vite.config.js', 'package.json', 'package-lock.json'];
const PSNR_MIN = 30; // dB, a frame of the video file against the page's frame (another frame: 7-26 dB)
const CHUNK_PSNR_MIN = 60; // dB, a frame of a chunk against the page's frame (two draws: about 93 dB)
// levels: the mean signed error of a channel. Measured (2026-11-19): correct files at CRF 14 up to
// 0.51 (blue); the same frame read with the BT.601 matrix -1.8 (red), read as full range -2.3 (red)
const BIAS_MAX = 1;
const CHUNK_FILE = /^(\d{5})-(\d{5})\.mp4$/; // a finished chunk: <first frame>-<last frame>.mp4
// what the log must not hold: this machine's project folder, home folder and user name (scrubPaths)
const HERE = { root: ROOT, home: os.homedir(), user: os.userInfo().username };

// the usage, its defaults from EXPORT_DEFAULTS (each flag's default first)
const D = EXPORT_DEFAULTS;
const USAGE = `usage: node tools/export_video.mjs [--from=S] [--to=S] [--sub=${D.sub}] [--shutter=${D.shutter}] [--jitter=${D.jitter ? 1 : 0}] [--chunk=${D.chunk}] [--workers=${D.workers}]
                                   [--name=${D.name}] [--as=<name>] [--out=<local-only/video>] [--crf4k=${D.crf4k}] [--crf1080=${D.crf1080}]
                                   [--tune=${[D.tune, ...TUNES.filter((t) => t !== D.tune)].join('|')}] [--drop-chunks] [--replace]
       node tools/export_video.mjs --verify=<name>_4K.mov|<name>_1080p.mov [--k0=K --sub=N --shutter=X --jitter=0|1]`;
function usage(why) {
  console.error(`${why}\n${USAGE}`);
  process.exit(2);
}
const FLAGS = ['from', 'to', 'sub', 'shutter', 'jitter', 'chunk', 'workers', 'name', 'as', 'out', 'crf4k', 'crf1080', 'tune', 'verify', 'k0'];
const SWITCHES = ['--drop-chunks', '--replace'];
const unknown = process.argv.slice(2).filter((a) => !SWITCHES.includes(a) && !FLAGS.some((k) => a.startsWith(`--${k}=`)));
if (unknown.length) usage(`unknown: ${unknown.join(' ')}`);

const given = (k) => arg(k) !== undefined;
const stamp = () => new Date().toLocaleString('sv-SE'); // 2026-11-19 18:44:12, local time
const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
const mib = (bytes) => bytes / 2 ** 20;
// a path for the log and the console: from the project folder, else its name alone (paths on this
// machine can hold a person's name)
function show(p) {
  const r = path.relative(ROOT, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : path.basename(p);
}

// renderFrame's sub-frames from the flags, with defaults: { sub, shutter, jitter }. --sub=1 is the
// frame as the browser shows it, so its shutter and jitter are 0 (giving others stops).
function subFrames(defaults) {
  const s = subArg();
  if (s === false) usage('--sub: a whole number, 1 or more; --shutter: 0 to 1; --jitter: 0 or 1');
  const sub = given('sub') ? s.sub : defaults.sub;
  const one = sub === 1;
  const shutter = given('shutter') ? s.shutter : one ? 0 : defaults.shutter;
  const jitter = given('jitter') ? s.jitter : one ? false : defaults.jitter;
  if (one && (shutter !== 0 || jitter)) usage('--sub=1 draws the frame as the browser shows it: its --shutter and --jitter are 0');
  return { sub, shutter, jitter };
}

// the page's version: the last commit that changed it, and a hash of its changes when it has some
function pageVersion() {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30, windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const commit = git(['log', '-1', '--format=%H', '--', ...PAGE]).toString().trim();
  const status = git(['status', '--porcelain', '--', ...PAGE]).toString().trim();
  if (!status) return commit;
  const changes = crypto.createHash('sha1').update(git(['diff', 'HEAD', '--binary', '--', ...PAGE])).update(status).digest('hex');
  return `${commit}+changes.${changes.slice(0, 12)}`;
}

// The settings a render's chunks are made with (settings.json): what the pictures depend on, and the
// chunks' own format
const renderSettings = (subs, commit) => ({ size: SIZE, ...subs, commit, chunk: chunkArgs({ size: SIZE, out: '<tag>.part.mp4' }) });

// A finished file's data on the disk before it is renamed to its final name: after a power cut a
// renamed chunk or video must hold all it says (the done-check counts its frames from the header).
function flush(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The finished chunks in a render's folder -> [{ k0, k1, file }] by first frame
function chunkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => f.match(CHUNK_FILE) && { k0: Number(f.slice(0, 5)), k1: Number(f.slice(6, 11)), file: path.join(dir, f) })
    .filter(Boolean)
    .sort((a, b) => a.k0 - b.k0);
}
const tagOf = (c) => path.basename(c.file, '.mp4');
const gib = (bytes) => (bytes / 2 ** 30).toFixed(2);
const chunksOf = (n) => `${n} chunk${n === 1 ? '' : 's'}`;

// the bytes of all the files in a folder
function folderBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0), 0);
}

// The export's own files in a chunk folder removed (export_lib.mjs RENDER_FILE), and nothing else ->
// { files, bytes, chunks: the finished chunks' tags among them, others: the names left there }
function clearRender(dir) {
  const gone = { files: 0, bytes: 0, chunks: [], others: [] };
  if (!fs.existsSync(dir)) return gone;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !RENDER_FILE.test(e.name)) {
      gone.others.push(e.name);
      continue;
    }
    const f = path.join(dir, e.name);
    gone.bytes += fs.statSync(f).size;
    fs.rmSync(f);
    gone.files++;
    if (CHUNK_FILE.test(e.name)) gone.chunks.push(path.basename(e.name, '.mp4'));
  }
  return gone;
}

// ---- the pages (headless Edge at 4K on this process's own Vite server)
const pages = new Set();
const KEY = pngSize(path.join(ROOT, 'assets', 'key_hires.png'));

async function closePage(B) {
  if (!B) return;
  pages.delete(B);
  await B.rx.close();
  await B.close();
}

// a page at 4K and its own frame receiver (tools/frame_reader.mjs: 127.0.0.1, a free port)
async function openPage(port) {
  const rx = await frameReceiver();
  let B;
  try {
    B = await openBrowser(`http://localhost:${port}/?w=${SIZE[0]}&h=${SIZE[1]}#t=0`, { w: SIZE[0], h: SIZE[1] });
  } catch (e) {
    await rx.close();
    throw e;
  }
  B.rx = rx;
  pages.add(B);
  try {
    const info = await B.ev('window.FR_INFO()');
    if (info.width !== SIZE[0] || info.height !== SIZE[1]) throw new Error(`the canvas is ${info.width}x${info.height}, wanted ${SIZE.join('x')}`);
    if (info.pictures[0] !== KEY[0]) throw new Error(`the pictures are ${info.pictures.join('x')}, wanted the full size ${KEY.join('x')}`);
    B.gpu = info.gpu;
    return B;
  } catch (e) {
    await closePage(B);
    throw e;
  }
}

// Frame k on page B: renderFrame at k / 60 (divided in the page: the exact number, never a printed
// one) with the sub-frames, then the canvas as raw bytes (frame_reader.mjs readFrame) -> { px (RGBA,
// rows top first), render, read (ms), checked }. The first frame of a page also checks that the page
// drew with those sub-frames (FR_INFO) and reads the same drawn frame again with readCanvas: the
// bytes must be identical (checked: their length), or the export stops (no retry).
async function drawFrame(B, k, subs) {
  const t0 = performance.now();
  await B.ev(`renderFrame(${k} / ${FPS}, ${JSON.stringify(subs)})`, 120000);
  const t1 = performance.now();
  const img = await readFrame(B, B.rx, `frame ${k}`);
  const t2 = performance.now();
  if (img.w !== SIZE[0] || img.h !== SIZE[1]) throw new Error(`frame ${k} is ${img.w}x${img.h}`);
  let checked = 0;
  if (!B.info) {
    const i = await B.ev('window.FR_INFO()');
    if (i.sub !== subs.sub || i.shutter !== subs.shutter || i.jitter !== subs.jitter) {
      throw new Error(`the page drew with sub ${i.sub} shutter ${i.shutter} jitter ${i.jitter}, wanted ${JSON.stringify(subs)}`);
    }
    const slow = await readCanvas(B, `frame ${k}`);
    if (!(slow.w === img.w && slow.h === img.h && Buffer.from(slow.px.buffer, slow.px.byteOffset, slow.px.byteLength).equals(Buffer.from(img.px.buffer, img.px.byteOffset, img.px.byteLength)))) {
      const e = new Error(`frame ${k}: the raw bytes from the page differ from readCanvas's for the same drawn frame: the fast read cannot be trusted`);
      e.fatal = true;
      throw e;
    }
    checked = img.px.byteLength;
    B.info = i;
  }
  return { px: img.px, render: t1 - t0, read: t2 - t1, checked };
}

// ---- the export
async function exportVideo() {
  // the names first: one that is not a plain name could make the chunk folder another folder
  const NAME = arg('name', D.name);
  const AS = arg('as', NAME);
  for (const [flag, n] of [['name', NAME], ['as', AS]]) {
    const p = nameProblem(n);
    if (p) usage(`--${flag}=${n}: ${p}`);
  }
  const subs = subFrames(D);
  const FROM = Number(arg('from', 0));
  const TO = given('to') ? Number(arg('to')) : VIDEO_END;
  const CHUNK = Number(arg('chunk', D.chunk));
  const WORKERS = Number(arg('workers', D.workers));
  const OUT = path.resolve(ROOT, arg('out', VIDEO));
  const CRF = { '4K': Number(arg('crf4k', D.crf4k)), '1080p': Number(arg('crf1080', D.crf1080)) };
  const TUNE = arg('tune', D.tune);
  const DROP = process.argv.includes('--drop-chunks');
  const REPLACE = process.argv.includes('--replace');
  if (!Number.isFinite(FROM) || !Number.isFinite(TO)) usage('--from and --to are seconds');
  if (!(CHUNK > 0)) usage('--chunk is seconds, more than 0');
  if (!(Number.isInteger(WORKERS) && WORKERS >= 1)) usage('--workers is a whole number, 1 or more');
  if (!Object.values(CRF).every((c) => Number.isFinite(c) && c >= 0 && c <= 51)) usage('--crf4k, --crf1080: 0 to 51');
  if (!TUNES.includes(TUNE)) usage(`--tune: ${TUNES.join(' or ')}`);
  const list = chunks(FROM, TO, CHUNK);
  if (!list.length) usage(`no frame of the video (0 to ${VIDEO_END.toFixed(4)} s) from ${FROM} s to ${TO} s`);
  const tools = ffmpegCheck(); // an ffmpeg too old stops here, not after the render
  if (tools.problem) usage(tools.problem);
  needWav();
  const wav = fs.readFileSync(WAV);
  wavInfo(wav); // 24-bit stereo PCM at 48 kHz, or stop

  const K0 = list[0].k0;
  const K1 = list.at(-1).k1;
  const FRAMES = K1 - K0 + 1;
  const CH = path.join(TEMP, 'export', NAME);

  // what this run makes and what is there, decided before anything is written: the render's
  // settings (chunks drawn with others are never used), the files and their side file
  const commit = pageVersion();
  const settings = renderSettings(subs, commit);
  const settingsFile = path.join(CH, 'settings.json');
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {}
  const outs = Object.keys(OUTPUTS).map((s) => ({ w: OUTPUTS[s][0], h: OUTPUTS[s][1], crf: CRF[s], tune: TUNE, out: path.join(OUT, `${AS}_${s}.part.mov`), final: path.join(OUT, `${AS}_${s}.mov`) }));
  const sidePath = path.join(OUT, `${AS}.json`);
  const side = { k0: K0, frames: FRAMES, fps: FPS, sub: subs.sub, shutter: subs.shutter, jitter: subs.jitter, crf4k: CRF['4K'], crf1080: CRF['1080p'], tune: TUNE, commit, wav: path.basename(WAV), render: NAME };
  let sideText = null;
  try {
    sideText = fs.readFileSync(sidePath, 'utf8');
  } catch {}
  const stopHere = (why) => {
    console.error(`STOPPED: ${why}. Nothing was drawn, encoded, written or removed.`);
    process.exit(1);
  };
  // --as other than --name re-encodes an existing render: it stops unless that render was made with
  // these settings and has every chunk (export_lib.mjs reencodeProblem). A re-encode never draws or
  // removes a chunk.
  const reencode = AS !== NAME;
  if (reencode) {
    const problem = reencodeProblem(NAME, old, settings, chunkFiles(CH).map(tagOf), list.map((c) => c.tag));
    if (problem) stopHere(`--as=${AS} re-encodes the render ${NAME}, but ${problem}`);
  }
  // chunks drawn otherwise and files made otherwise are replaced only with --replace
  const replacing = replaceProblems({
    render: reencode ? null : { name: NAME, had: old, want: settings, chunks: chunkFiles(CH).map(tagOf) },
    outputs: { as: AS, files: outs.filter((o) => fs.existsSync(o.final)).map((o) => path.basename(o.final)), side: sideText, want: side },
  });
  if (replacing.length && !REPLACE) stopHere(`${replacing.join('; and ')}. To replace them, run it again with --replace`);

  fs.mkdirSync(OUT, { recursive: true });
  const logFile = path.join(OUT, `${AS}.log`);
  const log = (s) => {
    const line = `${stamp()} ${scrubPaths(s, HERE)}`; // no path of this machine in the log
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };
  started.log = log;
  log(`export ${AS} from render ${NAME}: frames ${K0}..${K1} (${FRAMES} frames, ${(FRAMES / FPS).toFixed(4)} s from ${(K0 / FPS).toFixed(4)} s), sub ${subs.sub} shutter ${subs.shutter} jitter ${subs.jitter ? 1 : 0}, chunks of ${CHUNK} s (${list.length}), ${WORKERS} workers; encode CRF ${CRF['4K']} / ${CRF['1080p']}, tune ${TUNE}; page ${commit} | ${tools.version}`);
  if (commit.includes('+changes.')) log('the page has uncommitted changes: the chunks are tied to them (commit + a hash of the changes)');
  for (const r of replacing) log(`--replace: ${r}`);
  // the settings that differ, key by key as replaceProblems compares them (null: no settings.json)
  const changed = old && [...new Set([...Object.keys(settings), ...Object.keys(old)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(settings[k]));
  if (!reencode && (!old || changed.length)) {
    // a new render, or one drawn otherwise (only with --replace, above): the export's own files in
    // its folder are removed, nothing else
    const why = old ? `other settings: ${changed.join(', ')}` : 'no settings.json';
    const gone = clearRender(CH);
    if (gone.files) log(`the chunk folder ${show(CH)} (${why}): removed ${gone.files} files, ${gib(gone.bytes)} GiB, among them ${chunksOf(gone.chunks.length)}`);
    if (gone.others.length) log(`the chunk folder ${show(CH)} also holds ${gone.others.join(', ')}, not the export's: left there`);
    fs.mkdirSync(CH, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  const refuse = (why) => {
    log(`STOPPED: --as=${AS} re-encodes the render ${NAME}, but ${why}. Nothing was drawn, encoded or removed.`);
    process.exit(1);
  };

  // finished chunks (the file there, with its frames) are skipped
  const finalOf = (c) => path.join(CH, `${c.tag}.mp4`);
  const todo = [];
  for (const c of list) {
    const f = finalOf(c);
    const frames = fs.existsSync(f) ? await probe(f, { count: false }).then((p) => p.video && p.video.frames, () => null) : null;
    if (frames === c.k1 - c.k0 + 1) log(`chunk ${c.tag}: done before, skipped`);
    else if (reencode) refuse(`its chunk ${c.tag} does not hold its ${c.k1 - c.k0 + 1} frames (${frames ?? 'unreadable'})`);
    else todo.push(c);
  }
  log(`ffmpeg for a chunk (in ${show(CH)}): ffmpeg ${settings.chunk.join(' ')}`);

  // keep Windows awake and the display on while this process runs (an occluded or sleeping display
  // can stop a browser's frames): ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, held by
  // the PowerShell thread until it ends (with this process)
  const awake = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(2147483651) | Out-Null; while ($true) { Start-Sleep 60 }`], { stdio: 'ignore', windowsHide: true });
  started.children.add(awake);

  const began = Date.now();
  const total = todo.reduce((n, c) => n + c.k1 - c.k0 + 1, 0);
  let done = 0;
  if (todo.length) {
    const port = await freePort();
    started.server = await startServer(port);
    const progress = setInterval(() => {
      const s = (Date.now() - began) / 1000;
      const rate = done / s;
      console.log(`${stamp()}   ${done} / ${total} frames, ${rate > 0 ? (1 / rate).toFixed(2) : '-'} s a frame, about ${rate > 0 ? (((total - done) / rate) / 60).toFixed(1) : '-'} min to go (Node heap ${mib(process.memoryUsage().heapUsed).toFixed(0)} MiB)`);
    }, 30000);
    progress.unref();
    const queue = todo.slice();
    let memoryLogged = false;

    async function worker(id) {
      let B = await openPage(port);
      if (id === 1) log(`GPU ${B.gpu} | canvas ${SIZE.join('x')}`);
      // a frame that fails is drawn again once, in a fresh browser (a lost context, a stall); a read
      // that differs from readCanvas is not
      const frame = async (k) => {
        try {
          return await drawFrame(B, k, subs);
        } catch (e) {
          if (e.fatal) throw e;
          log(`worker ${id}: frame ${k}: ${firstLine(e)}; drawing it again in a fresh browser`);
          await closePage(B);
          B = null;
          B = await openPage(port);
          return drawFrame(B, k, subs);
        }
      };
      try {
        for (let c; (c = queue.shift()); ) {
          const n = c.k1 - c.k0 + 1;
          const part = `${c.tag}.part.mp4`;
          const ff = spawn('ffmpeg', chunkArgs({ size: SIZE, out: part }), { cwd: CH, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
          started.children.add(ff);
          let err = '';
          ff.stderr.on('data', (d) => (err += d));
          ff.stdin.on('error', () => {}); // an ffmpeg that ended early: its exit code says why
          const exit = new Promise((r) => ff.on('close', (code) => r(code)));
          const t0 = Date.now();
          const sum = { render: 0, read: 0, wait: 0 };
          log(`worker ${id}: chunk ${c.tag} started`);
          for (let k = c.k0; k <= c.k1; k++) {
            const f = await frame(k);
            sum.render += f.render;
            sum.read += f.read;
            if (f.checked) log(`worker ${id}: frame ${k} read as raw bytes is identical to readCanvas's read of it (${f.checked} bytes)`);
            if (!memoryLogged) {
              memoryLogged = true;
              const m = B.info.memory; // after the first frame: the sub-frame targets are made
              const mb = (x) => mib(x).toFixed(0);
              log(`GPU memory of one page (FR_INFO().memory): ${mb(Object.values(m).reduce((a, b) => a + b, 0))} MiB (collage ${mb(m.collage)}, life ${mb(m.life)}, picture in picture ${mb(m.pip)}, card ${mb(m.card)}, sub-frames ${mb(m.subframes)}), besides the canvas and the page's other targets`);
            }
            const w0 = performance.now();
            if (!ff.stdin.write(Buffer.from(f.px.buffer, f.px.byteOffset, f.px.byteLength))) {
              // drained, or ffmpeg ended (a broken pipe: then its exit code and error text tell why)
              const code = await Promise.race([once(ff.stdin, 'drain').then(() => null, () => exit), exit]);
              if (code !== null) throw new Error(`ffmpeg ended (exit ${code}) in chunk ${c.tag}: ${err.trim().slice(0, 600)}`);
            }
            sum.wait += performance.now() - w0;
            done++;
          }
          ff.stdin.end();
          const code = await exit;
          started.children.delete(ff);
          if (code !== 0) throw new Error(`ffmpeg exit ${code} in chunk ${c.tag}: ${err.trim().slice(0, 600)}`);
          flush(path.join(CH, part));
          fs.renameSync(path.join(CH, part), finalOf(c));
          const sec = (Date.now() - t0) / 1000;
          const per = (x) => (x / n).toFixed(0);
          log(`worker ${id}: chunk ${c.tag} done in ${sec.toFixed(1)} s, ${(sec / n).toFixed(3)} s a frame (draw ${per(sum.render)} ms, read ${per(sum.read)} ms, waiting for ffmpeg ${per(sum.wait)} ms), ${mib(fs.statSync(finalOf(c)).size / n).toFixed(2)} MiB a frame`);
        }
      } finally {
        await closePage(B);
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, (_, i) => worker(i + 1)));
    clearInterval(progress);
    await started.server.close();
    started.server = null;
    if (pageVersion() !== commit) {
      // without its settings.json the next run does not use these chunks: it stops at them, and
      // with --replace draws them again
      fs.rmSync(settingsFile, { force: true });
      throw new Error("the page changed during the export, so its frames may be of two versions: the chunk folder's settings.json is removed, and the next run stops at its chunks; run it with --replace to draw them again");
    }
    const sec = (Date.now() - began) / 1000;
    log(`render: ${total} frames drawn in ${sec.toFixed(0)} s: ${(sec / total).toFixed(3)} s a frame with ${Math.min(WORKERS, todo.length)} workers`);
  }
  // this passage's chunks, and the whole folder (other passages of the render may share it)
  const chunkBytes = list.reduce((n, c) => n + fs.statSync(finalOf(c)).size, 0);
  const otherChunks = chunkFiles(CH).map(tagOf).filter((t) => !list.some((c) => c.tag === t));
  log(`chunks of this passage: ${list.length} files, ${gib(chunkBytes)} GiB, ${mib(chunkBytes / FRAMES).toFixed(2)} MiB a frame; the chunk folder ${show(CH)}: ${gib(folderBytes(CH))} GiB in all${otherChunks.length ? `, with ${chunksOf(otherChunks.length)} of other passages (${otherChunks.join(', ')})` : ''}`);

  // one encode of both sizes from the chunks, with the audio
  fs.writeFileSync(path.join(CH, 'audio.s24le'), pcmSlice(wav, audioSamples(K0), audioSamples(FRAMES)));
  fs.writeFileSync(path.join(CH, 'list.txt'), list.map((c) => `file '${c.tag}.mp4'\n`).join(''));
  const args = muxArgs({ video: 'list.txt', pcm: 'audio.s24le', outputs: outs });
  log(`ffmpeg for the files (in ${show(CH)}): ffmpeg ${args.map((a) => (outs.some((o) => o.out === a) ? show(a) : a)).join(' ')}`);
  const e0 = Date.now();
  const ff = spawn('ffmpeg', args, { cwd: CH, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  started.children.add(ff);
  let err = '';
  ff.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => ff.on('close', r));
  started.children.delete(ff);
  if (code !== 0) throw new Error(`encoding: ffmpeg exit ${code}: ${err.trim().slice(0, 600)}`);
  const encodeSec = (Date.now() - e0) / 1000;
  log(`encode: ${FRAMES} frames into both files in ${encodeSec.toFixed(1)} s: ${(FRAMES / encodeSec).toFixed(2)} frames a second`);
  // the side file too under a temporary name; then the three take the old ones' places together:
  // never new videos beside an old side file
  const sidePart = `${sidePath}.part`;
  fs.writeFileSync(sidePart, JSON.stringify(side, null, 2) + '\n');
  for (const f of [...outs.map((o) => o.out), sidePart]) flush(f);
  let placed;
  try {
    placed = renameTogether([...outs.map((o) => ({ from: o.out, to: o.final })), { from: sidePart, to: sidePath }], { exists: fs.existsSync, rename: fs.renameSync, remove: fs.rmSync }, show);
  } catch (e) {
    throw new Error(`the new files could not take the old ones' places: ${e.message}. Once nothing holds the file, the same command makes them again (the chunks are there: it only encodes again)`);
  }
  if (placed.replaced.length) log(`replaced ${placed.replaced.map(show).join(', ')}`);
  if (placed.left.length) log(`could not remove the old ${placed.left.map(show).join(', ')}: remove it by hand`);
  fs.rmSync(path.join(CH, 'audio.s24le'), { force: true });
  if (DROP) {
    // the render's folder: the export's own files in it (every passage's chunks, settings.json, the
    // list), then the folder when nothing else is left in it
    const gone = clearRender(CH);
    const others = gone.chunks.filter((t) => !list.some((c) => c.tag === t));
    let folder = false;
    if (!gone.others.length) {
      try {
        fs.rmdirSync(CH);
        folder = true;
      } catch {}
    }
    log(`--drop-chunks: removed ${gone.files} files of ${show(CH)}, ${gib(gone.bytes)} GiB: ${chunksOf(gone.chunks.length)}${others.length ? ` (${others.length} of them of other passages: ${others.join(', ')})` : ''} and the render's settings and list; ${folder ? 'and the folder' : `the folder is left${gone.others.length ? `, with ${gone.others.join(', ')} (not the export's)` : ''}`}`);
  }
  const sec = (Date.now() - began) / 1000;
  const sizesText = outs.map((o) => `${show(o.final)} ${mib(fs.statSync(o.final).size).toFixed(1)} MiB`).join(', ');
  log(`done: ${FRAMES} frames (${K0}..${K1}), ${(FRAMES / FPS).toFixed(4)} s, ${audioSamples(FRAMES)} audio samples; ${(sec / 60).toFixed(1)} min; ${sizesText}; side file ${show(sidePath)}`);
}

// ---- --verify
async function verify(fileArg) {
  const file = path.resolve(ROOT, fileArg);
  const m = path.basename(file).match(/_(4K|1080p)\.mov$/);
  if (!m) usage('--verify takes <name>_4K.mov or <name>_1080p.mov');
  if (!fs.existsSync(file)) usage(`no such file: ${show(file)}`);
  needWav(); // (b) compares the audio with it
  const tools = ffmpegCheck();
  if (tools.problem) usage(tools.problem);
  const [W, H] = OUTPUTS[m[1]];
  const sf = sideFile(file);
  let side = null;
  if (fs.existsSync(sf)) {
    if (['k0', 'sub', 'shutter', 'jitter'].some(given)) usage(`the side file ${path.basename(sf)} gives k0, sub, shutter and jitter`);
    side = JSON.parse(fs.readFileSync(sf, 'utf8'));
    if (side.wav !== path.basename(WAV)) usage(`the side file names another WAV (${side.wav})`);
  } else if (!['k0', 'sub', 'shutter'].every(given)) {
    usage(`no side file ${path.basename(sf)}: give --k0, --sub and --shutter (and --jitter)`);
  }
  // without a side file the flags; a missing --jitter is the export's default
  const subs = side ? { sub: side.sub, shutter: side.shutter, jitter: side.jitter } : subFrames({ jitter: D.jitter });
  const k0 = side ? side.k0 : Number(arg('k0'));
  if (!(Number.isInteger(k0) && k0 >= 0)) usage('--k0 is a frame number');
  const results = [];
  const check = (ok, line) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
  };
  console.log(`verify ${show(file)}: ${side ? `side file ${path.basename(sf)}` : 'flags'}: first frame ${k0}, sub ${subs.sub} shutter ${subs.shutter} jitter ${subs.jitter ? 1 : 0}${side ? `; encoded CRF ${side.crf4k} / ${side.crf1080}, tune ${side.tune}; render ${side.render}` : ''}`);

  // (a) the streams
  const p = await probe(file);
  const { video: v, audio: a } = p;
  if (!v || !a) {
    check(false, `streams: ${v ? 'video' : 'no video'}, ${a ? 'audio' : 'no audio'}`);
    return results;
  }
  const frames = side ? side.frames : v.frames;
  check(v.codec === 'h264' && v.profile === 'High' && v.pixFmt === 'yuv420p' && v.width === W && v.height === H && v.fps === FPS, `video: ${v.codec} ${v.profile} ${v.pixFmt} ${v.width}x${v.height} at ${v.fps} fps`);
  check(v.matrix === 'bt709' && v.primaries === 'bt709' && v.transfer === 'bt709' && v.range === 'tv', `colour tags: matrix ${v.matrix}, primaries ${v.primaries}, transfer ${v.transfer}, range ${v.range} (want bt709 and tv: limited)`);
  check(v.frames === frames && v.headerFrames === frames, `video frames: ${v.frames} counted, ${v.headerFrames} in the header, want ${frames}`);
  check(Math.abs(v.duration - frames / FPS) < 1e-5, `video length: ${v.duration} s, want ${(frames / FPS).toFixed(6)} s`);
  check(v.start === 0 && a.start === 0 && p.format.start === 0, `start times: video ${v.start}, audio ${a.start}, container ${p.format.start}`);
  check(a.codec === 'pcm_s24le' && a.rate === 48000 && a.channels === 2, `audio: ${a.codec}, ${a.rate} Hz, ${a.channels} channels (${a.layout})`);
  check(a.samples === audioSamples(frames), `audio length: ${a.samples} samples (${a.duration} s), want ${audioSamples(frames)}`);
  const list = (t) => Object.entries(t).map(([k, x]) => `${k}=${x}`).join(' ') || '-';
  console.log(`      tags: container: ${list(p.format.tags)} | video: ${list(v.tags)} | audio: ${list(a.tags)}`);
  const stray = [...strayTags(p.format.tags, { title: true }), ...strayTags(v.tags), ...strayTags(a.tags)];
  check(p.format.tags.title === 'Fractal' && !stray.length, `metadata: title=Fractal and ffmpeg's technical tags only${stray.length ? `; also: ${stray.join(', ')}` : ''}`);
  // the private names, in the file's bytes outside its media data (video_io.mjs privateText): never
  // the names themselves in a message, only their kinds
  const found = privateText(file, [
    ['the project folder', path.basename(ROOT)],
    ['the local-only folder', path.basename(LOCAL)],
    ["the WAV's name", path.basename(WAV, '.wav')],
    ["the user's name", os.userInfo().username],
    ["the end card's name", CARD_TEXT.name],
  ]);
  check(!found.length, `the file's bytes outside its media data hold no path, folder, user name or person's name${found.length ? `: found ${found.join(', ')}` : ''}`);

  // (b) the audio, byte for byte
  const wav = fs.readFileSync(WAV);
  const { offset, samples } = wavInfo(wav);
  const got = await decodeAudio(file);
  const s0 = audioSamples(k0);
  const n = audioSamples(frames);
  const inWav = Math.max(0, Math.min(n, samples - s0));
  const want = wav.subarray(offset + s0 * SAMPLE_BYTES, offset + (s0 + inWav) * SAMPLE_BYTES);
  const head = got.subarray(0, inWav * SAMPLE_BYTES);
  const same = head.equals(want);
  let differ = -1;
  if (!same) for (differ = 0; differ < Math.min(head.length, want.length) && head[differ] === want[differ]; differ++);
  const tail = got.subarray(inWav * SAMPLE_BYTES);
  const zero = tail.every((b) => b === 0);
  check(got.length === n * SAMPLE_BYTES && same && zero,
    `audio bytes: ${got.length} (${got.length / SAMPLE_BYTES} samples, want ${n}); samples ${s0}..${s0 + inWav - 1} of the WAV byte for byte: ${same ? 'the same' : `DIFFERENT from byte ${differ} (sample ${s0 + Math.floor(differ / SAMPLE_BYTES)})`}; the ${n - inWav} after them: ${zero ? 'all zero' : 'NOT all zero'}`);

  // the pictures can only be compared with the page they were drawn by
  const pageNow = pageVersion();
  if (side && side.commit !== pageNow) {
    console.log(`      the page: ${side.commit} at the export, ${pageNow} now`);
    check(false, 'pictures: the page has changed since the export, so its frames cannot be compared with what the page draws now (not compared)');
    return results;
  }
  if (!side) console.log(`      the page's version at the export is not known (no side file); compared with the page as it is now (${pageNow})`);

  // the render's chunks, when they are still there and were made with the same settings
  let chunkList = [];
  if (side && side.render) {
    const dir = path.join(TEMP, 'export', side.render);
    let st = null;
    try {
      st = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    } catch {}
    const same = st && st.sub === subs.sub && st.shutter === subs.shutter && st.jitter === subs.jitter && st.commit === side.commit;
    chunkList = same ? chunkFiles(dir) : [];
    console.log(`      chunks of render ${side.render}: ${chunkList.length ? `${chunkList.length} in ${show(dir)}` : st ? 'made with other settings since: not compared' : 'not there (removed, or the temp folder was cleared): not compared'}`);
  }

  // (c) ten frames against the page's
  const ks = verifyFrames(k0, frames);
  const port = await freePort();
  started.server = await startServer(port);
  const B = await openPage(port);
  try {
    console.log(`      frames ${ks.join(', ')} | GPU ${B.gpu}${m[1] === '1080p' ? ' | the 4K frame reduced with Lanczos' : ''}`);
    const f = (xs) => xs.map((x) => x.toFixed(3)).join(' ');
    for (const k of ks) {
      const { px } = await drawFrame(B, k, subs);
      const page = toRGB(px);
      const ref = m[1] === '1080p' ? await resizeRGB(page, SIZE, [W, H]) : page;
      const [dec] = await decodeFrames(file, k - k0, 1);
      const e = frameError(ref, dec);
      check(e.psnr >= PSNR_MIN && e.bias.every((b) => Math.abs(b) <= BIAS_MAX),
        `frame ${k}: PSNR ${e.psnr.toFixed(2)} dB (>= ${PSNR_MIN}); mean error R G B ${f(e.bias)} (|x| <= ${BIAS_MAX}); mean |error| ${f(e.mae)}; max ${e.max}`);
      const c = chunkList.find((x) => x.k0 <= k && k <= x.k1);
      if (c) {
        const [kept] = await decodeFrames(c.file, k - c.k0, 1);
        const ce = frameError(page, kept);
        check(ce.psnr >= CHUNK_PSNR_MIN, `  chunk ${path.basename(c.file)} frame ${k}: PSNR ${ce.psnr === Infinity ? 'identical' : `${ce.psnr.toFixed(2)} dB`} (>= ${CHUNK_PSNR_MIN}); max ${ce.max}`);
      } else if (chunkList.length) {
        check(false, `  chunk for frame ${k}: none in the render's folder`);
      }
    }
  } finally {
    await closePage(B);
    await started.server.close();
    started.server = null;
  }
  return results;
}

// ---- what is running, for an orderly stop on an error or Ctrl+C (a kill from outside ends the
// children through the job object instead)
const started = { children: new Set(), server: null, log: null };
let stopping = false;
async function stop(e) {
  if (stopping) return;
  stopping = true;
  // the message, its stack and any ffmpeg error text in it, with the paths of this machine taken out
  const text = scrubPaths('FAILED: ' + ((e && e.stack) || e), HERE);
  if (started.log) started.log(text);
  else console.error(text);
  for (const p of started.children) {
    try {
      p.kill();
    } catch {}
  }
  await Promise.race([Promise.all([...pages].map((B) => closePage(B).catch(() => {}))), new Promise((r) => setTimeout(r, 15000))]);
  if (started.server) await started.server.close().catch(() => {});
  process.exit(1);
}
process.on('unhandledRejection', stop);
process.on('uncaughtException', stop);
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => stop(new Error(`stopped (${sig})`)));

if (given('verify')) {
  const results = await verify(arg('verify')).catch(stop);
  const ok = results.length && results.every(Boolean);
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
} else {
  await exportVideo().catch(stop);
  for (const p of started.children) p.kill();
  process.exit(0);
}

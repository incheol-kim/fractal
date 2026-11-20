// The export's pure part (tools/export_video.mjs; tested by test/export.test.js): the defaults, which
// frames a passage holds and how it is cut into chunks, the audio's length, the ffmpeg arguments, the
// WAV's PCM sliced and padded byte for byte, what a run may replace and how new files take the old
// ones' places, what --verify looks at, and which ffmpeg the tools need. No files, no processes (where
// a decision reads a file or moves one, the reading or moving is handed in).
//
// The video's frame k is drawn at t = k / 60 (k = 0 ... 3124, VIDEO_END = 52.08 s); one frame is
// 800 samples of the 48 kHz audio.
import path from 'node:path';
import { FPS } from '../src/subframes.js';
import { VIDEO_END } from '../src/card.js';
import { DUR } from '../src/music.js';

export { FPS };
export const RATE = 48000; // the audio's sample rate: the final WAV's, never changed
export const SAMPLE_BYTES = 6; // one stereo sample of signed 24-bit PCM
const PER_FRAME = RATE / FPS; // 800 samples a frame

// the frame that holds time s: the last k with k / 60 <= s (0 before the start)
export function frameAt(s) {
  let k = Math.floor(s * FPS);
  if ((k + 1) / FPS <= s) k++;
  if (k / FPS > s) k--;
  return Math.max(0, k);
}

// the number of frames before time end: the k >= 0 with k / 60 < end (3125 for VIDEO_END)
export function frameCount(end) {
  let n = Math.max(0, Math.ceil(end * FPS));
  while (n > 0 && (n - 1) / FPS >= end) n--;
  while (n / FPS < end) n++;
  return n;
}

// the audio samples of that many frames
export function audioSamples(frames) {
  return frames * PER_FRAME;
}

const tagOf = (k0, k1) => `${String(k0).padStart(5, '0')}-${String(k1).padStart(5, '0')}`;

// The frames from the one that holds from up to those before to (to is cut at the end of the
// video; undefined: to the end), in chunks of chunkSeconds from the first: [{ tag, k0, k1 }], k1 the
// chunk's last frame (inclusive), tag made of k0 and k1. Chunks cover the passage once, in order.
export function chunks(from = 0, to = VIDEO_END, chunkSeconds = 10) {
  const per = Math.round(chunkSeconds * FPS);
  if (!(per >= 1)) throw new Error(`a chunk is at least one frame (not ${chunkSeconds} s)`);
  const first = frameAt(from);
  const end = Math.min(frameCount(to), frameCount(VIDEO_END)); // exclusive
  const out = [];
  for (let k0 = first; k0 < end; k0 += per) {
    const k1 = Math.min(k0 + per, end) - 1;
    out.push({ tag: tagOf(k0, k1), k0, k1 });
  }
  return out;
}

// A chunk: the canvas's RGBA frames (rows top first) of size [w, h] at 60 fps from the standard
// input, kept lossless as RGB (H.264 in RGB at qp 0: libx264rgb; decoded, its frames are the bytes
// that were sent, alpha aside, which the canvas gives as 255), a key frame every 60 frames, into out
// (an .mp4: exact 1/15360 timestamps and a frame count in the header). Measured on 60 rendered 4K
// frames: 4.1 MiB a frame (raw RGBA 31.6; FFV1 6.8: this one also predicts between frames, and the
// picture holds still between its 12 fps steps), 0.03 s a frame to encode.
export function chunkArgs({ size: [w, h], out }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'veryfast', '-g', String(FPS), '-pix_fmt', 'rgb24',
    '-map_metadata', '-1',
    out,
  ];
}

// The one conversion of the canvas's RGB (display values, sRGB-encoded) into what the file holds:
// the scaler resizes with Lanczos (the 4K output keeps its size; only its chroma is filtered) and
// converts to limited-range BT.709 Y'CbCr 4:2:0 at once; full_chroma_inp takes the chroma from every
// pixel, not from pairs; setparams then tags the frames (primaries, transfer, matrix, range) without
// touching a value, so the encoder and the container say BT.709 too. Measured round trip (lossless
// x264): mean signed error per channel within +-0.03 of a level. From a decoded chunk (gbrp) the
// filter gives the same bytes as from the canvas's RGBA (checked at both sizes).
const SWS = 'lanczos+accurate_rnd+full_chroma_int+full_chroma_inp';
const TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
export const TUNES = ['none', 'grain']; // x264's -tune: none (as it is) or grain

// ffmpeg's video options for one output: the frames (input 0) at w x h, H.264 High at crf, preset
// slow (tune grain: x264's -tune grain), a key frame every 60 frames
export function encodeArgs({ w, h, crf, tune = 'none' }) {
  if (!TUNES.includes(tune)) throw new Error(`tune is ${TUNES.join(' or ')} (not ${tune})`);
  return [
    '-map', '0:v:0',
    '-vf', `scale=${w}:${h}:flags=${SWS}:out_color_matrix=bt709:out_range=tv,format=yuv420p,${TAGS}`,
    '-c:v', 'libx264', '-preset', 'slow', ...(tune === 'none' ? [] : ['-tune', tune]), '-crf', String(crf), '-profile:v', 'high', '-g', String(FPS),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ];
}

// The final files, in one run: the chunks read in order (video, a concat list) and decoded once,
// every output [{ w, h, crf, tune, out }] encoded from them (encodeArgs; one encode over the whole
// passage, so the chunks' seams leave nothing in it), and the audio (pcm, raw signed 24-bit
// little-endian stereo at 48 kHz: pcmSlice's bytes) copied into each MOV as it is. No resampling,
// level, filter or lossy codec can touch a sample: the audio is never decoded. The only metadata a
// person wrote is the title; the moov goes first for playback.
export function muxArgs({ video, pcm, outputs }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-i', video,
    '-f', 's24le', '-sample_rate', String(RATE), '-ch_layout', 'stereo', '-c:a', 'pcm_s24le', '-i', pcm,
    ...outputs.flatMap((o) => [
      ...encodeArgs(o),
      '-map', '1:a:0', '-c:a', 'copy',
      '-map_metadata', '-1', '-map_chapters', '-1', '-metadata', 'title=Fractal',
      '-movflags', '+faststart',
      o.out,
    ]),
  ];
}

// A WAV file's bytes -> { rate, channels, bits, offset, samples }: the PCM data chunk's place and
// length, past any other chunk (the final WAV has JUNK, fact, bext and acid). Throws unless it is
// 24-bit stereo PCM at 48 kHz.
export function wavInfo(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', p, p + 4);
    const n = bytes.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      const tag = bytes.readUInt16LE(p + 8);
      // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes say PCM (1)
      const pcm = tag === 1 || (tag === 0xfffe && n >= 40 && bytes.readUInt16LE(p + 8 + 24) === 1);
      fmt = { pcm, channels: bytes.readUInt16LE(p + 10), rate: bytes.readUInt32LE(p + 12), bits: bytes.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV: data before its format');
      if (!(fmt.pcm && fmt.bits === 24 && fmt.channels === 2 && fmt.rate === RATE)) {
        throw new Error(`WAV: wanted 24-bit stereo PCM at ${RATE} Hz, found ${fmt.pcm ? 'PCM' : 'not PCM'} ${fmt.bits}-bit, ${fmt.channels} channels, ${fmt.rate} Hz`);
      }
      const size = Math.min(n, bytes.length - (p + 8));
      return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, offset: p + 8, samples: Math.floor(size / SAMPLE_BYTES) };
    }
    p += 8 + n + (n & 1);
  }
  throw new Error('WAV: no data chunk');
}

// n samples of the WAV (its bytes) from sample s0 on, byte for byte, then zero bytes where the WAV
// has ended: the audio of the frames from k0 is pcmSlice(wav, audioSamples(k0), audioSamples(frames)).
export function pcmSlice(bytes, s0, n) {
  const { offset, samples } = wavInfo(bytes);
  const out = Buffer.alloc(n * SAMPLE_BYTES); // zeros
  const have = Math.max(0, Math.min(n, samples - s0));
  if (have > 0) bytes.copy(out, 0, offset + s0 * SAMPLE_BYTES, offset + (s0 + have) * SAMPLE_BYTES);
  return out;
}

// The frames --verify compares, for a file of frames from k0: ten (or all of a shorter one), the
// first, the last, the picture's last frame and the first black one when inside (2824, 2825: DUR lies
// between them), the rest each as far as can be from those already chosen (the earlier on a tie).
export function verifyFrames(k0, frames, count = 10) {
  const last = k0 + frames - 1;
  if (frames <= count) return Array.from({ length: frames }, (_, i) => k0 + i);
  const cut = frameCount(DUR); // the first black frame
  const chosen = [...new Set([k0, last, cut - 1, cut].filter((k) => k >= k0 && k <= last))];
  while (chosen.length < count) {
    let best = -1;
    let far = -1;
    for (let k = k0; k <= last; k++) {
      const d = Math.min(...chosen.map((c) => Math.abs(c - k)));
      if (d > far) [best, far] = [k, d];
    }
    chosen.push(best);
  }
  return chosen.sort((a, b) => a - b);
}

// Two RGB frames of one size (bytes, 3 a pixel; b against a) -> { psnr (dB, all channels), bias
// (mean of b - a per channel), mae (mean |b - a| per channel), max }. A range or matrix mistake shows
// as a bias of levels on every channel, which the PSNR of a busy frame can hide.
export function frameError(a, b) {
  if (a.length !== b.length || a.length % 3) throw new Error(`frames of another size: ${a.length} and ${b.length} bytes`);
  const sum = [0, 0, 0];
  const abs = [0, 0, 0];
  let sq = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const d = b[i + c] - a[i + c];
      sum[c] += d;
      abs[c] += d < 0 ? -d : d;
      sq += d * d;
      if (d > max) max = d;
      else if (-d > max) max = -d;
    }
  }
  const n = a.length / 3;
  const mse = sq / a.length;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), bias: sum.map((s) => s / n), mae: abs.map((s) => s / n), max };
}

// The tags ffmpeg writes on its own (brands, its version, the handler and vendor of a track, a
// language); any other tag, a title but on the container that is not Fractal, or a technical tag
// that holds a path, is one a person wrote: -> ['key=value', ...] of those.
const TECHNICAL = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'creation_time', 'handler_name', 'vendor_id', 'language']);
const PATHLIKE = /[\\/]|[A-Za-z]:[\\/]/;
export function strayTags(tags = {}, { title = false } = {}) {
  return Object.entries(tags)
    .filter(([k, v]) => {
      if (title && k === 'title') return v !== 'Fractal';
      return !TECHNICAL.has(k) || PATHLIKE.test(String(v));
    })
    .map(([k, v]) => `${k}=${v}`);
}

// The export's defaults (tools/export_video.mjs): the video's settings, as the owner decided them at
// gate 4a (2026-11-19): motion blur on (16 sub-frames over half a frame's time), sub-pixel jitter
// off, x264's grain tuning on, CRF 14 for both sizes; the whole video in chunks of 10 s, its render and
// files named Fractal. Two workers: the GPU sets the pace (4K, sub 16: 0.29 / 0.18 / 0.155 s a frame
// with 1 / 2 / 3 workers; a third takes 13 % off but 91 % of the 12 GB card's memory). So a bare
// `node tools/export_video.mjs` makes the video. The check tools' sub-frames (shot.mjs,
// check_collage.mjs: one sub-frame, jitter on, renderFrame's own) are not these: they are checks.
export const EXPORT_DEFAULTS = Object.freeze({ sub: 16, shutter: 0.5, jitter: false, tune: 'grain', crf4k: 14, crf1080: 14, chunk: 10, workers: 2, name: 'Fractal' });

// Why a --name or --as cannot be used, or null: it is a plain name (of the chunk folder, of the
// files), letters, digits, _ . - only, neither starting nor ending with a dot. "." or ".." would make
// the chunk folder the temp folder or the one above it, which a change of settings then clears; ".x"
// is a hidden one; Windows drops a final dot, so "x." would be the render "x".
export function nameProblem(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'a plain name: letters, digits, _ . - only (no path)';
  if (name.startsWith('.') || name.endsWith('.')) return 'a plain name, neither starting nor ending with a dot';
  return null;
}

// a setting's value as a message shows it
const shown = (v) => (v === undefined ? 'nothing' : typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.join(' ')}]` : String(v));
// the keys whose values differ between two settings (a key only one of them has differs)
const differing = (had, want) => [...new Set([...Object.keys(want), ...Object.keys(had)])].filter((k) => JSON.stringify(had[k]) !== JSON.stringify(want[k]));
// names as a message lists them: a, a and b, a, b and c
const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs.join(''));

// Why a re-encode (--as) of the render `name` cannot go on, or null when it can: the render's
// settings.json (`had`; null when there is none) must be what this run asks for (`want`: the same
// render settings), and every chunk the passage needs (`need`, tags) must be among the finished ones
// (`have`). A re-encode never draws and never removes a chunk; the message names what differs.
export function reencodeProblem(name, had, want, have, need) {
  if (!had) return `there is no render ${name} (no settings.json in its chunk folder): render it first without --as`;
  const differ = Object.keys(want).filter((k) => JSON.stringify(had[k]) !== JSON.stringify(want[k]));
  if (differ.length) {
    return `the render ${name} was made with other settings: ${differ.map((k) => `${k}: the render has ${shown(had[k])}, this run asks for ${shown(want[k])}`).join('; ')}`;
  }
  const missing = need.filter((t) => !have.includes(t));
  if (missing.length) {
    return `the render ${name} lacks chunks this passage needs: ${missing.join(', ')} (it has ${have.join(', ') || 'none'}; give the --from, --to and --chunk it was drawn with)`;
  }
  return null;
}

// What a run would replace that was made otherwise: [why, ...]; empty when it replaces nothing, or
// only what it makes the same way (it then resumes the render, or encodes again, as it always did).
// Without --replace a run stops on any of them, before it draws, writes or removes anything.
//   render   { name, had, want, chunks }: the chunk folder's settings.json (null: none, or not
//            readable), this run's render settings, the finished chunks there (tags). Chunks drawn
//            with other settings, or with settings not known, would be removed. null for a re-encode
//            (--as), which never removes a chunk (reencodeProblem).
//   outputs  { as, files, side, want }: the files' name, its videos that are there, the text of its
//            side file (null: none), and the side file this run writes. Files of another passage or
//            made otherwise (any key of the side file: the frames, the sub-frames, the encoder's
//            settings, the page's version, the WAV, the render), or whose side file is missing or
//            not readable, would be replaced.
export function replaceProblems({ render = null, outputs }) {
  const out = [];
  const keys = (d, had, want, whose) => d.map((k) => `${k}: ${whose} ${shown(had[k])}, this run ${shown(want[k])}`).join('; ');
  if (render && render.chunks.length) {
    const n = `${render.chunks.length} chunk${render.chunks.length > 1 ? 's' : ''}`;
    if (!render.had) {
      const many = render.chunks.length > 1;
      out.push(`the chunk folder of the render ${render.name} holds ${n} but no settings.json, so what ${many ? 'they were' : 'it was'} drawn with is not known: this run would remove ${many ? 'them' : 'it'} and draw again`);
    } else {
      const d = differing(render.had, render.want);
      if (d.length) out.push(`the render ${render.name}'s ${n} ${render.chunks.length > 1 ? 'were' : 'was'} drawn with other settings (${keys(d, render.had, render.want, 'the chunks have')}): this run would remove ${render.chunks.length > 1 ? 'them' : 'it'} and draw again`);
    }
  }
  const { as, files, side, want } = outputs;
  const sideName = `${as}.json`;
  if (side === null) {
    const many = files.length > 1;
    if (files.length) out.push(`${listed(files)} ${many ? 'are' : 'is'} there without the side file ${sideName}, so what ${many ? 'they hold' : 'it holds'} is not known: this run would replace ${many ? 'them' : 'it'}`);
    return out;
  }
  let had = null;
  try {
    had = JSON.parse(side);
  } catch {}
  const all = listed([...files, sideName]);
  const many = files.length > 0;
  if (!had || typeof had !== 'object' || Array.isArray(had)) {
    out.push(`the side file ${sideName} cannot be read, so what ${all} hold${many ? '' : 's'} is not known: this run would replace ${many ? 'them' : 'it'}`);
  } else {
    const d = differing(had, want);
    if (d.length) out.push(`${all} hold${many ? '' : 's'} another passage or other settings (${keys(d, had, want, 'the files have')}): this run would replace ${many ? 'them' : 'it'}`);
  }
  return out;
}

// New files into the places of old ones, all together or not at all, as far as a file system allows:
// moves [{ from, to }] (from: a finished new file under a temporary name; to: its final name, where an
// old file may be). The old files are first moved aside (to + '.old'), then the new ones moved in,
// then the old ones removed. When a move fails (on Windows a player that holds a file open refuses
// it), everything moved is moved back, the old files to their names and the new ones to their
// temporary names, and it throws saying so; should a move back fail too, the message says what each
// final name holds now and where the other file is. ops: { exists(p), rename(from, to), remove(p) }
// (node:fs's, or a test's); show(p): a path as a message shows it. -> { replaced: the final names that
// held an old file, left: old files that could not be removed at the end }
export function renameTogether(moves, { exists, rename, remove }, show = (p) => p) {
  const aside = (p) => `${p}.old`;
  // old: 'there' (at to), 'aside' or null (there was none); neu: 'from', 'to' or 'lost' (the old one
  // was put back over it)
  const at = moves.map((m) => ({ ...m, old: exists(m.to) ? 'there' : null, neu: 'from' }));
  let doing = '';
  try {
    for (const m of at) {
      if (!m.old) continue;
      doing = `moving ${show(m.to)} aside`;
      rename(m.to, aside(m.to));
      m.old = 'aside';
    }
    for (const m of at) {
      doing = `moving ${show(m.from)} to ${show(m.to)}`;
      rename(m.from, m.to);
      m.neu = 'to';
    }
  } catch (e) {
    for (const m of [...at].reverse()) {
      if (m.neu === 'to') {
        try {
          rename(m.to, m.from);
          m.neu = 'from';
        } catch {}
      }
      if (m.old === 'aside') {
        try {
          rename(aside(m.to), m.to);
          m.old = 'there';
          if (m.neu === 'to') m.neu = 'lost';
        } catch {}
      }
    }
    const held = ['EBUSY', 'EPERM', 'EACCES'].includes(e && e.code) ? ': is a player or another program holding it open?' : '';
    const why = `${doing} failed (${(e && e.code) || String((e && e.message) || e).split('\n')[0]}${held})`;
    if (at.every((m) => m.old !== 'aside' && m.neu === 'from')) {
      const olds = at.filter((m) => m.old).map((m) => show(m.to));
      throw new Error(`${why}; the old files are as they were${olds.length ? ` (${olds.join(', ')})` : ''}; the new ones are under their temporary names: ${at.map((m) => show(m.from)).join(', ')}`);
    }
    const holds = (m) => `${show(m.to)} holds ${m.old === 'there' ? 'the old file' : m.neu === 'to' ? 'the new file' : 'nothing'}`;
    const notes = (m) => [m.old === 'aside' && `the old one is ${show(aside(m.to))}`, m.neu === 'from' && `the new one is ${show(m.from)}`, m.neu === 'lost' && 'the new one is lost: the old one was put back over it'].filter(Boolean);
    throw new Error(`${why}; putting them back failed: ${at.map((m) => holds(m) + (notes(m).length ? ` (${notes(m).join('; ')})` : '')).join('; ')}`);
  }
  const left = [];
  for (const m of at) {
    if (m.old !== 'aside') continue;
    try {
      remove(aside(m.to));
    } catch {
      left.push(aside(m.to));
    }
  }
  return { replaced: at.filter((m) => m.old).map((m) => m.to), left };
}

// The files the export makes in a chunk folder (finished and half-written chunks, settings.json, the
// encode's list and audio): the only ones it removes there
export const RENDER_FILE = /^(\d{5}-\d{5}(\.part)?\.mp4|settings\.json|list\.txt|audio\.s24le)$/;

// text with the paths of this machine taken out, for the log: the project folder (as a path, with
// either slash and any case, or a file:/// URL) becomes nothing before a path inside it, so that path
// reads from the project folder, and "." by itself; the home folder becomes ~; the user's name as a
// word of its own (not inside another word: a short name is part of many) becomes <user>. A folder
// is only the folder when its name ends there (C:\Users\ed is not the start of C:\Users\eddie).
export function scrubPaths(text, { root, home, user }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anySlash = (p) => esc(p.replace(/\\/g, '/')).replace(/\//g, '[\\\\/]');
  const ENDS = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])'; // the name goes no further (a full stop may follow)
  let t = String(text);
  t = t.replace(new RegExp(`(file:\\/\\/\\/)?${anySlash(root)}[\\\\/]`, 'giu'), '');
  t = t.replace(new RegExp(`(file:\\/\\/\\/)?${anySlash(root)}${ENDS}`, 'giu'), '.');
  if (home) t = t.replace(new RegExp(`${anySlash(home)}${ENDS}`, 'giu'), '~');
  if (user) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(user)}(?![\\p{L}\\p{N}])`, 'giu'), '<user>');
  return t;
}

// The parts of a QuickTime (MOV, MP4) file that are not its media data: [[start, end], ...] (byte
// offsets, end not included), all of the file but the payload of each top-level mdat atom (the
// compressed frames and the audio samples, in which any short text turns up by chance among hundreds
// of megabytes; the metadata a person or a tool could write a path or a name into is elsewhere).
// read(pos, n) -> Buffer gives the file's bytes (fewer at its end); size is its length. An mdat cut
// short (a file being written) runs to the end of the file; where the atoms stop making sense the walk
// ends and the rest of the file is looked at.
export function metadataRanges(read, size) {
  const ranges = [];
  let start = 0; // where the part being looked at began
  for (let pos = 0; pos < size; ) {
    const h = read(pos, 16);
    if (h.length < 8) break;
    let len = h.readUInt32BE(0);
    let head = 8;
    if (len === 1) {
      if (h.length < 16) break;
      len = Number(h.readBigUInt64BE(8));
      head = 16;
    } else if (len === 0) {
      len = size - pos; // to the end of the file
    }
    const type = h.toString('latin1', 4, 8);
    if (type === 'mdat' && len >= head) len = Math.min(len, size - pos);
    if (len < head || pos + len > size) break; // not an atom: from here on all is looked at
    if (type === 'mdat') {
      ranges.push([start, pos + head]); // its header is looked at, its payload is not
      start = pos + len;
    }
    pos += len;
  }
  if (start < size) ranges.push([start, size]);
  return ranges;
}

// The kinds of private text in a file's bytes outside its media data (metadataRanges): kinds [[kind,
// text], ...], each looked for in UTF-8 and UTF-16 (an empty text is not looked for); read and size as
// for metadataRanges, block the bytes read at a time -> [kind, ...] in the order of kinds (never the
// text: it is private).
export function privateKinds(read, size, kinds, block = 1 << 24) {
  const needles = kinds.filter(([, s]) => s).flatMap(([kind, s]) => [[kind, Buffer.from(s, 'utf8')], [kind, Buffer.from(s, 'utf16le')]]);
  if (!needles.length) return [];
  const longest = Math.max(...needles.map(([, b]) => b.length));
  const found = new Set();
  for (const [a, b] of metadataRanges(read, size)) {
    let carry = Buffer.alloc(0); // the end of the bytes before, so a text cut by a block is found
    for (let pos = a; pos < b; ) {
      const got = read(pos, Math.min(block, b - pos));
      if (!got.length) break;
      pos += got.length;
      const buf = Buffer.concat([carry, got]);
      for (const [kind, n] of needles) if (buf.indexOf(n) >= 0) found.add(kind);
      carry = buf.subarray(Math.max(0, buf.length - longest + 1));
    }
  }
  return [...new Set(kinds.map(([k]) => k))].filter((k) => found.has(k));
}

// The oldest ffmpeg these tools work with: 5.1, the first release with -fps_mode (video_io.mjs
// decodeFrames) and -ch_layout (muxArgs). Its libavcodec is 59.37, which tells the age of a build
// from git, whose version names no release.
export const FFMPEG_MIN = Object.freeze({ release: [5, 1], libavcodec: [59, 37] });

// `ffmpeg -version`'s text -> why these tools cannot use that ffmpeg (too old, or its version cannot
// be told), or null
export function ffmpegProblem(text) {
  const t = String(text);
  const older = ([a, b], [c, d]) => a < c || (a === c && b < d);
  const need = `these tools need ${FFMPEG_MIN.release.join('.')} or later`;
  const name = (t.match(/^ffmpeg version (\S+)/m) || [])[1];
  const rel = t.match(/^ffmpeg version n?(\d+)\.(\d+)/m);
  if (rel) return older([Number(rel[1]), Number(rel[2])], FFMPEG_MIN.release) ? `ffmpeg ${name} is too old: ${need}, for -fps_mode and -ch_layout` : null;
  const lib = t.match(/^libavcodec\s+(\d+)\.\s*(\d+)\./m);
  if (lib) {
    const v = [Number(lib[1]), Number(lib[2])];
    return older(v, FFMPEG_MIN.libavcodec) ? `ffmpeg ${name} with libavcodec ${v.join('.')} is too old: ${need} (libavcodec ${FFMPEG_MIN.libavcodec.join('.')}), for -fps_mode and -ch_layout` : null;
  }
  return `cannot tell ffmpeg's version from "${t.split('\n')[0].trim()}": ${need}`;
}

// The side file of <name>_4K.mov or <name>_1080p.mov: <name>.json beside it (null for another name).
export function sideFile(video) {
  const m = path.basename(video).match(/^(.*)_(4K|1080p)\.mov$/);
  return m ? path.join(path.dirname(video), `${m[1]}.json`) : null;
}

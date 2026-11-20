// Reading an exported video with ffmpeg and ffprobe (PATH's): the one place that decodes the files
// (tools/export_video.mjs --verify, the sync check, the gate's stills).
//   probe(file)                                  the streams: frames, length, start, colour, tags
//   decodeFrames(file, first, count, { clip, size })  frames as RGB, as an ordinary player shows them
//   decodeAudio(file)                            the audio as pcm_s24le bytes
//   resizeRGB(rgb, [w, h], [W, H])               an RGB frame reduced with the export's Lanczos
//   privateText(file, kinds)                     private text in the file's metadata (not its media)
//   ffmpegCheck()                                ffmpeg and ffprobe there, and ffmpeg new enough
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { FPS, privateKinds, ffmpegProblem } from './export_lib.mjs';

const BIG = 1 << 30; // enough for the output of any of these calls

// ffmpeg (or ffprobe) with args, its standard output collected -> Buffer; throws with its error text
function run(tool, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(tool, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`${tool}: ${e.message} (is it on PATH?)`)));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${tool} exit ${code}: ${err.trim().slice(0, 800)}`))));
    p.stdin.on('error', () => {}); // a tool that ends early closes its input; its exit code tells
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

const num = (v) => (v === undefined || v === 'N/A' ? null : Number(v));
const rate = (r) => {
  const [a, b] = String(r || '0/1').split('/').map(Number);
  return b ? a / b : null;
};

// The file's container and its first video and audio stream -> { format: { duration, start, tags },
// video: { codec, profile, width, height, pixFmt, fps, frames, headerFrames, duration, start, range,
// matrix, primaries, transfer, tags }, audio: { codec, rate, channels, layout, samples, duration,
// start, tags } } (null for a missing stream). Lengths and starts in seconds. frames: the video's
// packets counted by reading the whole file; with { count: false } the container's own count
// (headerFrames), which is quick.
export async function probe(file, { count = true } = {}) {
  const json = JSON.parse(
    (
      await run('ffprobe', [
        '-v', 'error', ...(count ? ['-count_packets'] : []), '-of', 'json',
        '-show_entries',
        'format=duration,start_time:format_tags:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,start_time,duration,duration_ts,time_base,nb_frames,nb_read_packets,sample_rate,channels,channel_layout:stream_tags',
        file,
      ])
    ).toString('utf8'),
  );
  const v = json.streams.find((s) => s.codec_type === 'video');
  const a = json.streams.find((s) => s.codec_type === 'audio');
  return {
    format: { duration: num(json.format.duration), start: num(json.format.start_time), tags: json.format.tags || {} },
    video: v && {
      codec: v.codec_name,
      profile: v.profile,
      width: v.width,
      height: v.height,
      pixFmt: v.pix_fmt,
      fps: rate(v.r_frame_rate),
      frames: count ? num(v.nb_read_packets) : num(v.nb_frames),
      headerFrames: num(v.nb_frames),
      duration: num(v.duration),
      start: num(v.start_time),
      range: v.color_range,
      matrix: v.color_space,
      primaries: v.color_primaries,
      transfer: v.color_transfer,
      tags: v.tags || {},
    },
    audio: a && {
      codec: a.codec_name,
      rate: num(a.sample_rate),
      channels: a.channels,
      layout: a.channel_layout,
      // a PCM track's length in samples: its duration in its own time base (1 / rate)
      samples: a.time_base === `1/${a.sample_rate}` ? num(a.duration_ts) : null,
      duration: num(a.duration),
      start: num(a.start_time),
      tags: a.tags || {},
    },
  };
}

// Y'CbCr to RGB as a player does it for these files: limited-range BT.709 (what the export writes and
// tags; probe tells the tags), chroma interpolated to every pixel, full-range 8-bit RGB out
const TO_RGB = 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24';

// count frames of the file from its frame first (0 is the file's first frame), as RGB (3 bytes a
// pixel, rows top first; an export's chunks give back exactly the canvas's RGB) -> [Buffer, ...].
// clip: [x, y, w, h], a part of the frame in 0..1 of its
// width and height (edges rounded to whole pixels); size: [w, h], the frame (or its clip) reduced
// to that many pixels with Lanczos. A frame is found by its time: the seek decodes from the key
// frame before it and drops the frames before (first - 0.5) / 60.
export async function decodeFrames(file, first, count, { clip = null, size = null } = {}) {
  const { video } = await probe(file, { count: false });
  if (!video) throw new Error(`${file}: no video stream`);
  if (!(Number.isInteger(first) && first >= 0 && Number.isInteger(count) && count >= 1)) throw new Error(`decodeFrames: frames ${first} +${count}?`);
  if (first + count > video.frames) throw new Error(`decodeFrames: frames ${first}..${first + count - 1}, the file has ${video.frames}`);
  let w = video.width;
  let h = video.height;
  // an RGB stream (a lossless chunk: gbrp) is only reordered to RGB, exactly; Y'CbCr is converted
  const filters = [/^(gbr|rgb|bgr|0rgb|0bgr|argb|abgr)/.test(video.pixFmt) ? 'format=rgb24' : TO_RGB];
  if (clip) {
    const [x0, y0] = [Math.round(clip[0] * w), Math.round(clip[1] * h)];
    const [x1, y1] = [Math.round((clip[0] + clip[2]) * w), Math.round((clip[1] + clip[3]) * h)];
    if (!(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h && x1 > x0 && y1 > y0)) throw new Error(`decodeFrames: clip ${clip} is not inside the frame`);
    filters.push(`crop=${x1 - x0}:${y1 - y0}:${x0}:${y0}`);
    [w, h] = [x1 - x0, y1 - y0];
  }
  if (size) {
    filters.push(`scale=${size[0]}:${size[1]}:flags=lanczos+accurate_rnd,format=rgb24`);
    [w, h] = size;
  }
  // passthrough: every decoded frame once, as it is (a constant-rate output would repeat the first
  // frame to fill the half frame between the seek and it, shifting the rest by one)
  const seek = first > 0 ? ['-ss', String((first - 0.5) / FPS)] : [];
  const out = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...seek, '-i', file, '-map', '0:v:0', '-vf', filters.join(','), '-fps_mode', 'passthrough', '-frames:v', String(count), '-f', 'rawvideo', 'pipe:1']);
  const one = w * h * 3;
  if (out.length !== one * count) throw new Error(`decodeFrames: ${out.length / one} frames of ${w}x${h} decoded, wanted ${count}`);
  return Array.from({ length: count }, (_, i) => out.subarray(i * one, (i + 1) * one));
}

// The file's first audio stream as signed 24-bit little-endian PCM bytes (stereo: 6 bytes a sample).
// A pcm_s24le track is copied out as it is stored; anything else is decoded to it.
export async function decodeAudio(file) {
  const { audio } = await probe(file, { count: false });
  if (!audio) throw new Error(`${file}: no audio stream`);
  const codec = audio.codec === 'pcm_s24le' ? 'copy' : 'pcm_s24le';
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-c:a', codec, '-f', 's24le', 'pipe:1']);
}

// An RGB frame (3 bytes a pixel) of [w, h] reduced to [W, H] with the export's Lanczos (the 1080p
// file's frames are the 4K frames reduced so; tools/export_lib.mjs encodeArgs) -> Buffer
export async function resizeRGB(rgb, [w, h], [W, H]) {
  const out = await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${w}x${h}`, '-i', 'pipe:0', '-vf', `scale=${W}:${H}:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,format=rgb24`, '-f', 'rawvideo', 'pipe:1'],
    rgb,
  );
  if (out.length !== W * H * 3) throw new Error(`resizeRGB: ${out.length} bytes, wanted ${W * H * 3}`);
  return out;
}

// The kinds of private text in a file's bytes outside its media data (export_lib.mjs privateKinds:
// kinds [[kind, text], ...]), read a block at a time -> [kind, ...]
export function privateText(file, kinds) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (pos, n) => {
      const b = Buffer.allocUnsafe(n);
      return b.subarray(0, fs.readSync(fd, b, 0, n, pos));
    };
    return privateKinds(read, fs.fstatSync(fd).size, kinds);
  } finally {
    fs.closeSync(fd);
  }
}

// ffmpeg and ffprobe on PATH, and an ffmpeg new enough for these tools (export_lib.mjs FFMPEG_MIN)?
// -> { version: ffmpeg's first line (null when it is not there), problem: why the tools cannot run
// with them, or null }. The tools ask this first, before they draw or read anything.
export function ffmpegCheck() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, maxBuffer: BIG });
  const p = spawnSync('ffprobe', ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, maxBuffer: BIG });
  if (r.status !== 0 || p.status !== 0) return { version: null, problem: 'ffmpeg and ffprobe must be on PATH' };
  return { version: r.stdout.split('\n')[0].trim(), problem: ffmpegProblem(r.stdout) };
}

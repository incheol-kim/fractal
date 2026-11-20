// Sub-frames (design 10.3): for the video, a frame can be the average of n sub-frames (renderer.js
// renderAveraged; main.js renderFrame's { sub, shutter, jitter }). Each sub-frame is drawn at its own time
// within a shutter window, which smooths what moves, and shifted by its own sub-pixel jitter, which
// smooths the edges (the jitter can be switched off: jittersFor). Pure: times, offsets and the
// sub-frame targets' memory (no DOM, no drawing).
//
// The shutter window opens FORWARD from the frame time, [t, t + shutter / fps) (Echolocation centred
// it on t). The video's frames are at t = k / 60, so with shutter <= 1 no window reaches the next
// 1/60 s step, and the 12 fps steps of the grain, the paper tooth and the tremor (multiples of 5/60)
// are never crossed: a frame never shows two of them at once. A cut (cutTimes) can only lie between
// two frame times; the sub-frames of the frame before it are held short of it, so a frame never
// mixes two shots, or the picture and the end card's black.
import { DUR } from './music.js';

// the video's frame rate: shutter is a part of one frame at this rate
export const FPS = 60;

// a sub-frame that would reach a cut is drawn this long before it instead (seconds)
const BEFORE_CUT = 1e-6;

// The n sub-frame times of the frame at t: t + (k + 0.5) / n * shutter / fps, k = 0 ... n - 1 (all t
// for shutter 0). A time at or past a cut c after t is held at c - BEFORE_CUT (never before t).
export function subFrameTimes(t, n, fps, shutter, cuts = []) {
  return Array.from({ length: n }, (_, k) => {
    let s = t + (((k + 0.5) / n) * shutter) / fps;
    for (const c of cuts) if (t < c && s >= c) s = Math.max(t, c - BEFORE_CUT);
    return s;
  });
}

// The radical inverse of i in base b (the Halton sequence's i-th value), in [0, 1).
function halton(i, b) {
  let f = 1;
  let r = 0;
  for (; i > 0; i = Math.floor(i / b)) {
    f /= b;
    r += f * (i % b);
  }
  return r;
}

// n sub-pixel offsets [dx, dy] in canvas pixels, in [-0.5, 0.5): Halton (2, 3) from index 1, minus
// 0.5, which covers the pixel evenly for any n; [[0, 0]] for one sub-frame.
export function subPixelJitter(n) {
  if (n <= 1) return [[0, 0]];
  return Array.from({ length: n }, (_, k) => [halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5]);
}

// The offsets of n sub-frames: subPixelJitter(n) with the jitter on; with it off each [0, 0], so the
// sub-frames differ in their time only (the jitter is a one-pixel box filter on everything placed on
// the picture: it evens the steps of edges and takes some of the finest detail; renderFrame's jitter).
export function jittersFor(n, jitter) {
  return jitter ? subPixelJitter(n) : Array.from({ length: n }, () => [0, 0]);
}

// The GPU memory of renderer.js's sub-frame targets at [w, h] (null: not made), bytes a canvas pixel:
// the 4x MSAA colour (RGBA8) and depth (24 bits held in 32) 16 + 16, their resolved colour and the
// resolving framebuffer's depth 4 + 4, the RGBA32F sum 16.
export function averagingBytes(size) {
  return size ? size[0] * size[1] * 56 : 0;
}

// The times at which the picture cuts, ascending: each camera entry of the score after the first
// (timeline.js cameraAt jumps there between two frames: a new zoom, or a punch-in, which jumps in and
// only then eases back) and DUR, where the picture cuts to the end card's black.
export function cutTimes(score) {
  const camera = score.camera.filter((e) => e.t > 0).map((e) => e.t);
  return [...new Set([...camera, DUR])].sort((a, b) => a - b);
}

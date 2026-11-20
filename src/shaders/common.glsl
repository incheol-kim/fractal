// Shared by every layer's shaders (prepended by renderer.js): uniforms, the camera, hashes, noise.
// Coordinates: picture 0..1 (x and y separately, y down); picture px = 2944 x 1648 scale.
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec4 uCam;    // xy: picture point at the stage centre; zw: picture 0..1 -> clip scale (x, y)
uniform vec2 uShift;  // gate weave, in clip units
uniform vec4 uStage;  // xy: canvas px; z: canvas px per picture px (now, with the zoom); w: canvas px per 1/1080 stage height
uniform vec4 uPic;    // xy: picture px (2944, 1648); z: aspect; w: picture height in stage heights at zoom 1
uniform float uTick;  // floor(t * 12): the seed of everything that moves at 12 fps (0 with ?fx=0)
uniform float uFx;    // 1: paper texture, film grain, gate weave and stroke tremor on (?fx=0 turns them off)
uniform float uFilm;  // strength of the paper tooth, film grain and gate weave: 1, weaker after the glue
// the signs of life after the last note (timeline.js lifeAt; all 0 before it and with ?fx=0)
uniform vec4 uLife;   // x: the clouds' drift to the right, y: the leaves' tremble (both picture px), z: the rooms' breath (factor - 1), w: strength
uniform vec2 uSway;   // x: how far the wires sway (picture px), y: its phase (radians)

vec2 picToClip(vec2 p) {
  return vec2((p.x - uCam.x) * uCam.z, (uCam.y - p.y) * uCam.w) + uShift;
}

vec2 clipToPic(vec2 c) {
  c -= uShift;
  return vec2(uCam.x + c.x / uCam.z, uCam.y - c.y / uCam.w);
}

// Integer hashes (PCG); no state, so the same input is always the same number.
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

uint hash3u(uint a, uint b, uint c) {
  return pcg(a ^ pcg(b ^ pcg(c)));
}

float u2f(uint h) {
  return float(h >> 8u) * (1.0 / 16777216.0); // [0, 1)
}

// The halftone screen at c, in halftone cells: a 45-degree cos grid, 0.5 + 0.25 (cos 2πx + cos 2πy).
// Ink is printed where it exceeds the threshold (halftone.js toneThreshold).
float halftoneScreen(vec2 c) {
  vec2 q = vec2(c.x + c.y, c.y - c.x) * 0.70710678;
  return 0.5 + 0.25 * (cos(6.2831853 * q.x) + cos(6.2831853 * q.y));
}

vec2 gradAt(ivec2 c, uint seed) {
  float a = u2f(hash3u(uint(c.x), uint(c.y), seed)) * 6.2831853;
  return vec2(cos(a), sin(a));
}

// Gradient noise, one cell per unit, about -0.7..0.7, mean 0.
float gnoise(vec2 p, uint seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradAt(i, seed), f);
  float b = dot(gradAt(i + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float c = dot(gradAt(i + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float d = dot(gradAt(i + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Band-limited fractal noise. lod = noise cells per canvas pixel at octave 0. An octave finer
// than the pixel grid fades to its mean (0), so the texture never aliases at any zoom.
float fbm(vec2 p, int oct, float lod, uint seed) {
  float s = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float fade = 1.0 - smoothstep(0.2, 0.45, f * lod);
    if (fade > 0.0) s += a * fade * gnoise(p * f + float(i) * 17.31, seed + uint(i) * 1013u);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

// The paper's tooth at a picture point (px): fine relief about a pixel of the picture across,
// mean 0, about -1..1. lodPx = picture px per canvas px. Pencil graphite catches on its peaks.
float paperTooth(vec2 px, float lodPx) {
  return 1.5 * fbm(px / 1.1, 2, lodPx / 1.1, 7u);
}

// Paper fibres: short streaks in two directions, a few picture px long, mean 0.
float paperFibres(vec2 px, float lodPx) {
  vec2 a = mat2(0.94, 0.34, -0.34, 0.94) * px;
  vec2 b = mat2(0.5, -0.87, 0.87, 0.5) * px;
  return fbm(a / vec2(9.0, 1.6), 2, lodPx / 1.6, 13u) + 0.7 * fbm(b / vec2(7.0, 1.4), 2, lodPx / 1.4, 17u);
}

// A photo piece: the plate (crossfading to the key by uP2K) at the leaf's rest position, so the
// photo moves with the piece. For the moment `ink` says, the leaf's ink colour is printed instead
// (halftone, as the flats). develop and bleed (no shadow, no border) are revealed through a noise
// threshold that rises with a: an ink-coloured front runs ahead and the photo follows it; nothing
// shows where the front has not arrived. Over a collage fragment (vDissolve) there is no ink: the
// photo's alpha rises from 0 to 1 across the front, so the wrong picture under it is washed away
// where the front passes and shows as it is where it has not come. Shadow and border parts of the
// pasted cut-outs are flat colours; the masking tape is a translucent flat colour with its two
// short ends torn. Straight alpha over what is below; alpha 1 replaces the pixel exactly.
// After the last note the photo lives (the signs of life, uLife in common.glsl): where the life map
// lets it, the clouds drift, the leaves tremble and the rooms' light breathes (main()).
in vec2 vUV;
in vec2 vGrid;
flat in vec4 vInk;
flat in vec4 vPart;
flat in vec4 vLeaf;
flat in float vDissolve;
in vec2 vTape;
flat in vec2 vTapeOn;
uniform sampler2D uKey;   // the key image
uniform sampler2D uPlate; // the key with the wires painted out
uniform sampler2D uLifeMap; // where the photo lives (assets/life.png): r flow, g tremble, b breath, 0 at the edge of each area
uniform float uP2K;       // plate -> key (state.plateToKey)
uniform float uCell;      // halftone cell, in 1/1080 of the stage height
uniform vec3 uPaper;
uniform vec4 uShadow;     // rgb, alpha of a full shadow
uniform vec2 uTape;       // the tape's length and width, 1/2160 of the stage height (layers/pieces.js TAPE)
uniform vec4 uTapeRGBA;   // its colour and opacity (TAPE_RGBA)
out vec4 fragColor;

const float BAND = 0.3; // develop and bleed: how far (in noise) the ink front runs ahead of the photo (over a collage fragment: the photo's alpha rises across it)

// The tape's torn ends, 1/2160 of the stage height (starting values: hand-torn paper tape): each end
// slants by up to TEAR_SLANT either way at the strip's sides and wanders up to about TEAR_JAG along
// it, in a broad wave about TEAR_TOOTH long with finer teeth on it. It lies TEAR_IN in from the
// quad's end, so that the quad's straight end never clips it or its antialiased edge: the edge
// reaches at most TEAR_SLANT + 1.12 TEAR_JAG = 6.5 out from there, and its ramp (tapeCover) half a
// canvas px further, one unit at 1080p (half at 4K): 7.5 in all.
const float TEAR_SLANT = 4.0;
const float TEAR_JAG = 2.2;
const float TEAR_TOOTH = 4.0;
const float TEAR_IN = 7.5;

// How much of the tape covers its point, 0..1: inside its two torn ends (the long sides are the
// quad's own). p: the point in the strip's frame (x along, y across); seed: one per tape; pxPerUnit:
// canvas px per 1/2160 of the stage height, for the antialiased edge (a ramp one canvas px wide,
// centred on the cut).
float tapeCover(vec2 p, uint seed, float pxPerUnit) {
  uint end = seed * 2u + (p.x < 0.0 ? 1u : 0u); // each end is torn its own way
  float slant = u2f(hash3u(end, 0x7a3d1fu, 1u)) * 2.0 - 1.0;
  float across = p.y / (0.5 * uTape.y); // -1..1
  // gradient noise is about -0.7..0.7: the two together about -1.1..1.1
  float jag = gnoise(vec2(p.y / TEAR_TOOTH, 0.5), end) + 0.6 * gnoise(vec2(p.y / (0.4 * TEAR_TOOTH), 2.5), end + 977u);
  float cut = 0.5 * uTape.x - TEAR_IN + TEAR_SLANT * slant * across + TEAR_JAG * jag;
  return clamp((cut - abs(p.x)) * pxPerUnit + 0.5, 0.0, 1.0);
}

// The leaves' tremble (the signs of life; starting values): at a picture point (px) a vector of
// length at most 1, smooth over the picture (gradient noise in cells TREMBLE_CELL picture px across,
// so a clump of leaves moves together; TREMBLE_GAIN brings most of it near 1 and the longest are cut
// to 1) and a new one at every 12 fps tick. Made from picture px and the tick only (no canvas px, no
// uStage), so the picture trembles alike at every canvas size.
const float TREMBLE_CELL = 16.0;
const float TREMBLE_GAIN = 2.0;
vec2 tremble(vec2 px) {
  uint seed = uint(uTick) * 2u + 0x6d1au;
  vec2 v = TREMBLE_GAIN * vec2(gnoise(px / TREMBLE_CELL, seed), gnoise(px / TREMBLE_CELL + 7.3, seed + 1u));
  return v / max(1.0, length(v));
}

// The reveal noise at a picture point (px), 0..1: the distance from the leaf's centre (0 there, so
// the reveal starts on the note) scaled by warped band-limited noise in broad patches, so the
// front is ragged: for bleed a little (the tree spreads outwards), for develop a lot (the interior
// comes up in patches).
float revealNoise(vec2 px, float mode) {
  float lod = 1.0 / uStage.z; // picture px per canvas px
  vec2 w = vec2(fbm(px / 120.0, 2, lod / 120.0, 71u), fbm(px / 120.0 + 5.3, 2, lod / 120.0, 72u));
  float nz = clamp(0.5 + 1.25 * fbm((px + 60.0 * w) / 55.0, 4, lod / 55.0, 73u), 0.0, 1.0);
  float r = clamp(length(px - vLeaf.xy) / max(vLeaf.z, 1.0), 0.0, 1.0);
  float ragged = mode > 1.5 ? 0.5 : 0.8;
  return clamp(r * (1.0 - ragged + 2.0 * ragged * nz), 0.0, 0.999);
}

void main() {
  // everything with derivatives first, outside any branch (mode is the same on a whole triangle)
  // The signs of life: m, the life map here. The photo is read from where the cloud was (it has
  // drifted uLife.x m.r picture px to the right) and where the leaf was (it trembles by up to
  // uLife.y m.g); both stay below the map's feather, so the picture never folds or tears. With uLife
  // 0 the read is at vUV exactly and the breath's factor (below) is 1: the very pixels of before.
  vec4 m = texture(uLifeMap, vUV);
  vec2 move = vec2(uLife.x * m.r, 0.0) + uLife.y * m.g * tremble(vUV * uPic.xy);
  vec2 uv = vUV - move / uPic.xy;
  vec3 key = texture(uKey, uv).rgb;
  vec3 plate = texture(uPlate, uv).rgb;
  float mode = vPart.y;
  float n = mode > 0.5 ? revealNoise(vUV * uPic.xy, mode) : 0.0;
  float fw = fwidth(n);
  // halftone screen of flat.frag.glsl, riding with the piece
  vec2 c = vGrid / (uStage.w * uCell);
  float f = halftoneScreen(c);
  float aa = max(fwidth(f), 1e-4) * 0.7;

  int part = int(vPart.x + 0.5);
  float a = vPart.z;
  // develop / bleed: shown where the noise is below the front (antialiased), ink at the front
  float vis = 1.0;
  float q = 1.0;
  if (mode > 0.5 && a < 1.0) {
    float front = a * (1.0 + BAND);
    vis = clamp((front - n) / max(fw, 1e-4) + 0.5, 0.0, 1.0);
    q = clamp((front - n) / BAND, 0.0, 1.0);
  }

  if (part <= 1) { // shadow (pasted cut-outs only)
    float al = uShadow.a * vLeaf.w;
    if (al <= 0.0) discard;
    fragColor = vec4(uShadow.rgb, al);
    return;
  }
  if (part == 2) { // white border
    fragColor = vec4(1.0);
    return;
  }
  if (part == 4) { // masking tape: its colour, translucent, showing as far as the state says
    float pxPerUnit = uStage.z * uPic.y / (2160.0 * uPic.w);
    float al = uTapeRGBA.a * vTapeOn.x * tapeCover(vTape, uint(vTapeOn.y + 0.5), pxPerUnit);
    if (al <= 0.0) discard;
    fragColor = vec4(uTapeRGBA.rgb, al);
    return;
  }
  // over a collage fragment: no ink, the photo comes up across the front (smoothly from 0 to 1)
  bool dissolve = vDissolve > 0.5;
  if (dissolve) vis = q * q * (3.0 - 2.0 * q);
  if (vis <= 0.0) discard;
  vec3 col = uP2K >= 1.0 ? key : uP2K <= 0.0 ? plate : mix(plate, key, uP2K);
  col *= 1.0 + uLife.z * m.b; // the rooms' light breathes
  float inkAmt = dissolve ? 0.0 : mode > 0.5 ? 1.0 - q : vPart.w;
  if (inkAmt > 0.0) {
    // the leaf's ink printed on paper, halftoned by its tone, a little uneven with paper texture on
    float cov = vInk.a >= 0.0 ? smoothstep(vInk.a - aa, vInk.a + aa, f) : 1.0;
    float dens = 1.0;
    if (uFx > 0.5) {
      vec2 px = vUV * uPic.xy;
      float lodPx = 1.0 / uStage.z;
      dens = 0.975 + 0.035 * fbm(px / 34.0, 3, lodPx / 34.0, 21u) + 0.02 * fbm(px / 3.0, 2, lodPx / 3.0, 22u);
    }
    col = mix(col, mix(uPaper, vInk.rgb, clamp(cov * dens, 0.0, 1.0)), inkAmt);
  }
  fragColor = vec4(col, vis);
}

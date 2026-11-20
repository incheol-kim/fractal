// Photo pieces: every leaf of every cut-out in one mesh, in draw order (each cut-out as shadow,
// white border, photo); the fold-style cut-outs again in the front mesh, which draws a cut-out
// while it folds (uFront, layers/pieces.js; never its tape); the cut-outs' masking tapes in the tape
// mesh, drawn last (after the wires) over everything, without depth. The cut-out's transform, fold,
// smear and tape come from uCut (CUT_TEXELS texels per cut-out, cutouts.js cutoutTexels), the
// leaf's a and ink from uRow (one texel per score row).
in vec2 position; // rest position, picture 0..1 (also the texture coordinate); the tape's middle (all four corners)
in vec2 aOut;     // outline ribbons: mitre for a half width of 1 times the side, picture px; the tape: its corner from its middle, 1/2160 of the stage height at zoom 1, picture directions; 0 on fills
in vec4 aId;      // x: cut-out (draw order), y: score row, z: part (0 shadow fill, 1 shadow ribbon, 2 border, 3 photo, 4 tape), w: reveal (0 none, 1 develop, 2 bleed)
in vec3 aPivot;   // xy: the cut-out's pivot, picture 0..1; z: its radius, the farthest point of its outlines from the pivot, picture px
in vec4 aHinge;   // the cut-out's hinge x0, y0, x1, y1, picture 0..1 (cutouts.js groupCutouts); 0 without one
in vec4 aInk;     // leaf ink rgb; a: halftone threshold (< 0: solid)
in vec4 aLeaf;    // leaf centre (picture 0..1) and radius (picture px), for the reveal noise; w: 1 for develop / bleed over a collage fragment (it dissolves: no ink front)
in vec2 aTape;    // the tape: this corner in the strip's own frame (x along it, y across), 1/2160 of the stage height; 0 on every other part

uniform sampler2D uCut;
uniform sampler2D uRow;
uniform int uStateW;
uniform float uCuts; // number of cut-outs (each has three depths)
uniform vec2 uLen;   // x: border width, y: shadow offset; in 1/2160 of the stage height at zoom 1
uniform float uFoldDist;   // the eye's distance for the fold's perspective, picture px (cutouts.js FOLD_DIST)
uniform float uFoldShadow; // a folding cut-out's shadow falls 1 + uFoldShadow sin|fold| times as far
uniform float uFront;      // 1: the front mesh, which draws the cut-outs folding now; 0: the mesh, the others

const int CUT_TEXELS = 3; // cutouts.js CUT_TEXELS
// The collage's fragments being torn off are drawn from this depth nearer: the folding cut-outs
// (the front mesh) go between it and the nearest other piece, and stay behind them. It mirrors the
// literal -0.9905 of the torn draw in collage.vert.glsl; the two must change together.
const float TORN_Z = -0.9905;

out vec2 vUV;          // rest position: the texture coordinate and the reveal noise's domain
out vec2 vGrid;        // the rest position in canvas px (y up): the halftone rides with the piece
flat out vec4 vInk;
flat out vec4 vPart;   // x: part, y: reveal, z: a, w: ink
flat out vec4 vLeaf;   // xy: leaf centre (picture px), z: radius (picture px), w: shadow
flat out float vDissolve; // 1: develop / bleed over a collage fragment
out vec2 vTape;        // the tape: the point in the strip's own frame (aTape)
flat out vec2 vTapeOn; // the tape: x how much of it shows (min(border, 1) x tape), y its noise seed (the cut-out)

vec4 fetch(sampler2D s, int i) {
  return texelFetch(s, ivec2(i % uStateW, i / uStateW), 0);
}

// cutouts.js foldPoint: the point p turned deg degrees about the hinge h (x0, y0, x1, y1) and seen
// in perspective from dist; all in picture px. p itself at 0 degrees and on the hinge.
vec2 foldPoint(vec2 p, vec4 h, float deg, float dist) {
  vec2 m = 0.5 * (h.xy + h.zw);
  vec2 u = normalize(h.zw - h.xy);
  vec2 n = vec2(u.y, -u.x);
  vec2 q = p - m;
  float a = dot(q, u);
  float b = dot(q, n);
  float r = radians(deg);
  float w = 1.0 / (1.0 - b * sin(r) / dist);
  return p + u * (a * (w - 1.0)) + n * (b * (cos(r) * w - 1.0));
}

// cutouts.js smearWeight: how far a point of a smeared cut-out goes with the smear sm, 0..1; d the
// point at rest from the pivot, radius the farthest point of the outlines from it; all in picture
// px. 0 without a smear, 0 at the leading edge, 1 at the trailing edge.
float smearWeight(vec2 d, vec2 sm, float radius) {
  float len = length(sm);
  if (len == 0.0) return 0.0;
  return clamp(0.5 + dot(d, sm / len) / (2.0 * radius), 0.0, 1.0);
}

void main() {
  int k = int(aId.x + 0.5);
  int row = int(aId.y + 0.5);
  int part = int(aId.z + 0.5);
  vec4 T = fetch(uCut, CUT_TEXELS * k);     // s cos - 1, s sin, x, y (stage heights at zoom 1)
  vec4 B = fetch(uCut, CUT_TEXELS * k + 1); // border, shadow, cos, sin
  vec4 C = fetch(uCut, CUT_TEXELS * k + 2); // fold (degrees about the hinge, CUT_FOLD), smear x, y (stage heights at zoom 1, CUT_SMEAR), tape (0 or 1, CUT_TAPE)
  float fold = C.x;
  vec4 R = fetch(uRow, row);       // a, ink
  vec2 hinge = (aHinge.zw - aHinge.xy) * uPic.xy;
  bool folding = fold != 0.0 && dot(hinge, hinge) > 0.0;
  bool tape = part == 4;
  float tapeOn = min(B.x, 1.0) * C.w; // how much of the tape shows: with the border, once it is on
  // a folding cut-out is drawn by the front mesh only, every other by the mesh only; the tape is on
  // once the fold is over (the timeline's tape), so it is never drawn while its cut-out folds
  bool hide = R.x <= 0.0 || (part <= 1 && B.y <= 0.0) || ((part == 1 || part == 2) && B.x <= 0.0) || (tape && (tapeOn <= 0.0 || folding)) || folding != (uFront > 0.5);
  if (hide) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not here (yet): outside the clip box
    return;
  }
  // A folding cut-out: its point at rest turned about the hinge first (picture px). With no fold
  // the rest position is used as it is.
  vec2 rest = position;
  if (folding) rest = foldPoint(position * uPic.xy, aHinge * uPic.xyxy, fold, uFoldDist) / uPic.xy;
  // Rigid move about the pivot in picture px (the same unit on both axes): p + (M - I) d + offset.
  // In place, M - I and the offset are exactly 0, so a settled leaf's corners land exactly on its
  // neighbours' and no hairline opens between photo pieces.
  vec2 d = (rest - aPivot.xy) * uPic.xy;
  vec2 md = vec2(T.x * d.x - T.y * d.y, T.y * d.x + T.x * d.y);
  vec2 p = rest + md / uPic.xy + vec2(T.z / (uPic.z * uPic.w), T.w / uPic.w);
  // The smear: the point goes back toward where the cut-out was a frame ago by its weight, which its
  // point at rest decides, so its shadow, border and photo go together (0 with no smear: in place).
  // The tape takes the rigid move only (it is on once the smear is over).
  vec2 sm = C.yz * (uPic.y / uPic.w); // stage heights -> picture px
  if (!tape) p += sm * smearWeight(d, sm, aPivot.z) / uPic.xy;
  // sizes on the paper: 1/2160 of the stage height at zoom 1, in picture px
  float unit = uPic.y / (2160.0 * uPic.w);
  // outline ribbons are as wide as the border, turned with the piece (not folded); the tape's
  // corners lie aOut from its middle, turned with the piece too
  vec2 n = vec2(B.z * aOut.x - B.w * aOut.y, B.w * aOut.x + B.z * aOut.y);
  p += n * ((tape ? 1.0 : uLen.x * B.x) * unit) / uPic.xy;
  // the shadow falls to the bottom right (y down), and lies flat as `shadow` goes to 0; a folding
  // cut-out's falls further, as it stands off the paper
  float lift = folding ? 1.0 + uFoldShadow * sin(radians(abs(fold))) : 1.0;
  if (part <= 1) p += vec2(uLen.y * unit * B.y * lift) / uPic.xy;

  vUV = position;
  vGrid = (picToClip(position) * 0.5 + 0.5) * uStage.xy;
  vInk = aInk;
  vPart = vec4(float(part), aId.w, R.x, R.y);
  vLeaf = vec4(aLeaf.xy * uPic.xy, aLeaf.z, B.y);
  vDissolve = aLeaf.w;
  vTape = aTape;
  vTapeOn = vec2(tapeOn, float(k));
  // depth: three levels per cut-out (shadow, border, photo), nearer for everything drawn later. A
  // folding cut-out's levels lie in the same order between the nearest other piece's level (near)
  // and TORN_Z: in front of every other piece, behind the fragments being torn off.
  float level = float(k * 3 + max(part - 1, 0));
  float near = -0.99 + 1.98 / (3.0 * uCuts);
  float z = folding ? near - (level + 1.0) * ((near - TORN_Z) / (3.0 * uCuts + 1.0)) : 0.99 - level * (1.98 / (3.0 * uCuts));
  // the tape pass neither tests nor writes depth (layers/pieces.js): any z inside the clip box
  if (tape) z = 0.0;
  gl_Position = vec4(picToClip(p), z, 1.0);
}

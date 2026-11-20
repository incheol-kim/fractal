// Strokes: all strokes in one mesh (a ribbon per stroke). Per-stroke state (p, w, ink, photo)
// comes from uState, one texel per score row. Widths are picture px, so they grow with the zoom
// (the camera moves over paper) and stay a fixed part of the stage height. Wires (photo) are
// ribbons that reveal the key image (stroke.frag.glsl). The light lines draw the pencil and ink
// strokes' mesh again through this same shader, so they lie exactly on the dark ones.
in vec2 position; // point on the stroke, picture px
in vec2 aNormal;  // mitre for a half width of 1
in vec2 aSU;      // x: side (+1 / -1), y: u (0..1 along the stroke)
in float aRow;    // score row
in vec4 aInfo;    // x: base width (picture px), y: length (picture px), z: point index, w: stroke id
in float aWire;   // 0: pencil or ink, 1: black wire, 2: red wire

uniform sampler2D uState;
uniform int uStateW;
uniform float uWirePad; // a wire's photo ribbon: its width plus this on each side, picture px

out vec2 vPx;  // picture px
out vec2 vSU;
// per stroke (flat: the same on every vertex of a stroke, so the id stays an exact integer)
flat out vec4 vA;   // x: p, y: ink, z: density, w: coverage scale for lines thinner than MIN_HALF
flat out vec4 vB;   // x: half width (canvas px), y: half extent of the ribbon (canvas px), z: length (picture px), w: stroke id
flat out float vPhoto; // 0: pencil or ink; a wire: 1 black, 2 red

const float INK_GAIN = 2.0;  // an ink line is this much wider than the pencil line
const float MIN_HALF = 0.6;  // canvas px: thinner lines are drawn this wide and lighter
const float DUST = 1.3;      // pencil dust reaches this many half widths past the edge
const float WIRE_CONS = 1.0; // canvas px: a wire's band is drawn this much past its sides and ends,
                             // so that every pixel it touches is drawn whole (conservatively)

void main() {
  int row = int(aRow + 0.5);
  vec4 st = texelFetch(uState, ivec2(row % uStateW, row / uStateW), 0);
  float p = st.x;
  float w = st.y;
  float ink = st.z;
  float photo = st.w;
  if (p <= 0.0 || row < 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not started: outside the clip box
    return;
  }
  float k = uStage.z;                     // canvas px per picture px
  float pw = clamp(w / 0.5, 0.0, 1.8);   // pressure: 1 for a mezzo-forte parent note
  float wPic;
  float dens;
  if (photo > 0.5) {
    // Wire strokes are photo: the band is the wire's width plus uWirePad on each side (the
    // pixels the plate repainted lie inside it, tools/make_strokes.py fit_wires), with no tremor,
    // so it stays where the wire is in the picture. A pixel's colour comes from the texels under
    // its whole area, so the band is drawn WIRE_CONS canvas px wider at the sides and ends: every
    // pixel it touches is drawn whole. What shows is decided per pixel (stroke.frag.glsl), so the
    // margin shows nothing by itself.
    wPic = aInfo.x + 2.0 * uWirePad;
    dens = 1.0;
  } else {
    wPic = aInfo.x * (0.7 + 0.3 * pw) * mix(1.0, INK_GAIN, ink);
    dens = clamp(0.35 + 0.6 * pw, 0.3, 1.0);
  }
  float halfW = 0.5 * wPic * k;
  float cov = 1.0;
  if (halfW < MIN_HALF && photo < 0.5) {
    cov = halfW / MIN_HALF;
    halfW = MIN_HALF;
  }
  float dust = photo > 0.5 ? 0.0 : DUST * (1.0 - ink);
  float ext = photo > 0.5 ? halfW + WIRE_CONS : halfW * (1.0 + dust) + 1.0;
  // wires: the ends too (aNormal is the plain normal there; the stroke runs along (n.y, -n.x))
  float endOut = photo > 0.5 ? (aSU.y <= 0.0 ? -WIRE_CONS : aSU.y >= 1.0 ? WIRE_CONS : 0.0) : 0.0;
  vec2 tangent = vec2(aNormal.y, -aNormal.x) / max(length(aNormal), 1e-6);

  // 12 fps tremor: a hash of the stroke, the point and tick12; at most 0.5/1080 of the stage height.
  // Off with ?fx=0 (a still frame for pixel comparisons) and for wires.
  uint h = hash3u(uint(aInfo.w), uint(aInfo.z), uint(uTick));
  float ang = u2f(h) * 6.2831853;
  vec2 jit = vec2(cos(ang), sin(ang)) * u2f(pcg(h)) * 0.5 * uStage.w * uFx * (1.0 - photo); // canvas px

  vec2 px = position + (aNormal * aSU.x * ext + tangent * endOut + vec2(jit.x, -jit.y)) / k;
  vPx = px;
  vSU = aSU;
  vA = vec4(p, ink, dens, cov);
  vB = vec4(halfW, ext, aInfo.y, aInfo.w);
  vPhoto = photo > 0.5 ? max(aWire, 1.0) : 0.0;
  gl_Position = vec4(picToClip(px / uPic.xy), 0.0, 1.0);
}

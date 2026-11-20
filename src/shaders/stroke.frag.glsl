// A stroke, multiplied onto the paper. Only the part already drawn (u <= p) shows. Pencil (ink 0)
// is graphite left on the paper's surface: the lead presses hardest in the middle of the line, so
// graphite reaches into the valleys there and only touches the peaks at the edges (a broken edge),
// with fine grain and streaks along the stroke, pressed in at the start, lifted at the end, and a
// little dust beside it. Ink (ink 1) is a dense black line with a slightly wandering edge. Values
// between mix the two (the crescendo).
//
// A wire (photo) is drawn over the photo pieces with straight alpha: the key image's own pixel,
// where the key differs from the wire-free plate (the wire's pixels), and nothing where they are
// equal. Over a photo piece showing the plate this gives back the key exactly; over paper or a
// flat the wire appears on its own. After the last note it may sway (wire()).
//
// The light pass (uLightPass 1) draws a pencil or ink stroke again, over its dark self, in the
// light colour with straight alpha where the collage under it is dark (lightLine).
in vec2 vPx;
in vec2 vSU;
flat in vec4 vA;
flat in vec4 vB;
flat in float vPhoto;
uniform vec3 uGraphite;
uniform vec3 uInk;
uniform sampler2D uKey;   // the key image (display sRGB values as they are)
uniform sampler2D uPlate; // the same with the wires painted out
uniform sampler2D uWires; // the repainted pixels by wire colour: r black, g red (assets/wire_mask.png)
uniform sampler2D uLifeMap; // where the picture lives (assets/life.png): r flow, the most a wire sways (wire())
uniform float uReveal;    // key - plate (largest channel) at which a wire pixel shows fully
uniform float uLightPass; // 0: the stroke, multiplied; 1: the light line
uniform sampler2D uGround; // the collage alone this frame, the size of the frame being drawn (renderer.js): rgb colour x coverage, a coverage
uniform vec3 uLight;      // the light line's colour
uniform vec3 uPaper;      // the paper's colour: the ground is read as it shows over the paper
uniform vec3 uLightRamp;  // x: ground luminance below which the light line is full; y: how much above it it is gone; z: blur sigma (1/2160 of the stage height at zoom 1)
out vec4 fragColor;

const int GROUND_TAPS = 16; // bilinear reads of the ground per axis at most (a blur of sigma 5 canvas px)

// The ground at this pixel through a Gaussian of sigma canvas px, over texels -r..r on each axis.
// One read takes two neighbouring texels per axis with the bilinear filter, placed between them so
// that its weights are their Gaussian weights; the kernel is separable, so the four texels of a
// read get exactly the product weights.
vec4 groundBlur(float sigma) {
  int r = min(int(ceil(3.0 * sigma)), GROUND_TAPS - 1);
  float k = -0.5 / (sigma * sigma);
  float off[GROUND_TAPS];
  float wt[GROUND_TAPS];
  int n = 0;
  float total = 0.0;
  for (int i = -r; i <= r; i += 2) {
    float w0 = exp(k * float(i * i));
    float w1 = i < r ? exp(k * float((i + 1) * (i + 1))) : 0.0;
    off[n] = float(i) + w1 / (w0 + w1);
    wt[n] = w0 + w1;
    total += wt[n];
    n++;
  }
  vec2 inv = 1.0 / uStage.xy;
  vec4 s = vec4(0.0);
  for (int y = 0; y < n; y++) {
    for (int x = 0; x < n; x++) {
      s += wt[x] * wt[y] * textureLod(uGround, (gl_FragCoord.xy + vec2(off[x], off[y])) * inv, 0.0);
    }
  }
  return s / (total * total);
}

// The light line over a stroke of alpha a: the stroke's alpha x the ground's coverage x (1 - light),
// light from the luminance of the ground, blurred, as it shows over the paper (the same as the
// collage's own colour where it covers fully; at its shadow and its soft edges the paper shows
// through, so a dark shadow on the paper does not make the line light).
void lightLine(float a) {
  float sigma = max(uLightRamp.z * uPic.y / (2160.0 * uPic.w) * uStage.z, 0.25); // canvas px
  vec4 g = groundBlur(sigma);
  vec3 c = g.rgb + (1.0 - g.a) * uPaper;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float light = clamp((lum - uLightRamp.x) / uLightRamp.y, 0.0, 1.0);
  float al = a * g.a * (1.0 - light);
  if (al <= 0.0) discard;
  fragColor = vec4(uLight, al);
}

void wire() {
  // After the last note, in the signs of life, the wire sways (uSway): the key and the plate are
  // read up to uSway.x picture px up or down, a wave running along x whose phase also turns with the
  // height, so wires at different heights sway apart, and as much as the sky behind it flows (the
  // life map's flow): still where the map holds the sky, next to the poles and buildings it hangs
  // from and the stretches of wire the plate kept, so it never parts from them. That is less than
  // the band's margin past the wire (WIRE_PAD, ribbons.js), so the wire stays inside it. The
  // sway is a function of the picture point alone: the strokes of one wire meet end to end and
  // overlap, and a phase of each stroke's own (its id) would break the wire at every joint and double
  // it where two overlap. Without the sway the read is at vPx exactly.
  // sampled before the discard below, so the texture derivatives are well defined
  float flow = texture(uLifeMap, vPx / uPic.xy).r;
  float sway = uSway.x > 0.0 ? uSway.x * flow * sin(uSway.y + vPx.x / 90.0 + vPx.y / 60.0) : 0.0;
  vec2 uv = (vPx - vec2(0.0, sway)) / uPic.xy;
  vec3 key = texture(uKey, uv).rgb;
  vec3 plate = texture(uPlate, uv).rgb;
  float red = texture(uWires, uv).g;
  if (vSU.y > vA.x) discard; // not drawn yet
  vec3 d = abs(key - plate);
  float a = clamp(max(d.r, max(d.g, d.b)) / uReveal, 0.0, 1.0);
  // a black wire does not show the red wires' pixels (they are drawn later, beside it); its own
  // reach in full up to the edge of what the plate repainted. A red wire, drawn last, shows
  // every wire pixel under it.
  if (vPhoto < 1.5) a *= 1.0 - red;
  if (a <= 0.0) discard;
  fragColor = vec4(key, a);
}

void main() {
  if (vPhoto > 0.5) {
    wire();
    return;
  }
  float p = vA.x;
  if (vSU.y > p) discard;
  float ink = vA.y;
  float dens = vA.z;
  float len = vB.z;
  uint sid = uint(vB.w + 0.5);
  float k = uStage.z;
  float lodPx = 1.0 / k;                 // picture px per canvas px
  float along = vSU.y * len;             // picture px from the start
  float d = abs(vSU.x) * vB.y;           // canvas px from the centre line
  float across = vSU.x * vB.y / k;       // picture px across, signed

  // pressure along the stroke: pressed in, lifted out, a slow wander of the hand
  float taper = mix(0.75, 1.0, smoothstep(0.0, 3.0, along)) * mix(0.45, 1.0, smoothstep(0.0, 7.0, len - along));
  float hand = 1.0 + 0.14 * fbm(vec2(along / 24.0, float(sid) * 0.71), 2, lodPx / 24.0, 33u);
  // the edge wanders a little along the stroke (less for ink)
  float wob = 1.0 + 0.16 * fbm(vec2(along / 6.0, float(sid) * 0.37), 2, lodPx / 6.0, 31u);
  float halfW = vB.x * taper * mix(wob, 1.0 + 0.5 * (wob - 1.0), ink);
  float core = clamp(halfW + 0.5 - d, 0.0, 1.0);

  // pencil: the paper surface (tooth, finer grain, streaks along the stroke) against the pressure
  float x = clamp(d / max(halfW, 1e-3), 0.0, 1.0);
  float press = clamp(dens * hand * (0.85 + 0.15 * taper) * (1.0 - 0.6 * x * x), 0.0, 1.0);
  float tooth = paperTooth(vPx, lodPx);
  float fine = 1.4 * fbm(vPx / 0.38, 2, lodPx / 0.38, 43u);
  float streak = 1.4 * fbm(vec2(along / 14.0, across / 0.28), 2, lodPx / 0.28, 41u + sid);
  float surface = 0.45 * tooth + 0.4 * fine + 0.55 * streak;
  // graphite where the surface rises above what the pressure leaves untouched; when the surface
  // detail is finer than a pixel (detail -> 0) the same law on its mean (a wide sigmoid)
  float lift = 1.1 * press - 0.75;
  float detail = 1.0 - smoothstep(0.3, 0.9, lodPx / 0.38);
  float deposit = mix(smoothstep(-0.7, 0.7, lift), smoothstep(-0.16, 0.16, surface + lift), detail) * (0.5 + 0.4 * press);
  float pencil = core * deposit;

  // dust: round specks of graphite beside the line, only when they are big enough to see
  float dust = 0.0;
  float beyond = d - halfW;
  float cellPx = 0.55; // picture px
  float speckSize = cellPx * k;
  if (beyond > 0.0 && ink < 0.99 && speckSize > 1.0) {
    vec2 cell = floor(vPx / cellPx);
    uint hh = hash3u(uint(int(cell.x)), uint(int(cell.y)), 77u + sid);
    vec2 ctr = vec2(u2f(hh), u2f(pcg(hh))) * 0.6 + 0.2;
    float r = (0.1 + 0.2 * u2f(pcg(hh ^ 0x9e3779b9u))) * speckSize;
    float dc = length((vPx / cellPx - cell - ctr) * speckSize);
    float reach = max(vB.y - 1.0 - halfW, 1e-3);
    float near = 1.0 - smoothstep(0.0, reach, beyond);
    float on = step(1.0 - 0.12 * near * near, u2f(pcg(hh + 1u)));
    dust = on * clamp(r + 0.5 - dc, 0.0, 1.0) * dens * 0.5 * smoothstep(1.0, 2.5, speckSize);
  }

  float inkA = core * (0.92 + 0.08 * smoothstep(-0.5, 0.5, streak));
  float a = mix(max(pencil, dust), inkA, ink);
  a *= vA.w;
  if (a <= 0.0) discard;
  if (uLightPass > 0.5) {
    lightLine(clamp(a, 0.0, 1.0));
    return;
  }
  vec3 col = mix(uGraphite, uInk, ink);
  fragColor = vec4(mix(vec3(1.0), col, clamp(a, 0.0, 1.0)), 1.0);
}

// A collage fragment: a piece of another picture, clipped from a print and pasted on. The content
// has its colour turned down like a magazine print (saturation, lifted blacks, dulled whites, a
// faint print grain with ?fx on); the torn white edge is a ribbon round the fragment's outline as
// wide as noise says (fixed to the paper, different for every leaf and cut); the shadow is that
// shape again, offset, dark and translucent. Straight alpha over what is below, times the
// fragment's opacity (a fragment being torn off fades at the end of its tear; the edge and shadow of
// one under a develop or bleed piece fade as the piece comes up).
// A window's miniature (uPip, layers/collage.js) is the frame as it is drawn, a screen, not a print:
// no print look; outside it (its texture coordinates outside 0..1) the bezel.
in vec2 vCurUV;
in vec2 vPrevUV;
in vec2 vRest;
in float vSide;
in float vOpen;
flat in vec4 vPart;
flat in uint vSeed;
uniform sampler2D uCur;  // the block's current cut (baked, colour shift included)
uniform sampler2D uPrev; // the cut it is being pasted over (the current one again when there is none)
uniform vec4 uLen;       // x, y: torn edge width range (1/2160 of the stage height at zoom 1)
uniform vec4 uLook;      // x: saturation; y, z: what black and white print as (0..1); w: print grain strength
uniform vec3 uEdge;      // the paper's white core
uniform vec4 uShadow;    // rgb, alpha of a full shadow
uniform vec2 uPip;       // x: 1 when the current cut is the miniature of the frame, y: the same for the previous one
uniform vec3 uPipBezel;  // the bezel round a miniature
out vec4 fragColor;

// 1 inside the miniature (uv in 0..1), 0 outside it (the bezel), antialiased over a pixel
float screenMask(vec2 uv) {
  vec2 d = min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-6));
  return clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
}

// How wide the torn edge is at a picture point (px), 1/2160 of the stage height: broad wandering
// plus short fibres, so the white runs from thin to wide and frays.
float edgeWidth(vec2 px, uint seed) {
  float lod = 1.0 / uStage.z; // picture px per canvas px
  float n = 0.5 + 0.95 * fbm(px / 16.0, 3, lod / 16.0, seed) + 0.4 * fbm(px / 2.5, 2, lod / 2.5, seed + 3u);
  return mix(uLen.x, uLen.y, clamp(n, 0.0, 1.0));
}

// The print's grain at a picture point (px): about 1, a few per cent darker and lighter.
float printGrain(vec2 px) {
  float lod = 1.0 / uStage.z;
  return 1.0 + 0.035 * fbm(px / 1.6, 2, lod / 1.6, 41u) + 0.025 * fbm(px / 20.0, 2, lod / 20.0, 42u);
}

void main() {
  // everything with derivatives first, in uniform control flow (part is the same on a whole triangle)
  vec3 cur = texture(uCur, vCurUV).rgb;
  vec3 prev = texture(uPrev, vPrevUV).rgb;
  float screen = screenMask(vPart.y > 0.5 ? vCurUV : vPrevUV);
  int part = int(vPart.x + 0.5);
  bool ribbon = part == 1 || part == 2;
  // the torn edge: inside where the distance from the outline is less than the edge's width; it
  // tapers to nothing (-1: past the outline) along an outline where a pasted leaf of the block lies
  // across it
  float g = ribbon ? abs(vSide) * (uLen.y + 1.5) - mix(-1.0, edgeWidth(vRest, vSeed), vOpen) : -1.0;
  float gw = max(fwidth(g), 1e-4);
  float inside = ribbon ? clamp(0.5 - g / gw, 0.0, 1.0) : 1.0;
  float opacity = vPart.w;

  if (part <= 1) { // shadow
    float al = uShadow.a * vPart.z * inside * opacity;
    if (al <= 0.0) discard;
    fragColor = vec4(uShadow.rgb, al);
    return;
  }
  if (part == 2) { // torn white edge
    if (inside <= 0.0) discard;
    fragColor = vec4(uEdge, inside * opacity);
    return;
  }
  vec3 col = vPart.y > 0.5 ? cur : prev;
  if ((vPart.y > 0.5 ? uPip.x : uPip.y) > 0.5) {
    col = mix(uPipBezel, col, screen); // the miniature as it was drawn, in its bezel
  } else {
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uLook.x);
    col = uLook.y + col * (uLook.z - uLook.y);
    if (uFx > 0.5) col *= 1.0 + uLook.w * (printGrain(vRest) - 1.0);
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), opacity);
}

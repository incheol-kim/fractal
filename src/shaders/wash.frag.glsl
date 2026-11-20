// A wash of thin ink over the paper (multiplied). The blurred mask gives the shape; the mask is
// read through a noise warp, so the edge wanders like wet pigment, with a little ragged noise on
// top. The fill spreads from noise valleys when the chord sounds, pigment gathers in a darker tide
// line at the edge, pools unevenly inside and settles into a fine granulation. Sizes are set for
// the camera zoom at the wash's own time (uZoom), so every wash looks the same on screen when it
// blooms; the stain it leaves stays on the paper and shrinks with it when the camera pulls back.
in vec2 vUV;
in vec2 vPic;
uniform sampler2D uMask; // rgb: ink (crisp), a: coverage (blurred)
uniform vec4 uBox;       // the mask's box, picture 0..1
uniform float uValue;    // density now (washes[i])
uniform float uSpread;   // 0 -> 1 in the first moments after the chord
uniform float uZoom;     // camera zoom at the wash's time
uniform float uWarp;     // how far the edge wanders, stage heights at uZoom
uniform float uSeed;
out vec4 fragColor;

void main() {
  // S: stage heights at the wash's time; lod: those units per canvas pixel now
  float sc = uPic.w * uZoom;
  vec2 S = vec2(vPic.x * uPic.z, vPic.y) * sc;
  float lod = sc / (uStage.z * uPic.y);
  uint seed = uint(uSeed) * 7919u;

  vec2 warp = vec2(fbm(S * 5.0, 3, lod * 5.0, seed + 1u), fbm(S * 5.0 + 31.7, 3, lod * 5.0, seed + 2u))
            + 0.45 * vec2(fbm(S * 19.0, 3, lod * 19.0, seed + 3u), fbm(S * 19.0 + 9.1, 3, lod * 19.0, seed + 4u));
  vec2 dPic = warp * (uWarp * 2.2) / vec2(uPic.z * sc, sc);
  vec4 m = texture(uMask, vUV + dPic / (uBox.zw - uBox.xy));
  if (m.a < 0.02) discard;
  vec3 ink = m.rgb;

  float e = m.a + 0.07 * fbm(S * 90.0, 2, lod * 90.0, seed + 5u);
  float aa = max(fwidth(e), 1e-4);
  float inside = smoothstep(0.5 - aa, 0.5 + aa, e);
  if (inside <= 0.0) discard;

  float g = 0.5 + 0.8 * fbm(S * 3.5, 3, lod * 3.5, seed + 6u);
  float reach = uSpread * 1.2;
  float grow = smoothstep(g - 0.06, g + 0.01, reach);
  float front = (1.0 - smoothstep(0.0, 0.08, reach - g)) * step(uSpread, 0.999);

  float tide = 1.0 - smoothstep(0.0, 0.22, e - 0.5);
  float pool = fbm(S * 11.0, 3, lod * 11.0, seed + 7u);
  vec2 px = vPic * uPic.xy;
  float gran = fbm(px / 2.4, 2, 1.0 / (uStage.z * 2.4), seed + 8u) + 0.5 * fbm(S * 60.0, 2, lod * 60.0, seed + 9u);

  float dens = uValue * inside * grow * (1.0 + 0.9 * tide + 0.7 * front) * (0.85 + 0.6 * pool) * (0.9 + 0.35 * gran);
  fragColor = vec4(mix(vec3(1.0), ink, clamp(dens, 0.0, 1.0)), 1.0);
}

// A flat of riso ink, multiplied onto the paper. Where the leaf's tone is lighter than the pure ink,
// the ink is printed as a 45-degree halftone whose cell is a fixed part of the stage height; the
// dots ride with the plate's offset. With paper texture on, the ink lies a little unevenly.
flat in vec3 vInk;
flat in float vThr;
flat in vec2 vOff;
in vec2 vPic;
uniform float uCell; // halftone cell, in 1/1080 of the stage height
out vec4 fragColor;

void main() {
  float cov = 1.0;
  if (vThr >= 0.0) {
    vec2 c = (gl_FragCoord.xy - vOff) / (uStage.w * uCell);
    float f = halftoneScreen(c);
    float aa = max(fwidth(f), 1e-4) * 0.7;
    cov = smoothstep(vThr - aa, vThr + aa, f);
  }
  float dens = 1.0;
  if (uFx > 0.5) {
    vec2 px = vPic * uPic.xy;
    float lodPx = 1.0 / uStage.z;
    dens = 0.975 + 0.035 * fbm(px / 34.0, 3, lodPx / 34.0, 21u) + 0.02 * fbm(px / 3.0, 2, lodPx / 3.0, 22u);
  }
  fragColor = vec4(mix(vec3(1.0), vInk, clamp(cov * dens, 0.0, 1.0)), 1.0);
}

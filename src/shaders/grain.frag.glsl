// Last pass over everything: the paper's tooth and fibres (fixed to the paper) and film grain
// (fixed to the screen, a new pattern 12 times a second). Drawn with 2x multiply blending:
// output 0.5 leaves the pixel as it is, below darkens, above lightens. All of it weakens after
// the glue (uFilm), when the pieces have become one picture.
in vec2 vClip;
out vec4 fragColor;

void main() {
  vec2 px = clipToPic(vClip) * uPic.xy; // picture px
  float lodPx = 1.0 / uStage.z;         // picture px per canvas px
  float tooth = paperTooth(px, lodPx);
  float fib = paperFibres(px, lodPx);
  vec2 g = gl_FragCoord.xy / uStage.w;  // in 1/1080 of the stage height
  float grain = 1.4 * gnoise(g * 0.85, uint(uTick) * 2654435761u + 5u);
  float f = 1.0 + uFilm * (0.028 * tooth + 0.016 * fib + 0.02 * grain);
  fragColor = vec4(vec3(0.5 * f), 1.0);
}

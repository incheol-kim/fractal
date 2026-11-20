// Paper: the cream ground with a faint cloudy mottle, fixed to the paper (it zooms with the camera).
in vec2 vClip;
uniform vec3 uPaper;
out vec4 fragColor;

void main() {
  vec3 c = uPaper;
  if (uFx > 0.5) {
    vec2 pic = clipToPic(vClip);
    vec2 P = vec2(pic.x * uPic.z, pic.y);   // picture heights, the same unit on both axes
    float lod = 1.0 / (uStage.z * uPic.y);  // picture heights per canvas px
    float m = 0.6 * fbm(P * 4.0, 4, lod * 4.0, 11u) + 0.4 * fbm(P * 21.0, 4, lod * 21.0, 12u);
    // the mottle is a little warmer where the paper is darker
    c *= 1.0 + vec3(0.034, 0.03, 0.026) * m;
  }
  fragColor = vec4(c, 1.0);
}

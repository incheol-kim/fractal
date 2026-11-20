// One direction of a Gaussian blur (used once at load for the wash masks).
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uStep;   // one texel in the blur direction, in uv
uniform float uSigma; // texels
out vec4 fragColor;

void main() {
  int r = int(ceil(uSigma * 3.0));
  vec4 s = vec4(0.0);
  float n = 0.0;
  for (int i = -r; i <= r; i++) {
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    s += w * texture(uTex, vUV + uStep * float(i));
    n += w;
  }
  fragColor = s / n;
}

// Last step of a wash mask (once, at load): the colour stays crisp where the leaves are (so two
// leaves of a wash meet at a sharp, warped line, not a blur), the blurred colour fills in just
// outside them, and alpha is the blurred coverage that gives the wash its soft, wandering edge.
// Output: rgb = ink (not premultiplied), a = coverage.
in vec2 vUV;
uniform sampler2D uSharp; // premultiplied ink, alpha 1 inside the leaves (antialiased)
uniform sampler2D uSoft;  // the same, blurred
out vec4 fragColor;

void main() {
  vec4 s = texture(uSharp, vUV);
  vec4 b = texture(uSoft, vUV);
  vec3 soft = b.rgb / max(b.a, 1e-3);
  vec3 sharp = s.rgb / max(s.a, 1e-3);
  fragColor = vec4(mix(soft, sharp, smoothstep(0.3, 0.7, s.a)), b.a);
}

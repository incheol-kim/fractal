// Premultiplied ink colour, alpha = coverage (the blur keeps both, so colour = rgb / a).
in vec3 vInk;
out vec4 fragColor;

void main() {
  fragColor = vec4(vInk, 1.0);
}

// Wash mask, made once at load: the wash's leaves in their ink colours, drawn into a texture that
// covers the wash's box (uBox: x0, y0, x1, y1 in picture 0..1; texture row 0 = top of the box).
in vec2 position; // picture 0..1
in vec3 aInk;
uniform vec4 uBox;
out vec3 vInk;

void main() {
  vInk = aInk;
  vec2 q = (position - uBox.xy) / (uBox.zw - uBox.xy);
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
}

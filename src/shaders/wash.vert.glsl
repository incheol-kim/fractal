// A wash: one quad over its mask's box, placed on the paper by the camera.
in vec2 position; // 0..1 over the box
uniform vec4 uBox; // x0, y0, x1, y1 in picture 0..1
out vec2 vUV;
out vec2 vPic;

void main() {
  vUV = position;
  vPic = mix(uBox.xy, uBox.zw, position);
  gl_Position = vec4(picToClip(vPic), 0.0, 1.0);
}

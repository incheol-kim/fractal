// The end card's two rectangles (layers/card.js): one triangle over the whole frame, as
// fullscreen.vert.glsl, with vUV the frame's point in the card's text texture (u to the right, v
// down: the texture's row 0 is its 2D canvas's top row, uploaded without a flip).
in vec2 position; // clip coordinates
out vec2 vUV;

void main() {
  vUV = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}

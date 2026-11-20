// ?ref=1: the key image alone, covering the stage (camera at zoom 1, centred).
in vec2 position; // picture 0..1
out vec2 vUV;

void main() {
  vUV = position;
  gl_Position = vec4(picToClip(position), 0.0, 1.0);
}

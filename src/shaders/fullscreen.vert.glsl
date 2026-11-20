// One triangle over the whole canvas (paper, grain, blur passes).
in vec2 position; // clip coordinates
out vec2 vClip;
out vec2 vUV;

void main() {
  vClip = position;
  vUV = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}

in vec2 vUV;
uniform sampler2D uKey; // display sRGB values as they are, row 0 = top
out vec4 fragColor;

void main() {
  fragColor = vec4(texture(uKey, vUV).rgb, 1.0);
}

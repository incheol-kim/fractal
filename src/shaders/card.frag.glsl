// The end card (layers/card.js), straight alpha over what is below.
//   uText 0  black, with the opacity uA (frameState's card.black)
//   uText 1  the text, in uInk (card.js CARD_INK as a display sRGB value) with the opacity uA
//            (card.a) times its coverage in the text texture uMask: R the title's, G the name's, which
//            shows at uNameAlpha (CARD_NAME_ALPHA). The colour comes from uInk alone, so inside a
//            letter at full opacity the pixel is the ink's value exactly.
uniform sampler2D uMask;
uniform vec3 uInk;
uniform float uA;
uniform float uText;
uniform float uNameAlpha;
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uText < 0.5) {
    fragColor = vec4(0.0, 0.0, 0.0, uA);
    return;
  }
  vec2 m = texture(uMask, vUV).rg;
  fragColor = vec4(uInk, uA * clamp(m.r + uNameAlpha * m.g, 0.0, 1.0));
}

// Flats: every leaf that gets a flat, in one mesh. Per-flat state (a, dx, dy, s) comes from
// uState, one texel per score row. dx, dy are stage heights at zoom 1 (the plate is offset on the
// paper, so it zooms with it); s scales the leaf about its centre (the 2-frame overshoot).
in vec2 position;  // picture 0..1
in float aRow;     // score row of this flat
in vec2 aC;        // leaf centre, picture 0..1
in vec4 aInk;      // rgb: ink; a: halftone threshold (< 0: solid)

uniform sampler2D uState;
uniform int uStateW;

flat out vec3 vInk;
flat out float vThr;
flat out vec2 vOff; // plate offset in canvas px (y up, like gl_FragCoord)
out vec2 vPic;

void main() {
  int row = int(aRow + 0.5);
  vec4 st = texelFetch(uState, ivec2(row % uStateW, row / uStateW), 0);
  if (st.x <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not yet: outside the clip box
    return;
  }
  vec2 off = vec2(st.y / (uPic.z * uPic.w), st.z / uPic.w);
  vec2 p = aC + (position - aC) * st.w + off;
  vPic = p;
  vInk = aInk.rgb;
  vThr = aInk.a;
  vOff = vec2(off.x * uCam.z, -off.y * uCam.w) * 0.5 * uStage.xy;
  gl_Position = vec4(picToClip(p), 0.0, 1.0);
}

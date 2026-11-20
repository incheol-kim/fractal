// The flash on the glue chord (41.49): one white rectangle over the whole frame, over everything
// (the grain too), straight alpha over what is below with the opacity state.flash (timeline.js
// flashAt). Not drawn while state.flash is 0, so every other frame is what it is without this layer.
import fullVert from '../shaders/fullscreen.vert.glsl?raw';

const FRAG = `
uniform float uFlash;
out vec4 fragColor;

void main() {
  fragColor = vec4(1.0, 1.0, 1.0, uFlash);
}
`;

export function createFlashLayer(ctx) {
  const uniforms = { uFlash: { value: 0 } };
  const mat = ctx.material({ vert: fullVert, frag: FRAG, uniforms, blend: 'normal', common: false });
  const mesh = ctx.fullscreen(mat, ctx.ORDER.flash);
  mesh.visible = false;
  return {
    objects: [mesh],
    update(state) {
      const a = state.flash;
      mesh.visible = a > 0;
      uniforms.uFlash.value = mesh.visible ? a : 0;
    },
  };
}

// Paper (the ground, first) and the paper's tooth with film grain (the very last pass).
import fullVert from '../shaders/fullscreen.vert.glsl?raw';
import paperFrag from '../shaders/paper.frag.glsl?raw';
import grainFrag from '../shaders/grain.frag.glsl?raw';

export function createPaperLayer(ctx) {
  const { THREE } = ctx;
  const mat = ctx.material({
    vert: fullVert,
    frag: paperFrag,
    uniforms: { uPaper: { value: new THREE.Vector3(...ctx.paper) } },
    blend: 'none',
  });
  const mesh = ctx.fullscreen(mat, ctx.ORDER.paper);
  return { objects: [mesh], update() {} };
}

// Over everything (Task 9's photo pieces too): tooth and fibres fixed to the paper, grain fixed to
// the screen. Off with ?fx=0.
export function createGrainLayer(ctx) {
  const mat = ctx.material({ vert: fullVert, frag: grainFrag, blend: 'multiply2x' });
  const mesh = ctx.fullscreen(mat, ctx.ORDER.grain);
  return {
    objects: [mesh],
    update(state, f) {
      mesh.visible = f.fx;
    },
  };
}

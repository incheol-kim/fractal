// ?ref=1: the key image alone, covering the stage like the picture does at zoom 1. It uses the
// renderer's shared key texture, so it is sampled exactly like the photo pieces and wires.
import refVert from '../shaders/ref.vert.glsl?raw';
import refFrag from '../shaders/ref.frag.glsl?raw';

export function createRefLayer(ctx) {
  const { THREE } = ctx;
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mat = ctx.material({ vert: refVert, frag: refFrag, uniforms: { uKey: { value: ctx.picture('key') } }, blend: 'none' });
  const mesh = ctx.mesh(quad, mat, 0);
  return { objects: [mesh], update() {} };
}

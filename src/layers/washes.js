// Washes: thin ink in the shape of a group of leaves, multiplied onto the paper; density from
// state.washes[i], how far it has spread over its shape from state.washSpread[i]. Each wash's
// shape is drawn into its own mask texture (rgb: the leaves' inks, crisp; a: their coverage,
// blurred) on the first frame, and again at a higher resolution if the canvas grows; the shader
// moves the edge with noise and spreads the fill.
import maskVert from '../shaders/wash_mask.vert.glsl?raw';
import maskFrag from '../shaders/wash_mask.frag.glsl?raw';
import fullVert from '../shaders/fullscreen.vert.glsl?raw';
import blurFrag from '../shaders/blur.frag.glsl?raw';
import combineFrag from '../shaders/wash_combine.frag.glsl?raw';
import washVert from '../shaders/wash.vert.glsl?raw';
import washFrag from '../shaders/wash.frag.glsl?raw';
import { cameraAt } from '../timeline.js';

// Mask resolution: texels per stage height at the camera zoom of the wash's time. It follows the
// canvas height (never below BASE), rising in steps of STEP so that dragging a window larger
// rebuilds the masks a few times only; it never drops (a larger mask is mipmapped).
const BASE = 1080;
const STEP = 360;
const SIGMA = 4; // mask blur, in 1/1080 of the stage height when the wash blooms
const WARP = 16; // how far the edge wanders, in 1/1080 of the stage height when it blooms

const densityFor = (pxH) => Math.max(BASE, Math.ceil(pxH / STEP) * STEP);

// Leaves -> one geometry: positions (picture 0..1) and each leaf's ink colour.
function leavesGeometry(ctx, ids) {
  const pos = [];
  const ink = [];
  const idx = [];
  for (const id of ids) {
    const leaf = ctx.leaf(id);
    if (!leaf) continue;
    const t = ctx.leafTris(id);
    const base = pos.length / 2;
    const c = ctx.ink(leaf.ink);
    for (let i = 0; i < t.position.length; i += 2) {
      pos.push(t.position[i], t.position[i + 1]);
      ink.push(c[0], c[1], c[2]);
    }
    for (const k of t.index) idx.push(base + k);
  }
  const { THREE } = ctx;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
  g.setAttribute('aInk', new THREE.BufferAttribute(new Float32Array(ink), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

function buildMask(ctx, wash, density, maxSide) {
  const { THREE, renderer, pic } = ctx;
  const A = pic.aspect;
  // the camera zoom at the wash's own time (fixed per wash; the mask's resolution follows it)
  const zoom = cameraAt(wash.t, ctx.assets.score.camera).zoom;
  const perPicH = density * zoom; // texels per picture height (the picture height is the stage height at zoom 1)
  const margin = (4 * SIGMA + 2.5 * WARP) / (BASE * zoom); // picture heights
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const id of wash.leaves) {
    const l = ctx.leaf(id);
    if (!l) continue;
    box = [Math.min(box[0], l.bbox[0]), Math.min(box[1], l.bbox[1]), Math.max(box[2], l.bbox[2]), Math.max(box[3], l.bbox[3])];
  }
  if (!(box[2] > box[0] && box[3] > box[1])) return null;
  box = [box[0] - margin / A, box[1] - margin, box[2] + margin / A, box[3] + margin];
  let w = Math.ceil((box[2] - box[0]) * A * perPicH);
  let h = Math.ceil((box[3] - box[1]) * perPicH);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(8, Math.ceil(w * scale));
  h = Math.max(8, Math.ceil(h * scale));
  const sigma = SIGMA * (density / BASE) * scale; // texels

  const rtOpts = {
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    magFilter: THREE.LinearFilter,
  };
  const linear = { ...rtOpts, minFilter: THREE.LinearFilter, generateMipmaps: false };
  const target = new THREE.WebGLRenderTarget(w, h, { ...rtOpts, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
  const sharp = new THREE.WebGLRenderTarget(w, h, { ...linear, samples: 4 });
  const tmp = new THREE.WebGLRenderTarget(w, h, linear);
  const soft = new THREE.WebGLRenderTarget(w, h, linear);

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = leavesGeometry(ctx, wash.leaves);
  const leafMat = ctx.material({
    vert: maskVert,
    frag: maskFrag,
    uniforms: { uBox: { value: new THREE.Vector4(...box) } },
    blend: 'none',
    common: false,
  });
  const leafScene = new THREE.Scene();
  leafScene.add(ctx.mesh(geo, leafMat, 0));

  const pass = (frag, uniforms) => {
    const mat = ctx.material({ vert: fullVert, frag, uniforms, blend: 'none', common: false });
    const scene = new THREE.Scene();
    scene.add(ctx.fullscreen(mat, 0));
    return { mat, scene };
  };
  const blur = pass(blurFrag, { uTex: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: sigma } });
  const combine = pass(combineFrag, { uSharp: { value: sharp.texture }, uSoft: { value: soft.texture } });
  const draw = (rt, scene) => {
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
  };

  const prevTarget = renderer.getRenderTarget();
  renderer.setClearColor(0x000000, 0);
  draw(sharp, leafScene); // the leaves in their inks, antialiased
  blur.mat.uniforms.uTex.value = sharp.texture;
  blur.mat.uniforms.uStep.value.set(1 / w, 0);
  draw(tmp, blur.scene);
  blur.mat.uniforms.uTex.value = tmp.texture;
  blur.mat.uniforms.uStep.value.set(0, 1 / h);
  draw(soft, blur.scene);
  draw(target, combine.scene); // crisp colour, blurred coverage (mipmapped for later zoom-outs)
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(0x000000, 1);

  geo.dispose();
  leafMat.dispose();
  blur.mat.dispose();
  combine.mat.dispose();
  for (const rt of [sharp, tmp, soft]) rt.dispose();
  return { target, box, zoom };
}

export function createWashesLayer(ctx) {
  const { THREE, renderer } = ctx;
  const washes = ctx.assets.score.washes;
  const gl = renderer.getContext();
  // only the GPU limits the mask size (the MSAA pass needs a renderbuffer of the same size)
  const maxSide = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  quad.setIndex([0, 1, 2, 0, 2, 3]);

  const items = washes.map((w, i) => {
    const uniforms = {
      uMask: { value: null },
      uBox: { value: new THREE.Vector4() },
      uValue: { value: 0 },
      uSpread: { value: 0 },
      uZoom: { value: 1 },
      uWarp: { value: WARP / 1080 },
      uSeed: { value: i + 1 },
    };
    const mesh = ctx.mesh(quad, ctx.material({ vert: washVert, frag: washFrag, uniforms }), ctx.ORDER.washes);
    mesh.visible = false;
    return { wash: w, mesh, uniforms, target: null };
  });

  // (Re)build every mask at a density; called from update(), where the canvas height is known.
  let built = 0;
  function build(density) {
    for (const it of items) {
      if (it.target) it.target.dispose(); // first, so the old and the new mask are not held together
      const m = buildMask(ctx, it.wash, density, maxSide);
      it.target = m ? m.target : null;
      if (!m) continue;
      it.uniforms.uMask.value = m.target.texture;
      it.uniforms.uBox.value.set(...m.box);
      it.uniforms.uZoom.value = m.zoom;
    }
    built = density;
  }

  return {
    objects: items.map((it) => it.mesh),
    update(state, f) {
      const need = densityFor(f.h);
      if (need > built) build(need);
      items.forEach((it, i) => {
        if (!it.target) {
          it.mesh.visible = false;
          return;
        }
        const v = state.washes[i] || 0;
        it.mesh.visible = v > 1e-4;
        it.uniforms.uValue.value = v;
        it.uniforms.uSpread.value = state.washSpread[i];
      });
    },
  };
}

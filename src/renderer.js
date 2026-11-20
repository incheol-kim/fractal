// Renderer: one WebGL2 canvas; each layer adds its meshes to one scene and updates its uniforms
// from the frame state. Layers draw in ORDER, each one multiplied onto what is below (paper
// first), so inks darken where they overlap and paper shows where they part. The renderer and the
// layers compute nothing from the time: every value that changes with t comes from frameState
// (timeline.js) and is drawn as it is.
//
// Colour: textures and output keep display sRGB values as they are (no colour management, no
// tone mapping), so multiply blending works on the values in the files.
//
// Camera: the picture COVERS the stage at zoom 1 (uniform scale, max of the two fits). camera.cx,
// cy is the picture point at the stage centre; zoom multiplies the scale. Every layer goes through
// picToClip() in common.glsl, so the paper, its texture and every stroke move together.
//
// Ground: a layer may name some of its objects as ground (layer.ground: Object3D[]; the collage
// does). Every frame, before the picture, those objects alone are drawn into a render target the
// size of the canvas, cleared to transparent black: rgb is their colour times their coverage
// (straight-alpha blending onto nothing leaves it premultiplied), a their coverage. Layers drawn
// later read it as ctx.ground.texture at their own pixel (the light lines, layers/strokes.js). The
// objects stay in the picture too: three's object layers put them in both draws (GROUND).
//
// Picture in picture (timeline.js pipCollage; collage.js PIP): while a glass room is a window
// (state.collageBase is set) the whole frame is first drawn PIP_LEVELS times more, each into a
// target of its own with a ground of its own, innermost first: the innermost with the collage
// without windows (the rooms as they are), each next one with its rooms showing the level drawn just
// before; the canvas last, its rooms showing the first level. Every level is the same state (the
// same time, camera and film effects) drawn at its own size (frame(state, w, h)); nothing is read
// from an earlier frame. Sizes: pipSizes for the canvas and the central room (resize).
//
// Sub-frames (renderAveraged; main.js renderFrame's { sub, shutter, jitter }, subframes.js): a video
// frame can be the average of n whole frames, each of its own state (a time in the shutter window)
// and shifted by its own sub-pixel jitter ([0, 0] for all with renderFrame's jitter off, so that with
// shutter 0 too the average is the plain frame). Each is drawn as render() draws one (the miniatures
// first, then the canvas's frame with its ground), the canvas's frame into a target like the canvas
// (4x MSAA, depth), whose resolved pixels are added, times 1/n, into a 32-bit float sum; the sum
// then goes to the canvas rounded to the nearest 8-bit value. The values are averaged as drawn
// (display sRGB, like the blending and the MSAA resolve of every frame), so the averaged edges
// continue the look the picture has. The jitter moves the canvas's frame only (uShift, through
// picToClip and clipToPic: everything placed on the picture, the paper's mottle and tooth too); what
// is fixed to the screen stays (the grain, the flats' halftone screen, the flash, the end card) and
// so do the miniatures' own frames (they show in the rooms, which move). One path only: without
// 32-bit float blending (EXT_color_buffer_float, EXT_float_blend) renderAveraged throws.
import * as THREE from 'three';
import commonGLSL from './shaders/common.glsl?raw';
import fullVert from './shaders/fullscreen.vert.glsl?raw';
import { triangulateLeaf } from './geometry.js';
import { hexRGB } from './assets.js';
import { pipSizes, PIP_LEVELS, PIP_ROOM } from './collage.js';
import { createPaperLayer, createGrainLayer } from './layers/paper.js';
import { createWashesLayer } from './layers/washes.js';
import { createFlatsLayer } from './layers/flats.js';
import { createCollageLayer } from './layers/collage.js';
import { createStrokesLayer } from './layers/strokes.js';
import { createPiecesLayer } from './layers/pieces.js';
import { createRefLayer } from './layers/ref.js';
import { createFlashLayer } from './layers/flash.js';
import { createCardLayer } from './layers/card.js';

// Draw order: the collage over the flats and under the pencil, the light lines (the pencil again in
// paper colour where the collage under it is dark) over the pencil, the photo pieces over both, the
// fragments being torn off (Task 11) over the photo, the wires (photo strokes) over them (the masking
// tape at wires + 0.5); the grain over everything, the glue chord's flash over the grain, and the end
// card over all of it (its black, then its text at card + 0.5).
export const ORDER = { paper: 0, washes: 10, flats: 20, collage: 25, strokes: 30, light: 31, pieces: 40, tear: 45, wires: 50, grain: 90, flash: 95, card: 99 };

const STATE_W = 1024; // texels per line of a state texture
const GROUND = 1; // three's object layer of the ground objects (every object is on layer 0, the picture's)

const BLEND = {
  // opaque
  none: { blending: THREE.NoBlending, transparent: false },
  // dst = dst * src.rgb (the shader outputs the factor; 1 leaves the pixel as it is)
  multiply: {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
  },
  // dst = 2 * dst * src.rgb (0.5 leaves the pixel as it is): lightens and darkens
  multiply2x: {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
  },
  // straight alpha over (photo pieces and wires); alpha 1 replaces the pixel exactly
  normal: { blending: THREE.NormalBlending, transparent: true },
  // dst = dst + src (a sub-frame into the float sum, renderAveraged)
  add: {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
  },
};

const PLAIN = 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';

// Sub-frames (renderAveraged), pixel for pixel (texelFetch): one sub-frame's pixels, as drawn, times
// its weight 1/n; the sum, rounded to the nearest 8-bit value (written exactly as k / 255, so the
// canvas keeps k).
const ADD_FRAG = `
uniform sampler2D uFrame;
uniform float uWeight;
out vec4 fragColor;

void main() {
  fragColor = vec4(texelFetch(uFrame, ivec2(gl_FragCoord.xy), 0).rgb * uWeight, 0.0);
}
`;
const PRESENT_FRAG = `
uniform sampler2D uSum;
out vec4 fragColor;

void main() {
  vec3 c = clamp(texelFetch(uSum, ivec2(gl_FragCoord.xy), 0).rgb, 0.0, 1.0);
  fragColor = vec4(floor(c * 255.0 + 0.5) / 255.0, 1.0);
}
`;

function rendererName(gl) {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

// opts: { fx: true | false, ref: true | false }. The frame states drawn come from
// frameState(t, score, { fx }) with the same fx.
export function createRenderer(canvas, assets, opts = {}) {
  const fx = opts.fx !== false;
  THREE.ColorManagement.enabled = false;
  // depth: the photo pieces use it so that one cut-out's shadow darkens a pixel only once
  // (see layers/pieces.js); every other layer ignores it
  // antialias (4x MSAA): where blending meets a partly covered edge pixel, the browser and GPU
  // (ANGLE D3D11, NVIDIA) do not give the same values on every draw of the same frame (mostly by
  // 1 of 255, now and then by tens, at a few hundred pixels of a 4K frame); without MSAA every
  // draw is bit-exact. So the state is a pure function of t and the pixels repeat within a small
  // tolerance (a plain WebGL2 page with blended triangles shows the same).
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  const gl = renderer.getContext();

  const regions = assets.regions;
  const A = regions.w / regions.h;
  const pic = { w: regions.w, h: regions.h, aspect: A };
  const leafById = new Map(regions.leaves.map((l) => [l.id, l]));
  const trisCache = new Map();
  const inks = assets.palette.inks.map((i) => hexRGB(i.hex));

  const shared = {
    uCam: { value: new THREE.Vector4(0.5, 0.5, 2, 2) },
    uShift: { value: new THREE.Vector2(0, 0) },
    uStage: { value: new THREE.Vector4(1, 1, 1, 1) },
    uPic: { value: new THREE.Vector4(pic.w, pic.h, A, 1) },
    uTick: { value: 0 },
    uFx: { value: fx ? 1 : 0 },
    uFilm: { value: 1 },
    uLife: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSway: { value: new THREE.Vector2(0, 0) },
  };
  const pictures = new Map();

  const fullTri = new THREE.BufferGeometry();
  fullTri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));

  // Shared helpers for the layers.
  const ctx = {
    THREE,
    renderer,
    assets,
    opts: { ...opts, fx },
    ORDER,
    pic,
    paper: hexRGB(assets.palette.paper),
    inks,
    // ink colour of a palette index (out of range: the darkest ink)
    ink(i) {
      return inks[i] || inks.reduce((a, b) => (a[0] + a[1] + a[2] <= b[0] + b[1] + b[2] ? a : b));
    },
    inkNamed(name) {
      const i = assets.palette.inks.findIndex((x) => x.name === name);
      return i >= 0 ? inks[i] : ctx.ink(-1);
    },
    leaf: (id) => leafById.get(id),
    // A picture (ImageBitmap) as a texture with the sampling every picture of the page has: the
    // values as they are, row 0 at the top (like picture y), mipmapped, anisotropic. format:
    // THREE.RGFormat for two channels. It is uploaded the first time it is drawn (or by
    // renderer.initTexture).
    texture(image, format = THREE.RGBAFormat) {
      const tex = new THREE.Texture(image);
      tex.format = format;
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.premultiplyAlpha = false;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      return tex;
    },
    // the key image ('key'), the wire-free plate ('plate'), the wire pixels ('wires', two
    // channels) or the life map ('lifeMap', not loaded with ?ref=1) as a texture, uploaded once and
    // shared, with the same sampling everywhere (so ?ref=1 and the finished frame sample alike)
    picture(name) {
      if (!pictures.has(name)) pictures.set(name, ctx.texture(assets[name], name === 'wires' ? THREE.RGFormat : THREE.RGBAFormat));
      return pictures.get(name);
    },
    // { position, index } of a leaf in picture 0..1 (triangulated once)
    leafTris(id) {
      if (!trisCache.has(id)) trisCache.set(id, triangulateLeaf(leafById.get(id).polys));
      return trisCache.get(id);
    },
    // RawShaderMaterial (GLSL 3). common: prepend common.glsl and share the frame uniforms.
    material({ vert, frag, uniforms = {}, blend = 'multiply', common = true }) {
      const pre = common ? commonGLSL + '\n' : PLAIN;
      return new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: pre + vert,
        fragmentShader: pre + frag,
        uniforms: common ? { ...shared, ...uniforms } : uniforms,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        ...BLEND[blend],
      });
    },
    // a mesh with no culling (the shaders place everything themselves); the geometries are 2D,
    // so three gets a fixed bounding sphere instead of computing one from them
    mesh(geometry, material, order) {
      if (!geometry.boundingSphere) geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const m = new THREE.Mesh(geometry, material);
      m.frustumCulled = false;
      m.renderOrder = order;
      return m;
    },
    fullscreen(material, order) {
      return ctx.mesh(fullTri, material, order);
    },
    // Float RGBA texture holding n texels (texel i at (i % STATE_W, i / STATE_W)), for per-row state.
    stateTexture(n) {
      const width = STATE_W;
      const height = Math.max(1, Math.ceil(n / width));
      const data = new Float32Array(width * height * 4);
      const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      return {
        texture,
        width,
        set(values) {
          data.set(values.length > data.length ? values.subarray(0, data.length) : values);
          texture.needsUpdate = true;
        },
      };
    },
  };

  const size = { w: canvas.width || 1, h: canvas.height || 1 };
  // A render target with depth, values as they are; mips: mipmapped, samples: MSAA.
  const renderTarget = (w, h, { mips = false, samples = 0 } = {}) =>
    new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: mips,
      samples,
    });
  // The ground target (see the top; none for ?ref=1, the key image alone). It needs depth: the
  // collage keeps a shadow from darkening a pixel twice by the depth test (layers/collage.js). No
  // MSAA and no mipmaps: what reads it reads it blurred. ctx.ground.texture is the ground of the
  // frame being drawn: this one's, or a miniature's (drawFrame).
  const groundTarget = opts.ref ? null : renderTarget(size.w, size.h);
  ctx.ground = groundTarget ? { texture: groundTarget.texture } : null;
  // The miniatures (see the top), outermost first: per level a target (4x MSAA as the canvas, and
  // mipmapped: the smaller rooms read it smaller) and a ground like the canvas's, sized by resize.
  // None for ?ref=1, without the collage or without windows in the score.
  const windows = !opts.ref && assets.collageCuts && assets.collage && assets.score.pip && assets.score.pip.length;
  const pipRoom = windows ? assets.collage.blocks.find((b) => b.name === PIP_ROOM) : null;
  const pipLevel = () => ({ target: renderTarget(1, 1, { mips: true, samples: 4 }), ground: renderTarget(1, 1), w: 1, h: 1 });
  const pipLevels = pipRoom ? Array.from({ length: PIP_LEVELS }, pipLevel) : [];
  function sizePip() {
    if (!pipRoom) return;
    pipSizes(size.w, size.h, pipRoom.bbox, pic).forEach(([w, h], i) => {
      const lv = pipLevels[i];
      Object.assign(lv, { w, h });
      lv.target.setSize(w, h);
      lv.ground.setSize(w, h);
    });
  }
  sizePip();

  // the collage needs its baked cuts (assets.collageCuts; not loaded for ?ref=1)
  const layers = opts.ref
    ? [createRefLayer(ctx)]
    : [
        createPaperLayer(ctx),
        createWashesLayer(ctx),
        createFlatsLayer(ctx),
        ...(assets.collageCuts ? [createCollageLayer(ctx)] : []),
        createStrokesLayer(ctx),
        createPiecesLayer(ctx),
        createGrainLayer(ctx),
        createFlashLayer(ctx),
        createCardLayer(ctx),
      ];
  const scene = new THREE.Scene();
  for (const l of layers) for (const o of l.objects) scene.add(o);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const groundCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  groundCamera.layers.set(GROUND);
  for (const l of layers) for (const o of l.ground || []) o.layers.enable(GROUND);
  // the HUD's draw count is the whole frame's, ground included (reset in render and warm)
  renderer.info.autoReset = false;
  // Waits until the GPU has finished what was drawn: gl.finish under ANGLE does not wait for the GPU
  // fully; reading one pixel back does.
  const onePx = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePx);

  // The ground objects alone, as the frame's layers have set them, into a ground target (cleared
  // to transparent black and depth 1 by the render's autoClear; the canvas's by default); then back
  // to the canvas and its opaque clear colour.
  function drawGround(target = groundTarget) {
    if (!target) return;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, groundCamera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
  }

  // Frame uniforms from the camera, the size of the frame being drawn (w x h: the canvas's, or a
  // miniature's), the 12 fps tick, the film strength, the gate weave and the signs of life of the
  // state; jit, a sub-frame's sub-pixel jitter [dx, dy] in px of the frame (renderAveraged; null:
  // none).
  function frame(state, w = size.w, h = size.h, jit = null) {
    const s = w / h;
    const hP = Math.max(s / A, 1); // picture height in stage heights at zoom 1 (cover)
    const cam = opts.ref ? { zoom: 1, cx: 0.5, cy: 0.5 } : state.camera;
    const z = cam.zoom;
    const k = (hP * z * h) / pic.h; // canvas px per picture px
    shared.uCam.value.set(cam.cx, cam.cy, (2 * A * hP * z) / s, 2 * hP * z);
    shared.uStage.value.set(w, h, k, h / 1080);
    shared.uPic.value.set(pic.w, pic.h, A, hP);
    // with ?fx=0 the state's tick12 is 0 and its weave [0, 0]: nothing on screen moves with the
    // tick (grain, weave, stroke tremor, piece jitter)
    shared.uTick.value = state.tick12;
    // paper tooth, grain and weave weaken after the glue (timeline.js filmStrength)
    shared.uFilm.value = state.film;
    // gate weave, stage heights -> clip units (the key image alone, ?ref=1, does not weave)
    // and the hand shake's camera shift (screen heights; the camera, so it stays with ?fx=0)
    const [wx, wy] = opts.ref ? [0, 0] : [state.weave[0] + state.shake[0], state.weave[1] + state.shake[1]];
    // and the jitter, px -> clip units
    if (jit) shared.uShift.value.set((wx * 2) / s + (2 * jit[0]) / w, -wy * 2 + (2 * jit[1]) / h);
    else shared.uShift.value.set((wx * 2) / s, -wy * 2);
    // the signs of life after the last note (timeline.js lifeAt): the drift and the tremble from
    // screen heights to picture px (a screen height is pic.h / hP picture px at zoom 1, whatever the
    // canvas's pixel count, so the picture moves alike at 1080p and 4K), the rooms' breath and the
    // strength; the wires' sway (picture px) and its phase
    const L = state.life;
    shared.uLife.value.set((L.drift * pic.h) / hP, (L.tremble * pic.h) / hP, L.breath, L.k);
    shared.uSway.value.set(L.sway, L.phase);
    return { t: state.t, zoom: z, k, hP, w, h, fx };
  }

  // One whole frame of the state at w x h into target (null: the canvas), with ground as its ground
  // target and jit as its jitter (frame). The layers get f with pip, the texture of the next level in
  // (null: the rooms are not windows), and pipAspect, the canvas's aspect (the miniature's shape in a
  // room).
  function drawFrame(state, w, h, pip, ground, target, jit = null) {
    const f = frame(state, w, h, jit);
    f.pip = pip;
    f.pipAspect = size.w / size.h;
    if (ctx.ground && ground) ctx.ground.texture = ground.texture;
    for (const l of layers) l.update(state, f);
    drawGround(ground);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (target) renderer.setRenderTarget(null);
  }

  // The state's frame at the canvas's size into target (null: the canvas), jittered by jit: while a
  // window shows, the miniatures first, innermost first (see the top; never jittered), then the
  // canvas's frame.
  function drawState(state, target = null, jit = null) {
    let inner = null;
    if (state.collageBase && pipLevels.length) {
      for (let i = pipLevels.length - 1; i >= 0; i--) {
        const lv = pipLevels[i];
        drawFrame(state, lv.w, lv.h, inner, lv.ground, lv.target);
        inner = lv.target.texture;
      }
    }
    drawFrame(state, size.w, size.h, inner, groundTarget, target, jit);
  }

  // The sub-frames' targets (see the top), made by the first averaged frame (a plain frame never
  // needs them) and kept at the canvas's size: target, like the canvas (4x MSAA, depth), which one
  // sub-frame is drawn into; sum, the 32-bit float sum; add and present, the passes between them.
  let avg = null;
  function averaging() {
    if (!avg) {
      if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) {
        throw new Error(
          `sub-frames cannot be averaged here: the browser cannot add into a 32-bit float render target (EXT_color_buffer_float and EXT_float_blend; GPU: ${rendererName(gl)})`,
        );
      }
      const target = renderTarget(size.w, size.h, { samples: 4 });
      const sum = new THREE.WebGLRenderTarget(size.w, size.h, {
        depthBuffer: false,
        stencilBuffer: false,
        type: THREE.FloatType,
        colorSpace: THREE.NoColorSpace,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
      const weight = { value: 1 };
      const pass = (frag, uniforms, blend) => {
        const s = new THREE.Scene();
        s.add(ctx.fullscreen(ctx.material({ vert: fullVert, frag, uniforms, blend, common: false }), 0));
        return s;
      };
      avg = {
        target,
        sum,
        weight,
        add: pass(ADD_FRAG, { uFrame: { value: target.texture }, uWeight: weight }, 'add'),
        present: pass(PRESENT_FRAG, { uSum: { value: sum.texture } }, 'none'),
      };
    }
    if (avg.sum.width !== size.w || avg.sum.height !== size.h) {
      avg.target.setSize(size.w, size.h);
      avg.sum.setSize(size.w, size.h);
    }
    return avg;
  }

  return {
    render(state) {
      renderer.info.reset();
      drawState(state);
    },
    // The average of the sub-frames states[k], each drawn whole and shifted by jitters[k] ([dx, dy],
    // canvas px), onto the canvas (see the top). For two or more; one frame is render()'s.
    renderAveraged(states, jitters) {
      const a = averaging();
      renderer.info.reset();
      renderer.setRenderTarget(a.sum);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(0x000000, 1);
      a.weight.value = 1 / states.length;
      states.forEach((state, k) => {
        drawState(state, a.target, jitters[k]); // resolved into a.target.texture at the end of its draw
        renderer.setRenderTarget(a.sum);
        renderer.autoClear = false; // adds to the sum
        renderer.render(a.add, camera);
        renderer.autoClear = true;
      });
      renderer.setRenderTarget(null);
      renderer.render(a.present, camera);
    },
    // Makes everything the page can draw ready now, so that no layer stalls the first frame it
    // appears in: every shader program compiled and linked, the three pictures uploaded with
    // their mipmaps, the state textures allocated, every mesh's buffers on the GPU. The layers
    // take the state as for render(); a layer with a warm() then readies what one draw does not
    // reach (the collage uploads every cut, not only the two a block shows); then every object is
    // drawn once whether it shows or not, the ground first as in render(), and the GPU is waited
    // for; so too into each miniature's ground and target, which allocates them (MSAA, depth,
    // mipmaps) before a window first shows. Nothing of this reaches a frame: the next render()
    // clears every target it draws into and the canvas (colour and depth), paints the opaque paper
    // first, and every layer sets all of its per-frame values in update().
    warm(state) {
      renderer.info.reset();
      const f = frame(state);
      for (const l of layers) l.update(state, f);
      for (const l of layers) if (l.warm) l.warm();
      const hidden = [];
      scene.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
      renderer.compile(scene, camera); // starts every program at once (parallel compile where the browser has it)
      drawGround();
      renderer.render(scene, camera);
      for (const lv of pipLevels) {
        drawGround(lv.ground);
        renderer.setRenderTarget(lv.target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
      }
      for (const o of hidden) o.visible = false;
      sync();
    },
    resize(pxW, pxH) {
      size.w = Math.max(1, Math.round(pxW));
      size.h = Math.max(1, Math.round(pxH));
      renderer.setSize(size.w, size.h, false);
      if (groundTarget) groundTarget.setSize(size.w, size.h);
      sizePip();
    },
    // waits until the GPU has finished the frame (for stills and timing: renderFrame, FR_LAST_MS)
    finish() {
      sync();
    },
    // true once the browser has taken the drawing context away (nothing is drawn any more)
    lost() {
      return gl.isContextLost();
    },
    // the context's error flag (gl.getError: it is cleared by reading it, and the read waits for
    // the GPU process, so this is for a check after a finish, not for every frame), and the code
    // of an out-of-memory error
    error() {
      return gl.getError();
    },
    OUT_OF_MEMORY: gl.OUT_OF_MEMORY,
    info() {
      return {
        gpu: rendererName(gl),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        samples: gl.getParameter(gl.SAMPLES),
        width: size.w,
        height: size.h,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        // the targets' sizes, [w, h]: the canvas's ground (null for ?ref=1) and the miniatures',
        // outermost first (none for ?ref=1, without the collage or without windows)
        targets: { ground: groundTarget ? [groundTarget.width, groundTarget.height] : null, pip: pipLevels.map((lv) => [lv.target.width, lv.target.height]) },
        // the sub-frame targets' size, [w, h] (renderAveraged; null until the first averaged frame
        // makes them, then kept, at the size of the last averaged frame)
        averaging: avg ? [avg.sum.width, avg.sum.height] : null,
      };
    },
  };
}

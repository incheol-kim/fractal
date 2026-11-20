// Ribbons: what a layer that draws pencil strokes takes (layers/strokes.js, the picture's strokes
// and wires): the strokes as ribbon geometry for stroke.vert.glsl / stroke.frag.glsl and the
// uniforms that material takes. Not a layer: it imports no layer, nor ease.js or timeline.js
// (test/purity.test.js).
//
// Wire strokes (kind wire_black or wire_red) are photo: a ribbon the wire's width plus WIRE_PAD on
// each side shows the key image's own pixels, where the key differs from the wire-free plate by
// WIRE_REVEAL or more (stroke.frag.glsl wire()).
//
// Light lines: where a pencil or ink stroke runs over a dark collage fragment the stroke is drawn
// again (uLightPass 1) in LIGHT_RGB with straight alpha: the stroke's alpha x the ground's coverage x
// (1 - light), light from how bright the ground is under it (ctx.ground, renderer.js;
// stroke.frag.glsl lightLine).
import { buildRibbon } from './geometry.js';

export const WIRE_PAD = 2; // picture px (2944 scale) on each side of a wire's width (tools/make_strokes.py fit_wires)
export const WIRE = { wire_black: 1, wire_red: 2 }; // aWire: 0 pencil or ink (any other kind)
// A wire pixel shows the key fully where the key differs from the plate by this much (0..1, the
// largest channel) and in proportion below it; where they are equal it shows nothing.
const WIRE_REVEAL = 8 / 255;
const GRAPHITE = [0.25, 0.245, 0.24]; // pencil colour where graphite fully covers (multiplied)
// Light lines (start values): their colour; light = clamp((luminance - LIGHT_FROM) / LIGHT_OVER,
// 0, 1) of the ground (0.299 r + 0.587 g + 0.114 b, 0..1) read through a Gaussian of LIGHT_BLUR.
// The plan's start was 82/255 over 46/255; with that a line over a ground of middle luminance
// (0.36..0.5) became a half-light line over its dark self, about as bright as the ground, fainter
// than the dark line alone. The same middle (105/255) over a narrow 8/255 lets a line be light or
// dark there, each readable, with a short change between (Task 10 report).
const LIGHT_RGB = [0xf6 / 255, 0xf0 / 255, 0xe2 / 255]; // #f6f0e2
const LIGHT_FROM = 101 / 255; // the light line is full below this luminance ...
const LIGHT_OVER = 8 / 255; // ... and gone this much above it
const LIGHT_BLUR = 3; // sigma, 1/2160 of the stage height at zoom 1 (px at 4K); it stays with the paper as the camera zooms

// One mesh's geometry for strokes: list [{ stroke: { id, pts (picture 0..1), w, kind }, r }], r the
// stroke's row in the state texture. Every stroke is a ribbon of width 0 (the positions are the centre
// line in picture px, the normals carry the width; geometry.js buildRibbon) with the attributes
// stroke.vert.glsl reads: aNormal, aSU (side, u), aRow, aInfo (w, length in picture px, point index,
// id) and aWire.
export function ribbonGeometry(ctx, list) {
  const { THREE, pic } = ctx;
  const pos = [];
  const nrm = [];
  const su = [];
  const row = [];
  const info = [];
  const wire = [];
  const idx = [];
  for (const { stroke, r } of list) {
    const px = stroke.pts.map(([x, y]) => [x * pic.w, y * pic.h]);
    let len = 0;
    for (let i = 1; i < px.length; i++) len += Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
    const rib = buildRibbon(px, 0); // width 0: the positions are the centre line, normals carry the width
    const base = pos.length / 2;
    for (let v = 0; v < rib.u.length; v++) {
      pos.push(rib.position[v * 2], rib.position[v * 2 + 1]);
      nrm.push(rib.normal[v * 2], rib.normal[v * 2 + 1]);
      su.push(rib.side[v], rib.u[v]);
      row.push(r);
      info.push(stroke.w, len, v >> 1, stroke.id);
      wire.push(WIRE[stroke.kind] || 0);
    }
    for (const k of rib.index) idx.push(base + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
  g.setAttribute('aNormal', new THREE.BufferAttribute(new Float32Array(nrm), 2));
  g.setAttribute('aSU', new THREE.BufferAttribute(new Float32Array(su), 2));
  g.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(row), 1));
  g.setAttribute('aInfo', new THREE.BufferAttribute(new Float32Array(info), 4));
  g.setAttribute('aWire', new THREE.BufferAttribute(new Float32Array(wire), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

// The uniforms of the stroke material (stroke.vert.glsl, stroke.frag.glsl but uLightPass, which each
// material sets itself), for strokes whose state is the texture state (ctx.stateTexture's: p, w, ink,
// photo per row). Materials on the one program must each carry all of them: a uniform a material
// leaves out keeps the value the program last had.
export function strokeUniforms(ctx, state) {
  const { THREE } = ctx;
  return {
    uState: { value: state.texture },
    uStateW: { value: state.width },
    uWirePad: { value: WIRE_PAD },
    uGraphite: { value: new THREE.Vector3(...GRAPHITE) },
    uInk: { value: new THREE.Vector3(...ctx.inkNamed('black')) },
    uKey: { value: ctx.picture('key') },
    uPlate: { value: ctx.picture('plate') },
    uWires: { value: ctx.picture('wires') },
    uLifeMap: { value: ctx.picture('lifeMap') }, // how far a wire sways after the last note (stroke.frag.glsl wire())
    uReveal: { value: WIRE_REVEAL },
    uGround: { value: ctx.ground ? ctx.ground.texture : null },
    uLight: { value: new THREE.Vector3(...LIGHT_RGB) },
    uPaper: { value: new THREE.Vector3(...ctx.paper) },
    uLightRamp: { value: new THREE.Vector3(LIGHT_FROM, LIGHT_OVER, LIGHT_BLUR) },
  };
}

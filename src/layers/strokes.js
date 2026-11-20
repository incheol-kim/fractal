// Strokes: every stroke as a ribbon, all in one mesh; the stroke's score row is a vertex attribute
// and the per-stroke state (p, w, ink, photo) a texel per row, so a frame is one texture upload
// and one draw. A pencil or ink stroke is no longer drawn once all its leaves are photo, and not
// before a folding cut-out among them is upright (cutouts.js hideCoveredStrokes).
//
// Wire strokes (photo = 1 in the score) are a second mesh drawn over the photo pieces
// (ORDER.wires). They are photo: a ribbon the wire's width plus PAD on each side shows the key
// image's own pixels, but only where the key differs from the wire-free plate (the wire's pixels),
// so over a part of the picture that is still paper or flat colour the wire appears alone, not
// a band of photo around it. A black wire shows only black wires' pixels (assets/wire_mask.png):
// the red wires beside them are drawn later, in the coda, and then show every wire pixel. After the
// last note a wire sways inside its band as far as the sky behind it flows (the life map, uSway).
//
// Light lines: where a pencil or ink stroke runs over a dark collage fragment, the same stroke is
// drawn again over it (ORDER.light, the same geometry and state) in a light paper colour with
// straight alpha: the stroke's alpha x the ground's coverage x (1 - light), light from how bright
// the ground is under it (ctx.ground, renderer.js; stroke.frag.glsl lightLine). Over paper, flats
// and light fragments it draws nothing, so the dark stroke under it shows as before. The wires are
// not touched.
//
// The geometry, the material's uniforms and their constants (WIRE_PAD, the light lines' ramp) are in
// ribbons.js.
import strokeVert from '../shaders/stroke.vert.glsl?raw';
import strokeFrag from '../shaders/stroke.frag.glsl?raw';
import { ribbonGeometry, strokeUniforms } from '../ribbons.js';
import { pieceRowOfLeaf, strokeLeafRows, hideCoveredStrokes } from '../cutouts.js';

export function createStrokesLayer(ctx) {
  const events = ctx.assets.score.strokes;
  const strokes = ctx.assets.strokes.strokes;
  const byId = new Map(strokes.map((s) => [s.id, s]));
  const rowOf = pieceRowOfLeaf(ctx.assets.score.pieces);
  const lines = [];
  const wires = [];
  const leafRows = strokeLeafRows(events, byId, rowOf);
  events.forEach((ev, r) => {
    const stroke = byId.get(ev.s);
    if (!stroke || stroke.pts.length < 2) return;
    (ev.photo ? wires : lines).push({ stroke, r });
  });

  const state = ctx.stateTexture(events.length);
  const shown = new Float32Array(events.length * 4);
  const uniforms = strokeUniforms(ctx, state);
  // the three meshes share one program, so each material sets uLightPass (a uniform a material
  // leaves out keeps the value the program last had)
  const make = (geo, order, blend, lightPass) =>
    ctx.mesh(geo, ctx.material({ vert: strokeVert, frag: strokeFrag, uniforms: { ...uniforms, uLightPass: { value: lightPass } }, blend }), order);
  const lineGeo = ribbonGeometry(ctx, lines);
  const lineMesh = make(lineGeo, ctx.ORDER.strokes, 'multiply', 0);
  const lightMesh = ctx.ground ? make(lineGeo, ctx.ORDER.light, 'normal', 1) : null;
  const wireMesh = make(ribbonGeometry(ctx, wires), ctx.ORDER.wires, 'normal', 0);
  const anyStarted = (list, v) => list.some(({ r }) => v[r * 4] > 0);

  return {
    objects: lightMesh ? [lineMesh, lightMesh, wireMesh] : [lineMesh, wireMesh],
    update(s) {
      // the ground of the frame being drawn: the canvas's, or a miniature's (each level of the
      // picture in picture has its own, renderer.js)
      if (ctx.ground) uniforms.uGround.value = ctx.ground.texture;
      hideCoveredStrokes(s.strokes, leafRows, s.pieces, s.fold, shown);
      state.set(shown);
      lineMesh.visible = anyStarted(lines, shown);
      if (lightMesh) lightMesh.visible = lineMesh.visible;
      wireMesh.visible = anyStarted(wires, shown);
    },
  };
}

// Flats: a leaf's flat of ink, multiplied onto the paper. One mesh holds every leaf that has a
// flat event; per-flat state (a, dx, dy, s) is a texel per score row (score.flats order). A flat
// is no longer drawn once its leaf's photo piece is fully photo (cutouts.js hidePhotoFlats).
// The photo pieces print the same halftone for their moment of ink (halftone.js).
import flatVert from '../shaders/flat.vert.glsl?raw';
import flatFrag from '../shaders/flat.frag.glsl?raw';
import { pieceRowOfLeaf, hidePhotoFlats } from '../cutouts.js';
import { CELL, toneThreshold } from '../halftone.js';

export function createFlatsLayer(ctx) {
  const { THREE } = ctx;
  const events = ctx.assets.score.flats;
  const pos = [];
  const row = [];
  const cen = [];
  const ink = [];
  const idx = [];
  events.forEach((ev, r) => {
    const leaf = ctx.leaf(ev.leaf);
    if (!leaf) return;
    const t = ctx.leafTris(leaf.id);
    const c = ctx.ink(leaf.ink);
    const thr = toneThreshold(leaf.tone);
    const base = pos.length / 2;
    for (let i = 0; i < t.position.length; i += 2) {
      pos.push(t.position[i], t.position[i + 1]);
      row.push(r);
      cen.push(leaf.c[0], leaf.c[1]);
      ink.push(c[0], c[1], c[2], thr);
    }
    for (const k of t.index) idx.push(base + k);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
  geo.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(row), 1));
  geo.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(cen), 2));
  geo.setAttribute('aInk', new THREE.BufferAttribute(new Float32Array(ink), 4));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

  const state = ctx.stateTexture(events.length);
  const mat = ctx.material({
    vert: flatVert,
    frag: flatFrag,
    uniforms: { uState: { value: state.texture }, uStateW: { value: state.width }, uCell: { value: CELL } },
  });
  const mesh = ctx.mesh(geo, mat, ctx.ORDER.flats);
  const rowOf = pieceRowOfLeaf(ctx.assets.score.pieces);
  const flatRows = events.map((ev) => (rowOf.has(ev.leaf) ? rowOf.get(ev.leaf) : -1));
  const shown = new Float32Array(events.length * 4);

  return {
    objects: [mesh],
    update(s) {
      hidePhotoFlats(s.flats, flatRows, s.pieces, shown);
      state.set(shown);
      let any = false;
      for (let i = 0; i < shown.length; i += 4) if (shown[i] > 0) { any = true; break; }
      mesh.visible = any;
    },
  };
}

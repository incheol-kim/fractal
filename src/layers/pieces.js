// Photo pieces (section C and the coda): the picture cut out along its leaves and stuck onto the
// drawing. Every leaf is triangulated (triangulateLeaf) and textured with the wire-free plate at
// its rest position, crossfading to the key image by state.plateToKey at the end (with the signs of
// life on it stays the plate, and the plate lives where the life map lets it: piece.frag.glsl,
// the shared uLife).
//
// Cut-outs (cutouts.js groupCutouts): the leaves of one note move rigidly, one transform about one
// pivot. Each cut-out is drawn as
//   shadow  the cut-out widened by its border, shifted SHADOW to the bottom right, dark, translucent
//   border  a white ribbon BORDER wide on each side of every leaf outline (the inner ones are
//           covered by the neighbouring leaves' photo, so the white shows round the cut-out only)
//   photo   the leaves, with their ink colour (halftone) for the moment `ink` says
// and the cut-outs large first (small ones land on top); then the cut-outs' masking tape over them
// all (see below).
//
// Everything is one mesh in that order, one draw, but for a cut-out while it folds, which the front
// mesh draws after it, and the tape, which the tape mesh draws last (see below). The depth buffer
// keeps a cut-out's shadow from darkening a pixel twice where its parts overlap: every part of
// cut-out k has its own depth, nearer for later parts, and the depth test is LESS, so the second
// shadow triangle on a pixel (same depth) fails while everything drawn later passes.
//
// A large fold cut-out (the 37.81 chord) stands up about its hinge, the lower edge of the box round
// its leaves: while the timeline's fold is not 0 every point of it is first turned about the hinge
// and seen in perspective (cutouts.js foldPoint), then moved as above. Its shadow falls
// 1 + FOLD_SHADOW sin|fold| times as far; the border ribbon's outward direction is not folded.
// Leaning toward the eye it lies in front of every other piece: while it folds the mesh leaves it
// out and the front mesh (the fold-style cut-outs' parts again, on the same vertex buffers; not
// their tape) draws it after the mesh, shadow, border and photo at depths nearer than any other
// piece's (and farther than the collage's fragments being torn off), so its shadow falls on its
// neighbours and they do not cover its wider top. Two folding cut-outs keep their order. With no
// fold the front mesh draws nothing and the mesh is as it always was.
//
// A large cut-out sliding or slamming in is drawn smeared on its entry frames (the timeline's
// smear): after the move every point of it goes back toward where the cut-out was a frame ago by
// the part cutouts.js smearWeight gives its point at rest, 0 at the leading edge to 1 at the
// trailing edge (the cut-out's radius, the farthest point of its outlines from its pivot, rides
// in aPivot). A point's shadow, border and photo go together; the photo keeps its texture
// coordinates, so the picture stretches with it. With no smear the weight is 0 and nothing moves.
//
// Masking tape: a large pasted cut-out with a spot (cutouts.js tapeSpot) gets one
// strip, TAPE long and wide: a quad whose middle is the spot, on the cut-out's outline, and whose
// long side lies deg degrees from the picture's x, its two short ends torn ragged (piece.frag.glsl).
// It takes the cut-out's rigid move only, never its fold or smear: the timeline puts it on (the
// state's tape, 0 or 1) a frame after the entry has ended, so it is never in the front mesh. Its
// opacity is TAPE_RGBA's times min(border, 1) times tape, so it goes with the border on the glue
// chord; with tape 0 nothing of it is drawn. A strip is over everything in the picture while it is
// on: the tape mesh (the same vertex buffers, the tapes' quads only) draws the tapes last, after the
// wires (tapeOrder; under the grain and the flash), neither testing nor writing depth. The wires are
// part of the photo it is stuck on (the pieces show the wire-free plate); half of a strip lies on a
// neighbour, whatever that is (a later piece, a folding panel, a fragment tearing away), and no
// order puts it right under all of them, while a depth test let their shadows and fades hide it.
// Two tapes keep the cut-outs' order.
//
// develop and bleed emerge in place, with no border, no shadow and no jitter (they never move;
// timeline.js pieceAt): they are revealed through a
// noise threshold that rises with `a`, starting at the leaf's centre; an ink-coloured front runs
// ahead, the photo follows (piece.frag.glsl), and nothing is drawn outside the revealed part.
// Over a collage fragment (a leaf of score.collage.leaves: the blue and red rooms, the coda's
// tree) there is no ink front: the photo comes up through the front, its alpha rising from 0 to 1
// across it over the wrong picture, which shows as it is where the front has not come (the
// timeline keeps that fragment until the piece is whole).
import pieceVert from '../shaders/piece.vert.glsl?raw';
import pieceFrag from '../shaders/piece.frag.glsl?raw';
import { groupCutouts, cutoutTexels, tapeSpot, CUT_TEXELS, CUT_FLOATS, CUT_BORDER, CUT_FOLD, CUT_TAPE, FOLD_DIST } from '../cutouts.js';
import { closedRibbon } from '../geometry.js';
import { CELL, toneThreshold } from '../halftone.js';
import { hexRGB } from '../assets.js';

const BORDER = 5; // white border: 1/2160 of the stage height at zoom 1, beyond the outline
const SHADOW = 6; // shadow offset to the bottom right, 1/2160 of the stage height at zoom 1
const SHADOW_ALPHA = 0.42; // how dark a full shadow is (over the ink black)
const FOLD_SHADOW = 6; // a folding cut-out's shadow falls 1 + FOLD_SHADOW sin|fold| times as far (a starting value)
// masking tape (starting values): length and width, 1/2160 of the stage height at zoom 1 (large
// enough to read as tape at 1080p, not as a fleck); colour and opacity
const TAPE = [100, 32];
const TAPE_RGBA = [...hexRGB('#e9dba9'), 0.8];
const REVEAL = { develop: 1, bleed: 2 };
const PART = { shadowFill: 0, shadowRibbon: 1, border: 2, photo: 3, tape: 4 };

export function createPiecesLayer(ctx) {
  const { THREE, pic } = ctx;
  const score = ctx.assets.score;
  const cuts = groupCutouts(score.pieces, ctx.leaf);
  // the leaves a collage fragment lies on until their photo comes (develop and bleed dissolve it)
  const overCollage = new Set(score.collage ? score.collage.leaves.map((r) => r.leaf) : []);

  // each cut-out's radius for the smear: the farthest point of its leaves' outlines from its pivot,
  // picture px (at least 1)
  const radii = cuts.map((cut) => {
    let radius = 1;
    for (const row of cut.rows) {
      const leaf = ctx.leaf(score.pieces[row].leaf);
      if (!leaf) continue;
      for (const ring of leaf.polys) {
        for (const [x, y] of ring) radius = Math.max(radius, Math.hypot((x - cut.pivot[0]) * pic.w, (y - cut.pivot[1]) * pic.h));
      }
    }
    return radius;
  });

  const pos = [];
  const out = [];
  const ids = [];
  const pivots = [];
  const hinges = [];
  const inks = [];
  const lfs = [];
  const tapes = [];
  const idx = [];
  let nv = 0;
  // one vertex: rest position (0..1), outward offset (picture px for a half width of 1; the tape's:
  // its corner from its middle, 1/2160 of the stage height), ids, per-leaf data, the tape's own frame
  const vertex = (x, y, ox, oy, k, row, part, cut, mode, L, tape = [0, 0]) => {
    pos.push(x, y);
    out.push(ox, oy);
    ids.push(k, row, part, mode);
    pivots.push(cut.pivot[0], cut.pivot[1], radii[k]);
    hinges.push(...(cut.hinge || [0, 0, 0, 0]));
    inks.push(...L.ink);
    lfs.push(...L.reveal);
    tapes.push(...tape);
    return nv++;
  };

  const front = []; // the index entries of the fold-style cut-outs, in draw order
  const tapeIdx = []; // the index entries of the tapes, in the cut-outs' draw order
  const taped = []; // the cut-outs with a tape
  cuts.forEach((cut, k) => {
    const first = idx.length;
    const mode = REVEAL[cut.style] || 0;
    const leaves = cut.rows
      .map((row) => {
        const leaf = ctx.leaf(score.pieces[row].leaf);
        if (!leaf) return null;
        let radius = 1;
        for (const ring of leaf.polys) {
          for (const [x, y] of ring) radius = Math.max(radius, Math.hypot((x - leaf.c[0]) * pic.w, (y - leaf.c[1]) * pic.h));
        }
        return {
          row,
          leaf,
          tris: ctx.leafTris(leaf.id),
          ink: [...ctx.ink(leaf.ink), toneThreshold(leaf.tone)],
          // the reveal's centre and radius, and 1 where develop / bleed dissolve a collage fragment
          reveal: [leaf.c[0], leaf.c[1], radius, mode && overCollage.has(leaf.id) ? 1 : 0],
        };
      })
      .filter(Boolean);
    const fills = (part) => {
      for (const L of leaves) {
        const base = nv;
        const p = L.tris.position;
        for (let i = 0; i < p.length; i += 2) vertex(p[i], p[i + 1], 0, 0, k, L.row, part, cut, mode, L);
        for (const t of L.tris.index) idx.push(base + t);
      }
    };
    const ribbons = (part) => {
      for (const L of leaves) {
        for (const ring of L.leaf.polys) {
          if (ring.length < 3) continue;
          // the mitres in picture px (the same unit on both axes), the positions back in 0..1
          const rib = closedRibbon(ring.map(([x, y]) => [x * pic.w, y * pic.h]));
          const base = nv;
          for (let v = 0; v < rib.u.length; v++) {
            const [px, py] = rib.points[v >> 1];
            const [x, y] = [px / pic.w, py / pic.h];
            const s = rib.side[v];
            vertex(x, y, rib.normal[v * 2] * s, rib.normal[v * 2 + 1] * s, k, L.row, part, cut, mode, L);
          }
          for (const t of rib.index) idx.push(base + t);
        }
      }
    };
    // develop and bleed emerge in place: no shadow, no border (the timeline gives them 0)
    if (!mode) {
      fills(PART.shadowFill);
      ribbons(PART.shadowRibbon);
      ribbons(PART.border);
    }
    fills(PART.photo);
    if (cut.style === 'fold') for (let i = first; i < idx.length; i++) front.push(idx[i]);
    // the tape: one quad, its corners TAPE / 2 from the spot along and across its long side (turned
    // deg from x toward y, in picture px), in the tape mesh only
    const spot = tapeSpot(cut, ctx.leaf, pic);
    const repLeaf = leaves.find((L) => L.row === cut.rep);
    if (spot && repLeaf) {
      const rad = (spot.deg * Math.PI) / 180;
      const [ux, uy] = [Math.cos(rad), Math.sin(rad)];
      const base = nv;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const [x, y] = [(a * TAPE[0]) / 2, (b * TAPE[1]) / 2];
        vertex(spot.p[0], spot.p[1], ux * x - uy * y, uy * x + ux * y, k, cut.rep, PART.tape, cut, mode, repLeaf, [x, y]);
      }
      tapeIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      taped.push(k);
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
  geo.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(out), 2));
  geo.setAttribute('aId', new THREE.BufferAttribute(new Float32Array(ids), 4));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(pivots), 3));
  geo.setAttribute('aHinge', new THREE.BufferAttribute(new Float32Array(hinges), 4));
  geo.setAttribute('aInk', new THREE.BufferAttribute(new Float32Array(inks), 4));
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(new Float32Array(lfs), 4));
  geo.setAttribute('aTape', new THREE.BufferAttribute(new Float32Array(tapes), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  // the front mesh and the tape mesh: the same vertices (the same buffers on the GPU), the fold-style
  // cut-outs only, the tapes only
  const sharing = (index) => {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
    return g;
  };
  const frontGeo = sharing(front);
  const tapeGeo = sharing(tapeIdx);

  const n = score.pieces.length;
  const rowState = ctx.stateTexture(n); // per score row: a, ink
  const rowData = new Float32Array(n * 4);
  const cutState = ctx.stateTexture(cuts.length * CUT_TEXELS); // per cut-out: CUT_TEXELS texels (cutouts.js cutoutTexels)
  const cutData = new Float32Array(cuts.length * CUT_FLOATS);
  const black = ctx.inkNamed('black');
  const uniforms = {
    uKey: { value: ctx.picture('key') },
    uPlate: { value: ctx.picture('plate') },
    uLifeMap: { value: ctx.picture('lifeMap') },
    uP2K: { value: 0 },
    uRow: { value: rowState.texture },
    uCut: { value: cutState.texture },
    uStateW: { value: rowState.width },
    uCuts: { value: cuts.length },
    uLen: { value: new THREE.Vector2(BORDER, SHADOW) },
    uFoldDist: { value: FOLD_DIST * pic.h }, // picture px
    uFoldShadow: { value: FOLD_SHADOW },
    uCell: { value: CELL },
    uPaper: { value: new THREE.Vector3(...ctx.paper) },
    uShadow: { value: new THREE.Vector4(black[0], black[1], black[2], SHADOW_ALPHA) },
    uTape: { value: new THREE.Vector2(...TAPE) },
    uTapeRGBA: { value: new THREE.Vector4(...TAPE_RGBA) },
  };
  // the three meshes share every uniform object but uFront (what update() sets reaches all of them)
  const material = (u) => {
    const m = ctx.material({ vert: pieceVert, frag: pieceFrag, uniforms: u, blend: 'normal' });
    m.depthTest = true;
    m.depthWrite = true;
    m.depthFunc = THREE.LessDepth;
    return m;
  };
  const mesh = ctx.mesh(geo, material({ ...uniforms, uFront: { value: 0 } }), ctx.ORDER.pieces);
  const frontMesh = ctx.mesh(frontGeo, material({ ...uniforms, uFront: { value: 1 } }), ctx.ORDER.pieces + 0.5);
  // the tapes over everything in the picture, its wires too, under the grain and flash; no depth
  // (see the top)
  const tapeOrder = ctx.ORDER.wires + 0.5;
  const tapeMaterial = material({ ...uniforms, uFront: { value: 0 } });
  tapeMaterial.depthTest = false;
  tapeMaterial.depthWrite = false;
  const tapeMesh = ctx.mesh(tapeGeo, tapeMaterial, tapeOrder);
  mesh.visible = false;
  tapeMesh.visible = false;
  frontMesh.visible = false;

  return {
    objects: [mesh, frontMesh, tapeMesh],
    update(state) {
      let any = false;
      for (let i = 0; i < n; i++) {
        const a = state.pieces[i * 8];
        rowData[i * 4] = a;
        rowData[i * 4 + 1] = state.pieces[i * 8 + 7];
        if (a > 0) any = true;
      }
      mesh.visible = any;
      tapeMesh.visible = false;
      frontMesh.visible = false;
      if (!any) return;
      rowState.set(rowData);
      cutState.set(cutoutTexels(cuts, state, cutData));
      // drawn while a tape is on and its border has not gone (the shader hides every other tape)
      tapeMesh.visible = taped.some((k) => cutData[k * CUT_FLOATS + CUT_TAPE] > 0 && cutData[k * CUT_FLOATS + CUT_BORDER] > 0);
      for (let k = 0; k < cuts.length && !frontMesh.visible; k++) frontMesh.visible = cutData[k * CUT_FLOATS + CUT_FOLD] !== 0;
      uniforms.uP2K.value = state.plateToKey;
    },
  };
}

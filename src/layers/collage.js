// Collage (section B into C): the tower's blocks as fragments of other pictures, clipped from
// prints and pasted on. Each block shows one baked cut (assets/collage/, tools/make_collage.py) on
// those of its leaves that are pasted; on a cello note it may change to its next cut, pasted over
// the one before. Everything drawn comes from state.collage (timeline.js):
//   blocks  cur (the cut shown, -1: none yet), prev (the cut under it while it is pasted, -1: none),
//           u (that paste, 0..1), k (changes so far: the torn edges' seed)
//   leaves  a, dx, dy, s per collage leaf row (score.collage.leaves order)
//   tear    per collage leaf row: 0 < tear < 1 while the fragment is being torn off (its photo
//           piece has landed under it), 1 once it has gone (a is 0 then); 0 for fragments that are
//           not torn off
//   rim     per collage leaf row: the opacity of the fragment's torn edge and shadow (1, but under a
//           develop or bleed piece 1 minus that piece's a: they fade as it comes up)
//   loose   torn edge, tilt and shadow: 1 until the breath before the glue chord, up to GLUE_OPEN
//           on it, then pressed to 0 (timeline.js looseAt); the edge's width, the shadow's offset
//           and opacity follow it as it is, the tilt only up to 1 (collage.js cutUV)
//
// One mesh per block, one draw: for the previous cut (only while the current one is pasted over
// it) and then the current cut,
//   shadow  the fragments widened by their torn edge, offset to the bottom right, dark, translucent
//   edge    a white ribbon round every fragment's outline, torn (noise) from look.torn_edge_px_at_4k
//           [0] to [1] wide, under all of the cut's content; it opens only along outline points
//           where no pasted leaf of the block lies across them (acrossOutline), so the white shows
//           round the part of the block that is pasted now and not in the small gaps the
//           fragments' offsets open inside it (there the paper and the shadow show, as between the
//           flats); along a leaf under a develop or bleed piece it opens as that leaf's rim fades,
//           as far as the fragment is more there than that leaf (openAcross: the leaf's cover,
//           coverAcross, against the fragment's own rim), so it has opened by the frame the
//           leaf's fragment goes and stays shut between two fragments that develop together
//   content the fragments, textured with the cut at their rest position (cutUV: the cut's box on
//           the block's box, turned by tilt x loose about its centre), with the print look
// A cut being pasted comes down over the one before in its 2-frame paste: at the start it is MOVE
// of the block's smaller side off its place (in a direction from the block's and k's hash), larger
// by LIFT[0] and its shadow LIFT[1] times farther, and it drops into place by u = 1 (lift 1 - u^2),
// so the previous cut still shows along one side under the new one's torn edge and shadow. Blocks
// are drawn largest first, so small blocks lie on the large ones, and a block whose cut is being
// pasted over all the others.
//
// Depth keeps one layer's shadow from darkening a pixel twice where its parts overlap, as in
// layers/pieces.js: every part has a depth level, nearer for everything drawn later (see
// collage.vert.glsl), and the test is LESS.
//
// Torn off (C): when a big photo piece lands on a fragment, the fragment is torn off over it. A
// fragment being torn off (0 < tear < 1) is not drawn by its block's mesh but by the block's torn
// mesh, at ORDER.tear (over the photo pieces, under the wires): the same vertices with the current
// cut's content first, then its edge, then its shadow, every part at a depth nearer than any photo
// piece's. It keeps its content and shows its torn white edge all round (it has come away from
// its neighbours, whose own edge opens where it was), and as tearMotion (collage.js) goes it is
// pushed TEAR_PUSH away from its block's centre, turns TEAR_TURN about its own centre (each
// fragment 0.75..1.25 times both, its own way, from a hash of its leaf number: collage.vert.glsl),
// lifts as a pasted cut does before it lands (LIFT, larger, its shadow farther) and fades in the
// last third. Drawn content first, a fading fragment does not show its own edge and shadow
// through itself. The photo piece lands under it as any other (layers/pieces.js).
// Small fragments, and those whose photo comes on the glue chord, are not torn off: they go when
// their photo has covered them (the timeline's a). Under develop and bleed pieces the fragment
// stays whole until the piece has come up over it (layers/pieces.js dissolves it); its torn edge and
// shadow fade by rim meanwhile, and its offset with them (the timeline's dx, dy), so nothing of it is
// left outside the leaf when it goes.
//
// Ground: the block meshes are also the renderer's ground (renderer.js): drawn alone each frame
// into a target of their own, where the light lines (layers/strokes.js) read how dark the collage
// is under each stroke. The torn meshes are not: a fragment being torn off lies over the photo
// pieces, which cover the lines under it; what lies under a line there is the photo piece, not the
// fragment.
//
// Textures: one per baked cut the score uses in any strength (assets.collageCuts), uploaded to the
// GPU all at once by warm(), so a cut's first frame does not stall; then the bitmaps are closed.
//
// Picture in picture (timeline.js pipCollage): a block whose cur or prev is PIP shows, in place of a
// baked cut, the miniature of the whole frame: the texture f.pip that the renderer has drawn just
// before (the next level in), laid on the block's box by pipUV (collage.js) at f.pipAspect, the
// canvas's aspect. It is pasted, torn, shadowed and edged as any cut; its content has no print look
// (a screen, not a print) and is ringed by a bezel in the black ink outside the miniature. With
// f.pip the layer draws state.collage (its rooms are windows); without it (a frame with no window,
// or the innermost miniature) state.collageBase when there is one (the collage without the
// windows), else state.collage.
import collageVert from '../shaders/collage.vert.glsl?raw';
import collageFrag from '../shaders/collage.frag.glsl?raw';
import { closedRibbon, polyArea } from '../geometry.js';
import { cutUV, acrossOutline, coverAcross, OWN_RIM_MIN, tearMotion, PIP, pipUV } from '../collage.js';

// a block's cur or prev that shows something: a baked cut's position or the miniature (-1: none)
const shows = (cut) => cut >= 0 || cut === PIP;

const PART = { shadowFill: 0, shadowRibbon: 1, edge: 2, content: 3 };
const LAYERS = [0, 1]; // previous cut, current cut
const LEVELS = 6; // depth levels per block: two layers of shadow, edge, content
const SHADOW_ALPHA = 0.4; // how dark a full shadow is (over the ink black)
const EDGE_RGB = [0xfb / 255, 0xf8 / 255, 0xf1 / 255]; // #fbf8f1, the paper's white core
const PRINT_WHITE = 247; // 0..255: white prints as this; black as look.black_lift (15 + v x 232 / 255)
const GRAIN = 1; // print grain strength (collage.frag.glsl printGrain)
const LIFT = [0.04, 2]; // a cut being pasted, at u = 0: 4 % larger, its shadow 1 + 2 times as far
const MOVE = 0.05; // ... and this part of the block's smaller side off its place
// A fragment torn off, by the end of its tear (starting values): pushed this far away from its
// block's centre (stage heights at zoom 1), turned this many degrees; each fragment 0.75..1.25 times
// both (collage.vert.glsl tornOff)
const TEAR_PUSH = 0.04;
const TEAR_TURN = 12;

export function createCollageLayer(ctx) {
  const { THREE, pic } = ctx;
  const manifest = ctx.assets.collage;
  const look = manifest.look;
  const sc = ctx.assets.score.collage;
  const n = sc ? sc.leaves.length : 0;

  // one Map (cut position -> texture) per block row, from the decoded bitmaps
  const textures = (ctx.assets.collageCuts || []).map((cuts) => new Map([...cuts].map(([k, bmp]) => [k, ctx.texture(bmp)])));
  const textureOf = (row, cut) => {
    const t = textures[row] && textures[row].get(cut);
    if (!t) throw new Error(`collage: ${manifest.blocks[row].name} cut ${cut} was not loaded`);
    return t;
  };

  const leafState = ctx.stateTexture(Math.max(n, 1));
  const leafData = new Float32Array(Math.max(n, 1) * 4);
  // per collage leaf row: move, fade of a fragment being torn off (tearMotion; fade 0: it is not),
  // the rim (state.collage.rim) for the block's mesh, and how much the leaf covers the outline it
  // shares with the block's other leaves (coverAcross: their torn edges open there by openAcross)
  const tearState = ctx.stateTexture(Math.max(n, 1));
  const tearData = new Float32Array(Math.max(n, 1) * 4);
  const tearSize = new THREE.Vector2(TEAR_PUSH, TEAR_TURN);
  const look4 = new THREE.Vector4(look.saturation, look.black_lift / 255, PRINT_WHITE / 255, GRAIN);
  const len = new THREE.Vector4(look.torn_edge_px_at_4k[0], look.torn_edge_px_at_4k[1], look.shadow_offset_px_at_4k[0], look.shadow_offset_px_at_4k[1]);
  const black = ctx.inkNamed('black');
  const shadow = new THREE.Vector4(black[0], black[1], black[2], SHADOW_ALPHA);
  const edge = new THREE.Vector3(...EDGE_RGB);
  const lift = new THREE.Vector2(LIFT[0], LIFT[1]);
  const bezel = new THREE.Vector3(black[0], black[1], black[2]); // round a window's miniature

  const toPx = (ring) => ring.map(([x, y]) => [x * pic.w, y * pic.h]);
  const blocks = manifest.blocks.map((b, row) => {
    const rows = [];
    if (sc) sc.leaves.forEach((r, i) => r.block === row && rows.push(i));
    const leaves = rows
      .map((i) => ({ row: i, leaf: ctx.leaf(sc.leaves[i].leaf) }))
      .filter((x) => x.leaf)
      .map((x) => {
        const polys = x.leaf.polys.filter((r) => r.length >= 3).map(toPx);
        const [x0, y0, x1, y1] = x.leaf.bbox;
        return { ...x, polys, box: [x0 * pic.w - 1, y0 * pic.h - 1, x1 * pic.w + 1, y1 * pic.h + 1] };
      });
    let area = 0;
    for (const { leaf } of leaves) area += polyArea(leaf.polys) * pic.w * pic.h;
    // every outline ring as a ribbon (the mitres in picture px, the same unit on both axes), and
    // for each of its points the collage row of the block's leaf across it (-1: none): the torn edge
    // shows only where that leaf is not pasted now
    for (const L of leaves) {
      const others = leaves.filter((o) => o !== L);
      L.rings = L.polys.map((ring) => {
        const rib = closedRibbon(ring);
        const across = acrossOutline(rib, L.polys, others);
        return { rib, nb: Array.from(across, (k) => (k >= 0 ? others[k].row : -1)) };
      });
    }

    const pos = [];
    const out = [];
    const ids = [];
    const cen = [];
    const nbs = [];
    const idx = [];
    let nv = 0;
    const vertex = (x, y, ox, oy, side, nb, i, part, layer, leaf) => {
      pos.push(x, y);
      out.push(ox, oy, side);
      nbs.push(nb);
      ids.push(i, part, layer, leaf.id);
      cen.push(leaf.c[0], leaf.c[1]);
      return nv++;
    };
    const fills = (part, layer) => {
      for (const { row: i, leaf } of leaves) {
        const tris = ctx.leafTris(leaf.id);
        const base = nv;
        const p = tris.position;
        for (let j = 0; j < p.length; j += 2) vertex(p[j], p[j + 1], 0, 0, 0, -1, i, part, layer, leaf);
        for (const t of tris.index) idx.push(base + t);
      }
    };
    const ribbons = (part, layer) => {
      for (const { row: i, leaf, rings } of leaves) {
        for (const { rib, nb } of rings) {
          const base = nv;
          for (let v = 0; v < rib.u.length; v++) {
            const [px, py] = rib.points[v >> 1];
            const s = rib.side[v];
            vertex(px / pic.w, py / pic.h, rib.normal[v * 2] * s, rib.normal[v * 2 + 1] * s, s, nb[v >> 1], i, part, layer, leaf);
          }
          for (const t of rib.index) idx.push(base + t);
        }
      }
    };
    // the triangles of each part of each layer, in the block mesh's draw order
    const segments = {};
    const add = (build, p, layer) => {
      const first = idx.length;
      build(p, layer);
      segments[`${layer}:${p}`] = idx.slice(first);
    };
    for (const layer of LAYERS) {
      add(fills, PART.shadowFill, layer);
      add(ribbons, PART.shadowRibbon, layer);
      add(ribbons, PART.edge, layer);
      add(fills, PART.content, layer);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
    geo.setAttribute('aOut', new THREE.BufferAttribute(new Float32Array(out), 3));
    geo.setAttribute('aId', new THREE.BufferAttribute(new Float32Array(ids), 4));
    geo.setAttribute('aLeafC', new THREE.BufferAttribute(new Float32Array(cen), 2));
    geo.setAttribute('aNb', new THREE.BufferAttribute(new Float32Array(nbs), 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    // the fragments being torn off: the same vertices (the same buffers on the GPU), the current
    // cut only, content first, then the edge, then the shadow; each part's depth is still nearer
    // than the ones drawn after it, so a fading fragment's edge and shadow do not show through it
    const tornGeo = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) tornGeo.setAttribute(name, attr);
    const tornIdx = [PART.content, PART.edge, PART.shadowFill, PART.shadowRibbon].flatMap((p) => segments[`1:${p}`]);
    tornGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(tornIdx), 1));

    // until the first frame sets them, both cuts are the block's first loaded one (warm() draws
    // every mesh once, so its samplers need real textures)
    const first = textures[row] && textures[row].size ? textures[row].values().next().value : null;
    const [bx0, by0, bx1, by1] = b.bbox;
    const uniforms = {
      uLeaves: { value: leafState.texture },
      uTearing: { value: tearState.texture },
      uStateW: { value: leafState.width },
      uTornDraw: { value: 0 },
      uTearSize: { value: tearSize },
      uOwnRimMin: { value: OWN_RIM_MIN },
      uBlock: { value: new THREE.Vector4((bx0 + bx1) / 2, (by0 + by1) / 2, row, 0) },
      uPaste: { value: new THREE.Vector4(1, 0, 0, 1) },
      uCurU: { value: new THREE.Vector3() },
      uCurV: { value: new THREE.Vector3() },
      uPrevU: { value: new THREE.Vector3() },
      uPrevV: { value: new THREE.Vector3() },
      uCur: { value: first },
      uPrev: { value: first },
      uLen: { value: len },
      uLift: { value: lift },
      uMove: { value: MOVE * Math.min((bx1 - bx0) * pic.w, (by1 - by0) * pic.h) },
      uLook: { value: look4 },
      uEdge: { value: edge },
      uShadow: { value: shadow },
      uPip: { value: new THREE.Vector2(0, 0) }, // x: 1 when the current cut is the miniature, y: the same for the previous one
      uPipBezel: { value: bezel },
    };
    const material = (u) => {
      const mat = ctx.material({ vert: collageVert, frag: collageFrag, uniforms: u, blend: 'normal' });
      mat.depthTest = true;
      mat.depthWrite = true;
      mat.depthFunc = THREE.LessDepth;
      return mat;
    };
    const mesh = ctx.mesh(geo, material(uniforms), ctx.ORDER.collage);
    mesh.visible = false;
    // the torn mesh shares every uniform object of the block's mesh (what update() sets reaches
    // both) but uTornDraw
    const torn = ctx.mesh(tornGeo, material({ ...uniforms, uTornDraw: { value: 1 } }), ctx.ORDER.tear);
    torn.visible = false;
    return { row, block: b, rows: leaves.map((x) => x.row), area, mesh, torn, uniforms };
  });

  // largest first: smaller blocks are pasted onto the larger ones
  const rank = blocks.slice().sort((p, q) => q.area - p.area || p.row - q.row);
  const order = rank.slice();
  const setUV = (U, V, m) => {
    U.set(m[0], m[1], m[2]);
    V.set(m[3], m[4], m[5]);
  };
  let uploaded = false;

  return {
    objects: [...blocks.map((b) => b.mesh), ...blocks.map((b) => b.torn)],
    // the block meshes drawn alone are the ground the light lines read (renderer.js); the torn
    // meshes are not part of it (see the top)
    ground: blocks.map((b) => b.mesh),
    update(state, f) {
      const mini = f && f.pip ? f.pip : null; // the next level in (see the top)
      const c = mini ? state.collage : state.collageBase || state.collage;
      if (!c || !n) {
        for (const b of blocks) b.mesh.visible = b.torn.visible = false;
        return;
      }
      // tear > 0: being torn off (0 < tear < 1, a 1: the torn mesh draws it) or gone (tear stays 1,
      // a is 0); the block's mesh draws neither
      for (let i = 0; i < n; i++) {
        const a = c.leaves[i * 4];
        const tear = c.tear[i];
        leafData[i * 4] = tear > 0 ? 0 : a;
        leafData[i * 4 + 1] = c.leaves[i * 4 + 1];
        leafData[i * 4 + 2] = c.leaves[i * 4 + 2];
        leafData[i * 4 + 3] = c.leaves[i * 4 + 3];
        let move = 0;
        let fade = 0;
        if (a > 0 && tear > 0 && tear < 1) [move, fade] = tearMotion(tear);
        tearData[i * 4] = move;
        tearData[i * 4 + 1] = fade;
        tearData[i * 4 + 2] = c.rim[i];
        tearData[i * 4 + 3] = coverAcross(leafData[i * 4], c.rim[i]);
      }
      leafState.set(leafData);
      tearState.set(tearData);
      // draw order: largest first, a block being pasted over its previous cut on top of all
      const pasting = (b) => (shows(c.blocks[b.row * 4 + 1]) ? 1 : 0);
      order.splice(0, order.length, ...rank.filter((b) => !pasting(b)), ...rank.filter(pasting));
      // a cut's texture and its place on the block, a baked cut's or the miniature's
      const texOf = (b, cut) => (cut === PIP ? mini : textureOf(b.row, cut));
      const uvOf = (b, cut) => (cut === PIP ? pipUV(b.block, f.pipAspect, pic.aspect) : cutUV(b.block, b.block.cuts[cut].tilt, c.loose));
      order.forEach((b, j) => {
        const [cur, prev, u, k] = c.blocks.subarray(b.row * 4, b.row * 4 + 4);
        const shown = shows(cur) && b.rows.some((i) => leafData[i * 4] > 0);
        const tearing = shows(cur) && b.rows.some((i) => tearData[i * 4 + 1] > 0);
        b.mesh.visible = shown;
        b.torn.visible = tearing;
        if (!shown && !tearing) return;
        const U = b.uniforms;
        const curTex = texOf(b, cur);
        U.uCur.value = curTex;
        U.uPrev.value = shows(prev) ? texOf(b, prev) : curTex;
        setUV(U.uCurU.value, U.uCurV.value, uvOf(b, cur));
        setUV(U.uPrevU.value, U.uPrevV.value, shows(prev) ? uvOf(b, prev) : cutUV(b.block, 0, 0));
        U.uPaste.value.set(u, k, shows(prev) ? 1 : 0, c.loose);
        U.uPip.value.set(cur === PIP ? 1 : 0, prev === PIP ? 1 : 0);
        U.uBlock.value.w = j * LEVELS;
        b.mesh.renderOrder = ctx.ORDER.collage + j / 100;
        b.torn.renderOrder = ctx.ORDER.tear + j / 100;
      });
    },
    // every cut's texture to the GPU now (with its mipmaps), then the bitmaps are let go
    warm() {
      if (uploaded) return;
      uploaded = true;
      for (const m of textures) {
        for (const t of m.values()) {
          ctx.renderer.initTexture(t);
          if (t.image && typeof t.image.close === 'function') t.image.close();
        }
      }
    },
  };
}

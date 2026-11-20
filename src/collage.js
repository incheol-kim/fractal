// The collage's pure arithmetic (no DOM, no WebGL, importable in Node): where a baked cut's pixels
// lie on the picture, how far a fragment being torn off has gone, which cuts the score uses and
// whether their baked files are theirs, how much GPU memory they take, and the notices for a machine
// that cannot hold or decode them.
//
// A baked cut (tools/make_collage.py --bake) is one picture per cut of a block, (bw + 2m) x
// (bh + 2m) px: the middle bw x bh lies on the block's box at 4K (one file px per 4K px), the margin
// m around it holds the picture beyond the box for the tilt and the fragments' offsets. The file is
// not tilted; the page turns the content by tilt x min(loose, 1) (cutUV).
import { halfHint, halfTexURL, inPolys } from './geometry.js';

// How far across an outline (picture px, along its mitre) acrossOutline looks for the next leaf.
// The leaves tile the picture: one px past an outline lies another leaf at 99.7 % of the points.
export const ACROSS = 1.5;

// Which leaf of the block lies just outside each point of a leaf's outline. rib: closedRibbon of
// one ring of the leaf (picture px); own: the leaf's rings (px); others: the block's other leaves
// [{ polys (px), box: [x0, y0, x1, y1] (px) }]. A point looks ACROSS px along its mitre to both
// sides; the side not in its own leaf is the outside (a hole's inside is outside the leaf).
// -> Int32Array, one per rib point: the index in others of the leaf found there, else -1.
export function acrossOutline(rib, own, others, step = ACROSS) {
  const out = new Int32Array(rib.points.length).fill(-1);
  rib.points.forEach(([x, y], p) => {
    const nx = rib.normal[p * 4] * step;
    const ny = rib.normal[p * 4 + 1] * step;
    for (const [qx, qy] of [[x + nx, y + ny], [x - nx, y - ny]]) {
      if (inPolys(qx, qy, own)) continue;
      const k = others.findIndex((o) => qx >= o.box[0] && qx <= o.box[2] && qy >= o.box[1] && qy <= o.box[3] && inPolys(qx, qy, o.polys));
      if (k >= 0) {
        out[p] = k;
        return;
      }
    }
  });
  return out;
}

// How much a leaf covers the outline it shares with the other leaves of its block (acrossOutline),
// 0..1. a: the opacity at which the block's mesh draws it (0: not drawn, being torn off or gone),
// rim: its state.collage.rim (1, but under a develop or bleed piece falling to 0 as the piece comes
// up). Its rim while it is drawn, 0 once it is not.
export function coverAcross(a, rim) {
  return a <= 0 ? 0 : rim;
}

// openAcross divides by the leaf's own rim no smaller than this. Below it the edge's opacity (that
// rim) hides whatever the division does: the white shown stays under OWN_RIM_MIN.
export const OWN_RIM_MIN = 1e-3;

// How far a fragment's torn edge opens along the part of its outline where another leaf of its block
// lies across it, 0 shut .. 1 open. a, rim: that leaf's (coverAcross); own: the fragment's own rim,
// which is also its edge's opacity (collage.vert.glsl). The white shown there, own x open, is
// max(0, own - cover): the edge shows only as far as the fragment is more there than the leaf across.
// So it is shut while a whole leaf is pasted across; under a develop or bleed piece, whose fragment
// goes when the piece is whole, it opens as that leaf's rim fades (1 - rim for a fragment that is not
// developing), so the white does not open in the one frame the fragment goes; it stays shut between
// two fragments that develop together (the same rim: they were one picture and go as one); open
// where the leaf across is not drawn. collage.vert.glsl computes the same from the cover stored per
// row (layers/collage.js) and the row's own rim.
export function openAcross(a, rim, own = 1) {
  return Math.min(Math.max((own - coverAcross(a, rim)) / Math.max(own, OWN_RIM_MIN), 0), 1);
}

// Picture coordinates (x, y in 0..1, y down) -> the baked cut's texture coordinates (u, v in 0..1,
// v down: row 0 of the file is the top). block: { bbox: [x0, y0, x1, y1], box: [bw, bh], margin }.
// The box's centre goes to the texture's centre, the box to the middle bw x bh px, and the content
// turns by tilt x min(loose, 1) degrees about that centre: a positive tilt turns it counter-clockwise
// on the screen (cv2.getRotationMatrix2D, as on the sheets). The margin holds the picture for a
// tilt of 2 degrees at most (collage_lib.box_and_margin; farther from the block's leaves the file
// is one flat colour, collage_lib.bake_cut), so the breath before the glue chord (loose up to
// GLUE_OPEN, timeline.js) widens the torn edges, shadows and offsets but does not turn the content
// further. -> [a, b, c, d, e, f] with
// u = a x + b y + c, v = d x + e y + f.
export function cutUV(block, tilt, loose) {
  const [x0, y0, x1, y1] = block.bbox;
  const [bw, bh] = block.box;
  const m = block.margin;
  const W = bw + 2 * m;
  const H = bh + 2 * m;
  const sx = bw / (x1 - x0); // texture px per picture unit
  const sy = bh / (y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = (tilt * Math.min(loose, 1) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // a screen offset d from the centre (texture px) shows the cut's point (c dx - s dy, s dx + c dy):
  // the inverse of getRotationMatrix2D's (c dx + s dy, -s dx + c dy)
  const a = (c * sx) / W;
  const b = (-s * sy) / W;
  const d = (s * sx) / H;
  const e = (c * sy) / H;
  return [a, b, 0.5 - a * cx - b * cy, d, e, 0.5 - d * cx - e * cy];
}

// Picture in picture (design 6.2's 4; starting values): while a glass room of
// score.pip is a window, a block's cur or prev (state.collage.blocks) of PIP is not a baked cut but
// the miniature of the whole frame, drawn into a render target earlier in the same frame
// (renderer.js). It sits in the block's box at PIP_FIT of the largest size that fits, centred, with a
// bezel round it (collage.frag.glsl), so that it reads as a screen. The frame is drawn PIP_LEVELS
// times into targets before the canvas, innermost first; the first level has PIP_SS texels per
// canvas px of the central room's miniature (PIP_ROOM, the largest window), each next level is that
// part of the one before.
export const PIP = -2;
export const PIP_FIT = 0.93;
export const PIP_LEVELS = 3;
export const PIP_SS = 1.25;
export const PIP_ROOM = 'glass_room'; // the block whose window sets the targets' sizes (pipSizes)

// The height of a screen of aspect (width / height) fitted into a box bw x bh (any one unit), times fit.
export function pipHeight(bw, bh, aspect, fit = PIP_FIT) {
  return Math.min(bh, bw / aspect) * fit;
}

// Picture coordinates (x, y in 0..1, y down) -> the miniature's texture coordinates (a render
// target: row 0 at the bottom, so v up), the screen of aspect (its width / height) laid on the
// block's box by pipHeight, centred: the box's centre goes to (0.5, 0.5). A: the picture's aspect
// (width / height). Outside 0..1 is the bezel. -> [a, b, c, d, e, f] as cutUV.
export function pipUV(block, aspect, A, fit = PIP_FIT) {
  const [x0, y0, x1, y1] = block.bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const H = pipHeight((x1 - x0) * A, y1 - y0, aspect, fit); // picture heights
  const a = A / (H * aspect);
  const e = -1 / H;
  return [a, 0, 0.5 - a * cx, 0, e, 0.5 - e * cy];
}

// The miniatures' render targets for a canvas w x h, outermost first -> [[w, h], ...] (levels of
// them). bbox: the PIP_ROOM block's box (picture 0..1); pic: { w, h } the picture's size in px. The
// picture covers the canvas (renderer.js), k canvas px per picture px at zoom 1; r is the room's
// miniature's height in canvas heights times ss; level i is r^(i + 1) of the canvas high (at least
// 8 px), as wide as the canvas's aspect makes it (at least 8 px).
export function pipSizes(w, h, bbox, pic, levels = PIP_LEVELS, ss = PIP_SS) {
  const s = w / h;
  const k = (Math.max(s / (pic.w / pic.h), 1) * h) / pic.h;
  const [x0, y0, x1, y1] = bbox;
  const r = (pipHeight((x1 - x0) * pic.w * k, (y1 - y0) * pic.h * k, s) / h) * ss;
  return Array.from({ length: levels }, (_, i) => {
    const lh = Math.max(8, Math.round(h * r ** (i + 1)));
    return [Math.max(8, Math.round(lh * s)), lh];
  });
}

// GPU memory of the miniatures' targets (pipSizes), bytes: per level w x h x (16 + 16 + 16 / 3 + 8),
// the 4x MSAA colour and depth (4 + 4 bytes a sample), the resolved colour with its mipmaps, and the
// level's ground target's colour and depth.
export function pipBytes(sizes) {
  let s = 0;
  for (const [w, h] of sizes) s += w * h * (16 + 16 + 16 / 3 + 8);
  return s;
}

// A fragment being torn off fades over the last part of its tear from here (starting value).
export const TEAR_FADE = 2 / 3;

// How far a fragment being torn off has gone at tear (state.collage.tear, 0..1) -> [move, fade]:
// move 0..1 how much of its push and turn it has made (layers/collage.js, collage.vert.glsl: each
// fragment's own push and turn come from a hash of its leaf number), fast at first and slowing
// (knocked off by the photo landing under it, already clear of its place after one frame); fade
// its opacity, 1 until TEAR_FADE, then falling evenly to 0 at tear 1.
export function tearMotion(tear) {
  const u = Math.min(Math.max(tear, 0), 1);
  const move = 1 - (1 - u) * (1 - u);
  const fade = Math.min((1 - u) / (1 - TEAR_FADE), 1);
  return [move, fade];
}

// The cuts the score uses in any of its strengths (each start and every change's `to`): the baked
// files the page loads. collage: assets/collage.json; scoreCollage: score.collage (or null).
// -> [{ row, cut, file, box, margin, key }] by block row, then cut position (key: the cut's bake key,
// see staleCuts).
export function usedCuts(collage, scoreCollage) {
  if (!scoreCollage) return [];
  const sets = collage.blocks.map(() => new Set());
  for (const ch of Object.values(scoreCollage.changes)) {
    ch.start.forEach((k, row) => sets[row].add(k));
    for (const e of ch.events) sets[e.block].add(e.to);
  }
  const out = [];
  sets.forEach((set, row) => {
    const b = collage.blocks[row];
    for (const cut of [...set].sort((p, q) => p - q)) out.push({ row, cut, file: b.cuts[cut].file, box: b.box, margin: b.margin, key: b.cuts[cut].key });
  });
  return out;
}

// The cuts of list (usedCuts) whose baked file is not theirs. A baked file's name holds only its block
// row and cut position, so after other picks the same name can hold another cut's picture, of the same
// size; tools/make_collage.py --bake records in assets/collage/baked.json what each file was made from
// (file name -> bake key), and the list carries each cut's key. baked: that file's object.
// -> [{ cut, why }]: no key recorded for the file ('not baked (no key in baked.json)') or another one
// ('baked from another cut'); a cut without a key is never current.
export function staleCuts(list, baked) {
  const rec = baked && typeof baked === 'object' && !Array.isArray(baked) ? baked : {};
  const out = [];
  for (const c of list) {
    const name = c.file.slice(c.file.lastIndexOf('/') + 1);
    const have = Object.hasOwn(rec, name) ? rec[name] : undefined;
    if (have === undefined) out.push({ cut: c, why: 'not baked (no key in baked.json)' });
    else if (typeof c.key !== 'string' || have !== c.key) out.push({ cut: c, why: 'baked from another cut' });
  }
  return out;
}

// Half of a side in px, rounded half up, at least 1: the size of a cut at half size, whether the browser
// decodes the original at half size (?tex=half) or the web set's piece is that size already
// (tools/make_collage_web.py half() rounds the same way).
export function halfPx(n) {
  return Math.max(1, Math.round(n / 2));
}

// The texture a cut ({ box: [bw, bh], margin }) is loaded as. The original (set 'full') is (bw + 2m) x
// (bh + 2m) px, decoded as it is or, with tex 'half', straight to half of that (halfPx of each side). A
// web piece (set 'web') is taken as it is, at the size its scale in web.json gives it (collage_set.js
// webScale): 1, the original's size, or 0.5, half of it; tex leaves it so. -> { w, h, decode: 'as is' |
// 'half' }: the bitmap is w x h, and one decoded as it is that is not is refused (assets.js getCut).
export function cutTexture(c, { set = 'full', tex = 'full', scale = 0.5 } = {}) {
  const w = c.box[0] + 2 * c.margin;
  const h = c.box[1] + 2 * c.margin;
  if (set === 'web') {
    if (scale !== 1 && scale !== 0.5) throw new Error(`cutTexture: a web piece is at scale 1 or 0.5, not ${JSON.stringify(scale)}`);
    return scale === 1 ? { w, h, decode: 'as is' } : { w: halfPx(w), h: halfPx(h), decode: 'as is' };
  }
  return tex === 'half' ? { w: halfPx(w), h: halfPx(h), decode: 'half' } : { w, h, decode: 'as is' };
}

// GPU memory of the cuts loaded ([{ box: [bw, bh], margin }], one entry per cut): RGBA 8-bit with
// mipmaps, w x h x 4 x 4/3 each, the texture's size: (bw + 2m) x (bh + 2m), or with size 'half' (the
// original decoded at half size, or a web piece at scale 0.5) each side's halfPx. size: 'full' or 'half'
// for every cut, or a function of the cut that says which (the web set has both).
export function collageBytes(cuts, size = 'full') {
  let s = 0;
  for (const c of cuts) {
    const w = c.box[0] + 2 * c.margin;
    const h = c.box[1] + 2 * c.margin;
    const half = (typeof size === 'function' ? size(c) : size) === 'half';
    s += (half ? halfPx(w) * halfPx(h) : w * h) * 4 * (4 / 3);
  }
  return s;
}

// bytes -> '1.4 GB' (bytes / 2^30, one decimal)
export function gigabytes(bytes) {
  return `${(bytes / 2 ** 30).toFixed(1)} GB`;
}

// What the collage's memory notices offer, by the set of pieces (set: 'full', 'web', or null before it is
// known). ?tex=half decodes the original pieces at half size, with the other big pictures (geometry.js
// halfHint: its link, '' once the page is on tex=half). The web set's pieces are lighter already (half
// size but for the punch-in's few) and ?tex=half leaves them so (assets.js getCut): with that set the
// notice says so (pieces) and offers
// ?tex=half for the other big pictures only (hint; use: the advice before it in the lost-context notice;
// done: what is said when the page is on tex=half already). With the originals the words are those of
// before the web set.
function halfAdvice(href, set) {
  const hint = halfHint(href);
  if (set !== 'web') return { pieces: '', hint, use: 'use the half-size pictures', done: ' The page already uses the half-size pictures.' };
  let link = null;
  try {
    link = hint && href ? halfTexURL(href) : null;
  } catch {
    link = null;
  }
  const offer = link
    ? `Open the other large pictures (the key image and the rest) at half size: ${link}`
    : 'Add tex=half to the address to use the other large pictures (the key image and the rest) at half size (for example ?tex=half).';
  return {
    pieces: ' The collage pieces are already the lighter web set, half size for most of the piece.',
    hint: hint ? offer : '',
    use: 'use the other large pictures at half size',
    done: ' The other large pictures are already at half size too.',
  };
}

const gpuLabel = (gpuName) => String(gpuName || '').trim() || 'unknown';

// The message for a GPU that ran out of memory holding the collage (an OUT_OF_MEMORY error or a lost
// context after the page got ready): the size, the GPU and, unless the page (href) is already on
// tex=half, a link to the half-size pictures (with the web set: to the other big pictures at half size,
// the pieces being lighter already; halfAdvice).
export function memoryNotice(bytes, gpuName, href, set = null) {
  const a = halfAdvice(href, set);
  return (
    `Out of graphics memory: not all of the collage’s pictures (about ${gigabytes(bytes)}) could be loaded (GPU: ${gpuLabel(gpuName)}). ` +
    'The picture may have gaps or go black.' +
    a.pieces +
    (a.hint ? `\n${a.hint}` : `${a.done} Close other programs and reload the page.`)
  );
}

// The message for a lost context while the collage's cuts are on the GPU: memory may be the cause, but
// a sleep or a driver reset loses it too, so it says "may". The size, the GPU and, unless the page
// (href) is already on tex=half, a link to the half-size pictures (halfAdvice, by the set).
export function lostCollageNotice(bytes, gpuName, href, set = null) {
  const a = halfAdvice(href, set);
  return (
    `The graphics device lost this page’s picture (WebGL context lost, GPU: ${gpuLabel(gpuName)}). ` +
    `The collage’s pictures (about ${gigabytes(bytes)} of graphics memory) may have used up the memory; sleep or a graphics driver restart also does this. ` +
    'Please reload the page.' +
    a.pieces +
    (a.hint ? ` If memory ran short, ${a.use}.\n${a.hint}` : `${a.done} Close other programs and reload.`)
  );
}

// The message for a cut the browser could not decode (createImageBitmap refused it): on a machine short
// of memory this is the likely first failure (every cut is decoded before anything is drawn), so it
// gives the collage's size and, unless on tex=half already, the half-size link (halfAdvice, by the set);
// a damaged file is the other cause. file: the cut's file under assets/; why: the browser's words.
export function decodeNotice(file, why, bytes, href, set = null) {
  const a = halfAdvice(href, set);
  return (
    `Could not decode a collage piece: assets/${file} (${why}).\n` +
    `This can happen when memory runs short: the collage’s pictures take about ${gigabytes(bytes)} of graphics memory. The file may also be damaged.` +
    a.pieces +
    (a.hint ? `\n${a.hint}` : `${a.done} Close other programs and reload the page.`)
  );
}

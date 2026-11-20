// Do the page's assets fit together? One pure function (no DOM, no WebGL, importable in Node):
// assetProblems({ regions, strokes, palette, score, music, collage, life }) -> a list of problems
// (strings), empty when the page can draw from them. assets.js refuses to load with problems, and
// test/consistency.test.js runs it on the committed assets.
//
// What it catches: a regions.json without the fingerprint of its region map, strokes, a score, a
// collage or a life map made from another region map (their "regions" is not that fingerprint: a
// tool after tools/make_regions.py was not run again), a life map that is missing, lacks one of
// its three channels or names a leaf that is not there (tools/make_life.py), a leaf without its
// ink or tone (tools/make_regions.py run without tools/make_flat.py after it), an ink index
// outside the palette, a score event
// naming a stroke or a leaf that is not there, a stroke on a missing leaf or with too few points,
// pieces that are not exactly the leaves (one each), the shapes the layers read from the
// palette, score and music, in the collage (tools/make_collage.py) a block naming a leaf that is
// not there, an accent that is not one of the block's picked cuts, a bbox that is not four numbers,
// a box or margin that is not positive, and a cut without a file name, a numeric tilt or its bake
// key, and in the score's collage blocks that are not the collage's, a leaf row that is not there,
// twice or in the wrong block, a change to a cut the block does not have, an accent block that does
// not end on its accent, a default that is not a strength and a flat without its until, and a
// picture-in-picture window (score.pip, when there is one) in a block that collage.json does not
// have, with another accent than its block's, or without a numeric t, and windows without
// collage.json's block PIP_ROOM (the miniatures are sized by its box).
import { PIP_ROOM } from './collage.js';

// Each kind of problem is listed MAX_EACH times at most, then counted.
const MAX_EACH = 5;
const STYLES = new Set(['slam', 'fold', 'slide', 'develop', 'bleed']);
const SECTIONS = ['A', 'B', 'C', 'coda', 'tail'];
const HEX = /^#[0-9a-f]{6}$/i;
const FINGERPRINT = /^[0-9a-f]{16}$/; // tools/regions_lib.py fingerprint
const BAKE_KEY = /^[0-9a-f]{40}$/; // tools/make_collage.py bake_key (sha1)
const LIFE_CHANNELS = ['flow', 'tremble', 'breath']; // assets/life.png's R, G, B (tools/make_life.py)

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v);
const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(num);

export function assetProblems({ regions, strokes, palette, score, music, collage, life } = {}) {
  const out = [];
  const counts = new Map();
  // one problem of a kind; past MAX_EACH of that kind only counted
  const add = (kind, msg) => {
    const k = (counts.get(kind) || 0) + 1;
    counts.set(kind, k);
    if (k <= MAX_EACH) out.push(msg);
  };

  // ---- palette
  const inks = palette && Array.isArray(palette.inks) ? palette.inks : null;
  if (!palette || typeof palette.paper !== 'string' || !HEX.test(palette.paper)) add('palette', `palette: paper is not a colour '#rrggbb' (${palette ? JSON.stringify(palette.paper) : 'no palette'})`);
  if (!inks || !inks.length) add('palette', 'palette: no inks');
  else inks.forEach((ink, i) => {
    if (!ink || typeof ink.hex !== 'string' || !HEX.test(ink.hex)) add('palette ink', `palette: ink ${i} is not a colour '#rrggbb' (${JSON.stringify(ink && ink.hex)})`);
  });
  const nInks = inks ? inks.length : 0;

  // ---- regions: leaves with ids, ink in the palette, numeric tone
  const leafIds = new Set();
  if (!regions || !num(regions.w) || !num(regions.h) || !Array.isArray(regions.leaves) || !regions.leaves.length) {
    add('regions', 'regions: expected { w, h, leaves: [...] }');
  } else {
    for (const leaf of regions.leaves) {
      const id = leaf && leaf.id;
      if (!int(id) || id < 1) {
        add('leaf id', `regions: a leaf without a whole-number id (${JSON.stringify(id)})`);
        continue;
      }
      if (leafIds.has(id)) add('leaf id twice', `regions: leaf ${id} is listed twice`);
      leafIds.add(id);
      if (!int(leaf.ink) || leaf.ink < 0 || leaf.ink >= nInks) {
        add('leaf ink', `regions: leaf ${id} has ink ${JSON.stringify(leaf.ink)}, not a palette index 0..${nInks - 1} (run tools/make_flat.py after tools/make_regions.py)`);
      }
      if (!num(leaf.tone)) add('leaf tone', `regions: leaf ${id} has tone ${JSON.stringify(leaf.tone)}, not a number (run tools/make_flat.py after tools/make_regions.py)`);
      if (!Array.isArray(leaf.polys) || !leaf.polys.length) add('leaf polys', `regions: leaf ${id} has no outline (polys)`);
      if (!nums(leaf.c, 2) || !nums(leaf.bbox, 4)) add('leaf box', `regions: leaf ${id} has no centre (c) or box (bbox)`);
    }
  }
  const isLeaf = (id) => leafIds.has(id);

  // ---- the region map: regions.json carries the fingerprint of the map it was made with,
  // strokes.json and score.json the one of the map they were made from (as "regions")
  const fp = regions ? regions.fingerprint : undefined;
  const shown = (v) => (v === undefined ? 'none' : JSON.stringify(v));
  if (regions && !(typeof fp === 'string' && FINGERPRINT.test(fp))) {
    add('fingerprint', `regions: no fingerprint of the region map (fingerprint ${shown(fp)}; run tools/make_regions.py, then tools/make_flat.py)`);
  } else if (regions) {
    if (strokes && strokes.regions !== fp) add('fingerprint', `strokes: made from another region map (regions ${shown(strokes.regions)}, regions.json has ${fp}; run tools/make_strokes.py, then tools/make_score.py)`);
    if (score && score.regions !== fp) add('fingerprint', `score: made from another region map (regions ${shown(score.regions)}, regions.json has ${fp}; run tools/make_score.py)`);
    if (collage && collage.regions !== fp) add('fingerprint', `collage: made from another region map (regions ${shown(collage.regions)}, regions.json has ${fp}; run tools/pick_collage.py, then tools/make_collage.py)`);
    if (life && life.regions !== fp) add('fingerprint', `life: made from another region map (regions ${shown(life.regions)}, regions.json has ${fp}; run tools/make_life.py)`);
  }

  // ---- the life map (tools/make_life.py): which leaves flow, tremble and breathe; the picture
  // (assets/life.png) is read by assets.js, so only the description is looked at here
  if (!life) {
    add('life', 'life: missing (run tools/make_life.py)');
  } else {
    for (const name of LIFE_CHANNELS) {
      const ch = life.channels && life.channels[name];
      if (!ch || !Array.isArray(ch.leaves)) {
        add('life channel', `life: no channel ${name} with its leaves (run tools/make_life.py)`);
        continue;
      }
      for (const id of ch.leaves) if (!isLeaf(id)) add('life leaf', `life: channel ${name} names leaf ${JSON.stringify(id)}, which is not in regions (run tools/make_life.py)`);
    }
  }

  // ---- strokes: ids, points, the leaves they belong to (wires belong to none: leaf -1)
  const strokeById = new Map();
  if (!strokes || !Array.isArray(strokes.strokes)) {
    add('strokes', 'strokes: expected { strokes: [...] }');
  } else {
    for (const s of strokes.strokes) {
      const id = s && s.id;
      if (!int(id)) {
        add('stroke id', `strokes: a stroke without a whole-number id (${JSON.stringify(id)})`);
        continue;
      }
      if (strokeById.has(id)) add('stroke id twice', `strokes: stroke ${id} is listed twice`);
      strokeById.set(id, s);
      const wire = typeof s.kind === 'string' && s.kind.startsWith('wire');
      if (!Array.isArray(s.pts) || s.pts.length < 2 || !s.pts.every((p) => nums(p, 2))) {
        add('stroke pts', `strokes: stroke ${id} has fewer than two points or a point that is not [x, y]`);
      }
      if (!(wire ? s.leaf === -1 : isLeaf(s.leaf))) add('stroke leaf', `strokes: stroke ${id} (${s.kind}) is on leaf ${JSON.stringify(s.leaf)}, which is not in regions${wire ? ' (a wire has leaf -1)' : ''}`);
      if (s.leaf2 !== undefined && !isLeaf(s.leaf2)) add('stroke leaf', `strokes: stroke ${id} has leaf2 ${JSON.stringify(s.leaf2)}, which is not in regions`);
      if (!num(s.w)) add('stroke w', `strokes: stroke ${id} has no width (w)`);
    }
  }

  // ---- score: what each event names exists; the pieces are the leaves, one each
  if (!score) {
    add('score', 'score: missing');
  } else {
    if (!num(score.glue) || !num(score.end)) add('score', 'score: glue and end must be numbers');
    if (score.shake !== undefined && !(score.shake && num(score.shake.from) && num(score.shake.to) && score.shake.from < score.shake.to)) {
      add('score', 'score: shake must be { from, to } with from < to (data/cues.json shake, then tools/make_score.py)');
    }
    if (!Array.isArray(score.camera) || !score.camera.length || !score.camera.every((c) => c && num(c.t) && num(c.zoom) && nums(c.c, 2))) {
      add('score', 'score: camera must be a non-empty list of { t, zoom, c: [x, y] }');
    }
    for (const k of ['strokes', 'flats', 'pieces', 'washes']) if (!Array.isArray(score[k])) add('score', `score: ${k} must be a list`);
    (Array.isArray(score.strokes) ? score.strokes : []).forEach((ev, i) => {
      const s = strokeById.get(ev && ev.s);
      if (!s) {
        add('score stroke', `score: stroke event ${i} names stroke ${JSON.stringify(ev && ev.s)}, which is not in strokes`);
        return;
      }
      if (!num(ev.t) || !num(ev.d) || !num(ev.w) || !num(ev.ink)) add('score stroke', `score: stroke event ${i} (stroke ${ev.s}) needs numbers t, d, w, ink`);
      const wire = typeof s.kind === 'string' && s.kind.startsWith('wire');
      if (Boolean(ev.photo) !== wire) add('score stroke photo', `score: stroke event ${i} has photo ${ev.photo} but stroke ${ev.s} is ${s.kind}`);
    });
    (Array.isArray(score.flats) ? score.flats : []).forEach((ev, i) => {
      if (!isLeaf(ev && ev.leaf)) add('score flat', `score: flat event ${i} names leaf ${JSON.stringify(ev && ev.leaf)}, which is not in regions`);
      else if (!num(ev.t)) add('score flat', `score: flat event ${i} (leaf ${ev.leaf}) has no time`);
    });
    const pieceOf = new Map();
    (Array.isArray(score.pieces) ? score.pieces : []).forEach((ev, i) => {
      const leaf = ev && ev.leaf;
      if (!isLeaf(leaf)) {
        add('score piece', `score: piece ${i} names leaf ${JSON.stringify(leaf)}, which is not in regions`);
        return;
      }
      if (pieceOf.has(leaf)) add('score piece twice', `score: pieces ${pieceOf.get(leaf)} and ${i} are both leaf ${leaf}`);
      else pieceOf.set(leaf, i);
      if (!STYLES.has(ev.style)) add('score piece style', `score: piece ${i} (leaf ${leaf}) has style ${JSON.stringify(ev.style)}, not one of ${[...STYLES].join(', ')}`);
      if (!num(ev.t) || !num(ev.d) || !num(ev.size) || !nums(ev.from, 4)) add('score piece', `score: piece ${i} (leaf ${leaf}) needs numbers t, d, size and from: [dx, dy, rot, s]`);
    });
    if (Array.isArray(score.pieces)) {
      for (const id of leafIds) if (!pieceOf.has(id)) add('leaf without piece', `score: leaf ${id} has no piece (every leaf needs exactly one)`);
    }
    (Array.isArray(score.washes) ? score.washes : []).forEach((w, i) => {
      if (!w || !num(w.t) || !num(w.d) || !num(w.gain) || !Array.isArray(w.leaves) || !w.leaves.length) {
        add('score wash', `score: wash ${i} needs numbers t, d, gain and a list of leaves`);
        return;
      }
      for (const id of w.leaves) if (!isLeaf(id)) add('score wash leaf', `score: wash ${i} names leaf ${JSON.stringify(id)}, which is not in regions`);
    });
    // the picture in picture (tools/make_score.py from data/cues.json pip), when there is one: each
    // window is a block row of collage.json with that block's accent, at a time
    const pip = score.pip;
    if (pip !== undefined) {
      const fix = 'data/cues.json pip, then tools/make_score.py';
      const blocks = collage && Array.isArray(collage.blocks) ? collage.blocks : [];
      if (!Array.isArray(pip)) add('score pip', `score: pip is ${JSON.stringify(pip)}, not a list of windows (${fix})`);
      // the miniatures are sized by the box of the block PIP_ROOM (renderer.js): without it no window is drawn
      if (Array.isArray(pip) && pip.length && !blocks.some((b) => b && b.name === PIP_ROOM)) {
        add('score pip', `score: pip has ${pip.length} windows, but collage.json has no block ${PIP_ROOM}, whose box sizes the miniatures (src/collage.js PIP_ROOM; without it no window is drawn)`);
      }
      (Array.isArray(pip) ? pip : []).forEach((w, i) => {
        const b = w && w.block;
        if (!int(b) || b < 0 || b >= blocks.length) {
          add('score pip', `score: pip window ${i} is in block ${JSON.stringify(b)}, not a block row of collage.json (${fix})`);
        } else if (!blocks[b] || w.accent !== blocks[b].accent) {
          add('score pip', `score: pip window ${i} (${blocks[b] && blocks[b].name}) has accent ${JSON.stringify(w.accent)}, collage.json's is ${JSON.stringify(blocks[b] && blocks[b].accent)} (${fix})`);
        }
        if (!w || !num(w.t)) add('score pip', `score: pip window ${i} has t ${JSON.stringify(w && w.t)}, not a number (${fix})`);
      });
    }
  }

  // ---- music: what src/music.js reads
  if (!music || !music.sections) {
    add('music', 'music: no sections');
  } else {
    for (const name of SECTIONS) if (!nums(music.sections[name], 2)) add('music', `music: section ${name} must be [start, end]`);
  }
  if (!music || !Array.isArray(music.env) || !music.env.length || !music.env.every(num)) add('music', 'music: env must be a non-empty list of numbers');

  // ---- collage: the blocks are made of leaves; each cut is a baked picture file (its box at 4K
  // plus a margin on every side) and a tilt. Whether the files exist is not looked at here
  // (tools/make_collage.py --check does that); src, rect and shift only record how a cut was made.
  const pos = (v) => num(v) && v > 0;
  if (!collage) {
    add('collage', 'collage: missing (run tools/make_collage.py)');
  } else if (!Array.isArray(collage.blocks) || !collage.blocks.length) {
    add('collage', 'collage: expected { blocks: [...] } (run tools/make_collage.py)');
  } else {
    collage.blocks.forEach((b, bi) => {
      const name = b && typeof b.name === 'string' ? b.name : `block ${bi}`;
      if (!b || !Array.isArray(b.leaves) || !b.leaves.length || !Array.isArray(b.cuts) || !int(b.n) || b.n < 1 || b.cuts.length < b.n) {
        add('collage block', `collage: ${name} needs leaves, a whole number n >= 1 and at least n cuts`);
        return;
      }
      for (const id of b.leaves) if (!isLeaf(id)) add('collage leaf', `collage: ${name} names leaf ${JSON.stringify(id)}, which is not in regions`);
      if (!int(b.accent) || b.accent < -1 || b.accent >= b.n) add('collage accent', `collage: ${name} has accent ${JSON.stringify(b.accent)}, not -1 or one of its ${b.n} picked cuts`);
      if (!nums(b.bbox, 4) || !(b.bbox[0] < b.bbox[2] && b.bbox[1] < b.bbox[3])) add('collage bbox', `collage: ${name} has bbox ${JSON.stringify(b.bbox)}, not four numbers [x0, y0, x1, y1] with x0 < x1 and y0 < y1`);
      if (!Array.isArray(b.box) || b.box.length !== 2 || !b.box.every(pos)) add('collage box', `collage: ${name} has box ${JSON.stringify(b.box)}, not two positive numbers [bw, bh]`);
      if (!pos(b.margin)) add('collage margin', `collage: ${name} has margin ${JSON.stringify(b.margin)}, not a positive number`);
      b.cuts.forEach((c, k) => {
        if (!c || typeof c.file !== 'string' || !c.file) add('collage cut file', `collage: ${name} cut ${k} has file ${JSON.stringify(c && c.file)}, not a file name`);
        if (c && !num(c.tilt)) add('collage cut tilt', `collage: ${name} cut ${k} has tilt ${JSON.stringify(c.tilt)}, not a number`);
        if (c && !(typeof c.key === 'string' && BAKE_KEY.test(c.key))) add('collage cut key', `collage: ${name} cut ${k} has key ${JSON.stringify(c.key)}, not its bake key (run tools/make_collage.py)`);
      });
    });
  }

  // ---- the score's collage (tools/make_score.py reads collage.json): the same blocks in the same
  // order, one row per leaf of the blocks (in its own block), every strength's start and changes on
  // cuts the block has, a default that is one of the strengths, and on every flat the time the
  // collage covers it (until)
  const sc = score && score.collage;
  if (sc) {
    const blocks = collage && Array.isArray(collage.blocks) ? collage.blocks : [];
    const rows = Array.isArray(sc.blocks) ? sc.blocks : [];
    const nameOf = (b) => (b && typeof b.name === 'string' ? b.name : JSON.stringify(b && b.name));
    const cutsOf = (b) => (blocks[b] && Array.isArray(blocks[b].cuts) ? blocks[b].cuts.length : 0);
    let bad = -1;    // the first row where the two lists part
    for (let i = 0; i < Math.max(rows.length, blocks.length) && bad < 0; i++) {
      if (!rows[i] || !blocks[i] || rows[i].name !== blocks[i].name) bad = i;
    }
    if (bad >= 0) {
      add('score collage blocks', `score: the collage blocks are not collage.json's (${rows.length} and ${blocks.length} blocks; row ${bad} is ${nameOf(rows[bad])}, collage.json has ${nameOf(blocks[bad])}); run tools/make_score.py`);
    }
    const rowOf = new Map();
    (Array.isArray(sc.leaves) ? sc.leaves : []).forEach((r, i) => {
      const id = r && r.leaf;
      if (!isLeaf(id)) {
        add('score collage leaf', `score: collage leaf row ${i} names leaf ${JSON.stringify(id)}, which is not in regions`);
        return;
      }
      if (rowOf.has(id)) add('score collage leaf twice', `score: collage leaf ${id} has two rows (${rowOf.get(id)} and ${i})`);
      else rowOf.set(id, i);
      if (!int(r.block) || r.block < 0 || r.block >= blocks.length) add('score collage leaf block', `score: collage leaf ${id} is in block ${JSON.stringify(r.block)}, not a block row of collage.json`);
      else if (!(Array.isArray(blocks[r.block].leaves) && blocks[r.block].leaves.includes(id))) add('score collage leaf block', `score: collage leaf ${id} is in block ${r.block} (${nameOf(blocks[r.block])}), which does not have it; run tools/make_score.py`);
    });
    for (const b of blocks) {
      for (const id of (b && Array.isArray(b.leaves) ? b.leaves : [])) if (!rowOf.has(id)) add('score collage leaf missing', `score: collage leaf ${id} of ${nameOf(b)} has no row; run tools/make_score.py`);
    }
    const changes = sc.changes && typeof sc.changes === 'object' ? sc.changes : {};
    if (!Object.keys(changes).length) add('score collage changes', 'score: the collage has no changes (a start and events per strength); run tools/make_score.py');
    else if (!Object.hasOwn(changes, sc.default)) add('score collage default', `score: the collage default ${JSON.stringify(sc.default)} is not one of its strengths (${Object.keys(changes).join(', ')})`);
    for (const [k, ch] of Object.entries(changes)) {
      const start = ch && Array.isArray(ch.start) ? ch.start : null;
      if (!start || start.length !== blocks.length) add('score collage start', `score: collage ${k} start must name one cut per block of collage.json (${blocks.length})`);
      else start.forEach((c, b) => {
        if (!int(c) || c < 0 || c >= cutsOf(b)) add('score collage start', `score: collage ${k} start of ${nameOf(blocks[b])} is cut ${JSON.stringify(c)}, not one of its ${cutsOf(b)} cuts`);
      });
      if (!ch || !Array.isArray(ch.events)) {
        add('score collage events', `score: collage ${k} events must be a list`);
        continue;
      }
      ch.events.forEach((e, i) => {
        const b = e && e.block;
        if (!int(b) || b < 0 || b >= blocks.length) add('score collage event', `score: collage ${k} change ${i} is in block ${JSON.stringify(b)}, not a block row of collage.json`);
        else if (!int(e.to) || e.to < 0 || e.to >= cutsOf(b)) add('score collage event', `score: collage ${k} change ${i} turns ${nameOf(blocks[b])} to cut ${JSON.stringify(e.to)}, not one of its ${cutsOf(b)} cuts`);
      });
      // a block with an accent ends on it in every strength (tools/make_score.py: the accent is the
      // block's last change, or its start when it has none); another last cut is a score made before
      // the picks changed
      if (start && start.length === blocks.length) {
        const last = start.slice();
        const at = start.map(() => -Infinity);
        for (const e of ch.events) {
          if (e && int(e.block) && e.block >= 0 && e.block < blocks.length && num(e.t) && e.t >= at[e.block]) {
            at[e.block] = e.t;
            last[e.block] = e.to;
          }
        }
        blocks.forEach((b, row) => {
          if (b && int(b.accent) && b.accent >= 0 && last[row] !== b.accent) {
            add('score collage accent', `score: collage ${k} ends ${nameOf(b)} on cut ${JSON.stringify(last[row])}, not on its accent (cut ${b.accent}); run tools/make_score.py`);
          }
        });
      }
    }
    (Array.isArray(score.flats) ? score.flats : []).forEach((ev, i) => {
      if (ev && !num(ev.until)) add('score flat until', `score: flat event ${i} (leaf ${ev.leaf}) has until ${JSON.stringify(ev.until)}, not a number (when the collage covers it)`);
    });
  }

  for (const [kind, k] of counts) if (k > MAX_EACH) out.push(`... and ${k - MAX_EACH} more like the above (${kind})`);
  return out;
}

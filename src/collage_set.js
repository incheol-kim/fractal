// The collage's pieces come in two sets (pure: no DOM, no fetch). 'full': the baked originals,
// assets/collage/b<row>_<k>.webp (lossless, sized for the 4K video; tools/make_collage.py --bake), kept
// in the private repository only. 'web': the same pieces as JPEG, assets/collage-web/b<row>_<k>.jpg
// (tools/make_collage_web.py), in both repositories: half size, but for the pieces drawn while the camera
// is pushed in after the strike, which keep the original's size (webScale). Which sets a tree
// has, assets/pieces.json says ({ "sets": ["full", "web"] }; the public tree: ["web"]), so the page
// never fetches a list to see whether it is there. The page chooses one set when it loads (assets.js).

const SETS = ['full', 'web']; // in the order chosen when the address names none
const FOLDER = { full: 'collage', web: 'collage-web' };

// An error of the choice, marked so (e.pieces) for main.js's notice.
function refusal(message) {
  const e = new Error(message);
  e.pieces = true;
  return e;
}

// query: ?pieces= (null when the address has none); sets: assets/pieces.json's "sets".
// -> 'full' | 'web': the set the address names, which the tree must have (else an error saying which
// folder it does not have, never the other set instead); without one the originals when the tree has
// them, else the web set. Throws (e.pieces true) for an unknown name and a broken pieces.json.
export function chooseCollageSet({ query = null, sets } = {}) {
  if (!Array.isArray(sets) || sets.some((s) => typeof s !== 'string')) {
    throw refusal(`assets/pieces.json: "sets" is not a list of set names (${JSON.stringify(sets)})`);
  }
  const unknown = sets.filter((s) => !SETS.includes(s));
  if (unknown.length) throw refusal(`assets/pieces.json names a set there is none of: ${unknown.join(', ')} (the sets are ${SETS.join(' and ')})`);
  if (query !== null) {
    if (!SETS.includes(query)) throw refusal(`?pieces=${query}: not a set of collage pieces (${SETS.join(' or ')})`);
    if (!sets.includes(query)) {
      throw refusal(
        `?pieces=${query}: this copy has no ${query} set of collage pieces (assets/${FOLDER[query]}/); ` +
          `assets/pieces.json has ${sets.length ? sets.join(', ') : 'none'}`,
      );
    }
    return query;
  }
  const set = SETS.find((s) => sets.includes(s));
  if (!set) throw refusal('no set of collage pieces: assets/pieces.json names none');
  return set;
}

// A piece of a set as a file of assets/ ('collage/b00_001.webp', 'collage-web/b00_001.jpg'; assets.js
// fetches it under the site's base, src/base.js assetUrl). name: the original's file name as baked.json
// records it (b00_001.webp); the web set's piece has that name with .jpg.
export function collageFile(set, name) {
  if (!Object.hasOwn(FOLDER, set)) throw new Error(`collageFile: no set ${JSON.stringify(set)} (${SETS.join(' or ')})`);
  return `${FOLDER[set]}/${set === 'web' ? name.replace(/\.[^./]*$/, '') + '.jpg' : name}`;
}

// The scale a web piece is made at: its own "scale" in web.json, else the list's (the default, 0.5).
// 0.5: half the original's size (each side rounded half up, collage.js halfPx); 1: the original's size,
// for the pieces drawn while the camera is pushed in (tools/full_size_pieces.mjs). web: web.json; entry:
// the piece's entry in it. -> 1 | 0.5, or null for anything else.
export function webScale(web, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const s = Object.hasOwn(entry, 'scale') ? entry.scale : web && web.scale;
  return s === 1 || s === 0.5 ? s : null;
}

// The entry of web.json (tools/make_collage_web.py: { scale, quality, cuts: { '<name>.jpg': { key, scale,
// w, h } } }) for the web piece of a cut of the manifest (its file, 'collage/b00_001.webp'), or undefined.
export function webEntry(web, file) {
  const cuts = web && typeof web === 'object' && web.cuts && typeof web.cuts === 'object' && !Array.isArray(web.cuts) ? web.cuts : {};
  const piece = collageFile('web', file.slice(file.lastIndexOf('/') + 1));
  const name = piece.slice(piece.lastIndexOf('/') + 1);
  return Object.hasOwn(cuts, name) ? cuts[name] : undefined;
}

// The cuts of list (collage.js usedCuts) whose web piece is not theirs, as collage.js staleCuts for the
// originals: web.json has no entry for the cut's piece, one made from another cut (the originals were
// baked again and the web set was not made again), or one at a scale a piece cannot have (webScale).
// -> [{ cut, why }]; a cut without a key is never current.
export function staleWeb(list, web) {
  const out = [];
  for (const c of list) {
    const e = webEntry(web, c.file);
    if (!e || typeof e !== 'object') out.push({ cut: c, why: 'not made (no entry in web.json)' });
    else if (typeof c.key !== 'string' || e.key !== c.key) out.push({ cut: c, why: 'made from another cut (web.json has another key)' });
    else if (webScale(web, e) === null) out.push({ cut: c, why: `web.json gives it scale ${JSON.stringify(e.scale)} (a piece is at scale 1 or 0.5)` });
  }
  return out;
}

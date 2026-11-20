// Loads everything the page draws from: the files of assets/, which Vite serves at the site's base (the
// root on the dev server, /fractal/ on GitHub Pages). Every name below is a file of assets/, fetched at
// its address under the base (src/base.js assetUrl).
// Big pictures are decoded with no colour-space conversion and no premultiplication, so the
// texture holds the display sRGB values of the file as they are.
import { assetProblems } from './consistency.js';
import { usedCuts, collageBytes, staleCuts, cutTexture } from './collage.js';
import { chooseCollageSet, collageFile, staleWeb, webScale, webEntry } from './collage_set.js';
import { CARD_FONT } from './card.js';
import { assetUrl } from './base.js';

// collage: the collage's blocks and cuts (tools/make_collage.py); of the cut pictures it names the
// ones the score uses are loaded (collageCuts), from one of the two sets of pieces (collage_set.js):
// the baked originals (assets/collage/, tools/make_collage.py --bake) or the web set
// (assets/collage-web/, tools/make_collage_web.py), after the set's list has shown that each piece is
// its cut's. Which sets there are, assets/pieces.json says; the set is chosen once, when the page loads.
const JSON_FILES = ['regions', 'strokes', 'palette', 'score', 'music', 'collage'];
const PIECES = 'pieces.json';
// each set's list: baked.json (file name -> bake key) for the originals, web.json ({ cuts: { name: { key,
// w, h } } }) for the web set
const LISTS = { full: 'collage/baked.json', web: 'collage-web/web.json' };
// what mends a piece of each set that is missing, stale or of another size
const MEND = { full: 'bake the collage cuts with tools/make_collage.py --bake', web: 'make the web set with tools/make_collage_web.py' };
// Baked cuts fetched and decoded at a time: the browser opens at most 6 connections to one host,
// so 8 keeps them all busy while two more decode or wait (4: reloads 3.3 s, 6: 3.0, 8: 2.8,
// 12: 2.5 s; 2026-11-18).
const CUT_LOADS = 8;
// A fetch that gets no answer, or whose body breaks off while it is read, is tried once more, with a
// warning naming the file: a safety net, not part of a normal load. The case seen (2026-11-18): in
// the first seconds after a headless Edge started, every request in flight at one moment was
// cancelled by the browser (net::ERR_ABORTED, the page neither reloaded nor hid; no message from the
// dev server); with Edge's extensions off (--disable-extensions, as tools/browser.mjs starts it) it
// did not happen. A real window with extensions can still meet it in its first seconds.
const RETRIES = 1;
// wires: the pixels the plate repainted, by the colour of their wire (R black, G red; tools/make_plate.py)
// lifeMap: where the finished picture flows, trembles and breathes (R, G, B; tools/make_life.py), in
// picture px; described by life.json, which assetProblems checks against the region map
const PICTURES = { key: 'key_hires.png', plate: 'key_plate.png', wires: 'wire_mask.png', lifeMap: 'life.png' };
const LIFE = 'life.json';

// fetch(url) and its whole body, both inside the part that is tried again: a request that gets no
// answer (fetch rejects) or a body that breaks off is sent again `retries` times, after a warning
// naming the url (console.warn: the tools fail a frame on a console error, not on a warning), and
// then fails with an error naming the url and the tries. An answer is never retried, whatever its
// status: the caller decides (a missing file comes back from the dev server as its page, status 200).
// opts (for the tests): fetch, warn, retries, wait (ms before a retry, times the try).
// -> { ok, status, statusText, type (content-type, '' when none), blob }
export async function fetchRetry(url, { fetch: fetchFn = (u) => fetch(u), warn = (...a) => console.warn(...a), retries = RETRIES, wait = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchFn(url);
      const blob = await r.blob();
      return { ok: r.ok, status: r.status, statusText: r.statusText, type: r.headers.get('content-type') || '', blob };
    } catch (e) {
      if (attempt >= retries) throw new Error(`${url}: ${e.message} (tried ${attempt + 1} times)`);
      warn(`${url}: ${e.message}; trying again`);
      if (wait > 0) await new Promise((ok) => setTimeout(ok, wait * (attempt + 1)));
    }
  }
}

async function get(url) {
  const r = await fetchRetry(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${r.statusText}`);
  return r;
}

async function getJSON(url) {
  const r = await get(url);
  try {
    return JSON.parse(await r.blob.text());
  } catch (e) {
    throw new Error(`${url}: not valid JSON (${e.message})`);
  }
}

// A JSON file whose absence assetProblems reports with the tool that makes it: null when it is not
// there (a missing file comes back from the dev server as its page, status 200) or is not JSON.
async function getJSONOrNull(url) {
  const r = await fetchRetry(url);
  if (!r.ok || !/json/.test(r.type)) return null;
  try {
    return JSON.parse(await r.blob.text());
  } catch {
    return null;
  }
}

// Width and height from a PNG header (IHDR), or null for anything else.
async function pngSize(blob) {
  const b = new DataView(await blob.slice(0, 24).arrayBuffer());
  if (b.byteLength < 24 || b.getUint32(0) !== 0x89504e47 || b.getUint32(12) !== 0x49484452) return null;
  return { w: b.getUint32(16), h: b.getUint32(20) };
}

const DECODE = { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image' };

// tex 'half': decoded straight to half size by the browser (high-quality resampling), so the
// full-size bitmap is never held. The size comes from the PNG header; other formats are decoded
// at full size first and then reduced. onSize({ w, h }) is told the size the bitmap will have as
// soon as the header is read, before the (long) decode.
async function getPicture(url, tex, onSize) {
  const { blob } = await get(url);
  const size = await pngSize(blob);
  const half = (sz) => ({ w: Math.max(1, Math.round(sz.w / 2)), h: Math.max(1, Math.round(sz.h / 2)) });
  const resize = (sz) => ({ ...DECODE, resizeWidth: sz.w, resizeHeight: sz.h, resizeQuality: 'high' });
  if (size && onSize) onSize(tex === 'half' ? half(size) : size);
  try {
    if (tex !== 'half') return await createImageBitmap(blob, DECODE);
    if (size) return await createImageBitmap(blob, resize(half(size)));
    const full = await createImageBitmap(blob, DECODE);
    const small = await createImageBitmap(full, resize(half({ w: full.width, h: full.height })));
    full.close();
    return small;
  } catch (e) {
    throw new Error(`${url}: could not decode (${e.message})`);
  }
}

// assets/pieces.json (which sets of pieces this copy has) and ?pieces= (query, null when none) -> the
// set to load ('full' | 'web', collage_set.js chooseCollageSet). Its errors, and a pieces.json that is
// not there, are marked e.pieces (main.js says so).
async function choosePieces(query) {
  const refused = (message) => Object.assign(new Error(message), { pieces: true });
  const r = await fetchRetry(assetUrl(PIECES));
  // a missing file comes back from the dev server as its page (HTML, status 200)
  if (!r.ok || !/json/.test(r.type)) throw refused(`assets/${PIECES}: not there (HTTP ${r.status}, ${r.type || 'no type'})`);
  let pieces;
  try {
    pieces = JSON.parse(await r.blob.text());
  } catch (e) {
    throw refused(`assets/${PIECES}: not valid JSON (${e.message})`);
  }
  return chooseCollageSet({ query, sets: pieces && typeof pieces === 'object' ? pieces.sets : undefined });
}

// A piece of the set that cannot be drawn: the error names the file (e.cut, under assets/), its set
// (e.set) and its kind (e.kind): 'missing' (not there), 'stale' (the set's list does not record it as
// its cut's) and 'size' (not the size the manifest gives it) are mended by making the set again, and the
// message says how (MEND); 'decode' (the browser could not decode it) is most likely memory, and main.js
// says so (collage.js decodeNotice, with e.why: the browser's own words).
function cutError(set, file, why, kind, words = why) {
  const mend = kind === 'decode' ? '' : `; ${MEND[set]}`;
  const e = new Error(`assets/${file}: ${why}${mend}`);
  e.cut = file;
  e.set = set;
  e.kind = kind;
  e.why = words;
  return e;
}

// The cut's piece in the set: a file of assets/ (collage_set.js collageFile, from the manifest's file name).
const pieceFile = (set, c) => collageFile(set, c.file.slice(c.file.lastIndexOf('/') + 1));

// The set's list (LISTS), checked against every cut the score uses before any is fetched
// (collage.js staleCuts for baked.json, collage_set.js staleWeb for web.json): a piece made from
// another cut keeps its name and its size, so nothing else would notice. The first such cut is the
// error, with how many there are. -> the list (web.json gives each web piece its scale).
async function checkList(set, list) {
  const file = LISTS[set];
  const r = await fetchRetry(assetUrl(file));
  if (!r.ok || !/json/.test(r.type)) throw cutError(set, file, `not there (HTTP ${r.status}, ${r.type || 'no type'})`, 'missing');
  let rec;
  try {
    rec = JSON.parse(await r.blob.text());
  } catch (e) {
    throw cutError(set, file, `not valid JSON (${e.message})`, 'missing');
  }
  const stale = set === 'web' ? staleWeb(list, rec) : staleCuts(list, rec);
  if (stale.length) {
    const more = stale.length > 1 ? ` (and ${stale.length - 1} more of the ${list.length} cuts)` : '';
    throw cutError(set, pieceFile(set, stale[0].cut), `${stale[0].why}${more}`, 'stale');
  }
  return rec;
}

// One cut ({ file, box, margin }, see collage.js usedCuts) from the set -> ImageBitmap of the size
// collage.js cutTexture gives it: the original is (bw + 2m) x (bh + 2m) px, or with tex 'half' decoded
// straight to half of that (the size is known from the manifest); a web piece is taken as it is, at its
// scale's size (scale: collage_set.js webScale; half size, or the original's for the pieces drawn while
// the camera is pushed in), whatever tex says. A file that is not there comes back from the dev server
// as its page (HTML, status 200), so anything but a picture counts as missing.
async function getCut(c, set, tex, scale) {
  const file = pieceFile(set, c);
  const r = await fetchRetry(assetUrl(file));
  if (!r.ok || !r.type.startsWith('image/')) throw cutError(set, file, `not there (HTTP ${r.status}, ${r.type || 'no type'})`, 'missing');
  const want = cutTexture(c, { set, tex, scale });
  let bmp;
  try {
    bmp =
      want.decode === 'half'
        ? await createImageBitmap(r.blob, { ...DECODE, resizeWidth: want.w, resizeHeight: want.h, resizeQuality: 'high' })
        : await createImageBitmap(r.blob, DECODE);
  } catch (e) {
    throw cutError(set, file, `could not decode (${e.message})`, 'decode', e.message);
  }
  if (want.decode !== 'half' && (bmp.width !== want.w || bmp.height !== want.h)) {
    const is = `${bmp.width}x${bmp.height}`; // read before close(), which makes them 0
    bmp.close();
    const of = set === 'web' ? ` (web.json: scale ${scale} of ${c.box[0] + 2 * c.margin}x${c.box[1] + 2 * c.margin})` : '';
    throw cutError(set, file, `is ${is}, the manifest wants ${want.w}x${want.h}${of}`, 'size');
  }
  return bmp;
}

// The cuts the score uses in any strength, from the set, CUT_LOADS at a time -> one Map (cut position
// -> ImageBitmap) per block row. The set's list is read first (checkList); then onCollage({ images,
// bytes, loaded, set }) is told the count and GPU size (the textures' own, cutTexture: half size with tex
// 'half', and for the web set each piece's by its scale) and the set, and again after every cut. On a
// failure the bitmaps already decoded are closed.
async function getCuts(collage, scoreCollage, set, tex, onCollage) {
  const list = usedCuts(collage, scoreCollage);
  const rec = list.length ? await checkList(set, list) : null;
  // a web piece's scale (checkList has refused any other); null for the originals
  const scales = new Map(list.map((c) => [c, set === 'web' ? webScale(rec, webEntry(rec, c.file)) : null]));
  // the size each texture has (as cutTexture): a web piece by its scale, an original by tex
  const size = (c) => ((set === 'web' ? scales.get(c) === 0.5 : tex === 'half') ? 'half' : 'full');
  const bytes = collageBytes(list, size);
  const out = collage.blocks.map(() => new Map());
  let loaded = 0;
  let next = 0;
  let failed = null;
  if (onCollage) onCollage({ images: list.length, bytes, loaded, set });
  const worker = async () => {
    while (next < list.length && !failed) {
      const c = list[next++];
      let bmp;
      try {
        bmp = await getCut(c, set, tex, scales.get(c));
      } catch (e) {
        failed = failed || e;
        break;
      }
      if (failed) {
        bmp.close();
        break;
      }
      out[c.row].set(c.cut, bmp);
      loaded++;
      if (onCollage) onCollage({ images: list.length, bytes, loaded, set });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CUT_LOADS, list.length) }, worker));
  if (failed) {
    for (const m of out) for (const b of m.values()) b.close();
    throw failed;
  }
  return out;
}

// The end card's font (card.js CARD_FONT; assets/fonts/<file>, served at fonts/ under the base): fetched
// (fetchRetry), made a FontFace of its family and weight and added to document.fonts, so the card's
// 2D canvas draws in it (layers/card.js). -> null when it is there; else the problem, one line naming
// the font (the card then draws its text in the browser's fallback face). The font is never a reason
// to stop the page.
async function loadFont() {
  const f = CARD_FONT;
  const file = `fonts/${f.file}`;
  try {
    const r = await fetchRetry(assetUrl(file));
    // a missing file comes back from the dev server as its page (HTML, status 200)
    if (!r.ok || /html/.test(r.type)) throw new Error(`not there (HTTP ${r.status}, ${r.type || 'no type'})`);
    const face = new FontFace(f.family, await r.blob.arrayBuffer(), { weight: String(f.weight), style: 'normal' });
    await face.load();
    document.fonts.add(face);
    return null;
  } catch (e) {
    return `the end card's font (${f.family} ${f.weight}, assets/${file}) could not be loaded: ${e.message}`;
  }
}

// -> { key, plate, wires, regions, strokes, palette, score, music, collage, collageCuts, life, lifeMap,
// fontProblem, tex, collageSet } (key, plate, wires and lifeMap are ImageBitmaps; collageCuts[block
// row].get(cut position) is the cut's ImageBitmap from the chosen set, for every cut the score uses in
// any strength; null with ref; life is life.json, lifeMap the picture it describes, null with ref;
// fontProblem: loadFont's, the end card's font being in document.fonts by the time this resolves, not
// loaded with ref; collageSet: the set of pieces chosen, 'full' or 'web', with ref too). ref: the key
// image alone is drawn (?ref=1), so no cut, no life map and no font is loaded. pieces: ?pieces= (null
// when the address has none; choosePieces). tex 'half' decodes the big pictures and the original pieces
// at half size; the web set's pieces are taken at the size they were made (mostly half size).
// onPictureSize({ w, h }): the size of each big picture as soon as it is known (see getPicture);
// onCollage: see getCuts. Throws when the JSON files do not fit together or one is missing
// (consistency.js; the error's `problems` lists why), when the set cannot be chosen (the error's
// `pieces` is true) and when a piece cannot be drawn (the error's `cut` names it, its `set` and `kind`
// say which set and why: see cutError).
export async function loadAssets({ tex = 'full', pieces = null, ref = false, onPictureSize = null, onCollage = null } = {}) {
  const jsons = Promise.all([...JSON_FILES.map((n) => getJSON(assetUrl(`${n}.json`))), getJSONOrNull(assetUrl(LIFE))]);
  const chosen = choosePieces(pieces);
  chosen.catch(() => {}); // thrown below, after the JSON files' problems
  const names = ref ? ['key', 'plate', 'wires'] : ['key', 'plate', 'wires', 'lifeMap'];
  const pics = Promise.all(names.map((k) => getPicture(assetUrl(PICTURES[k]), tex, onPictureSize)));
  pics.catch(() => {}); // its failure is thrown below; this only keeps a JSON failure first from leaving it unhandled
  const font = ref ? Promise.resolve(null) : loadFont(); // never rejects
  const [regions, strokes, palette, score, music, collage, life] = await jsons;
  // stale or mismatched material is refused here instead of being drawn wrong without a word
  const problems = assetProblems({ regions, strokes, palette, score, music, collage, life });
  if (problems.length) {
    const e = new Error(`the assets do not fit together:\n${problems.join('\n')}`);
    e.problems = problems;
    throw e;
  }
  const collageSet = await chosen;
  // the cuts are fetched while the big pictures decode
  const cuts = ref ? Promise.resolve(null) : getCuts(collage, score.collage, collageSet, tex, onCollage);
  cuts.catch(() => {});
  const [[key, plate, wires, lifeMap = null], collageCuts, fontProblem] = await Promise.all([pics, cuts, font]);
  return { key, plate, wires, regions, strokes, palette, score, music, collage, collageCuts, life, lifeMap, fontProblem, tex, collageSet };
}

// '#rrggbb' -> [r, g, b] in 0..1, the display values as they are (no conversion).
export function hexRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a colour: ${hex}`);
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

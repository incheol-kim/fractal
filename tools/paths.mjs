// Where everything that is not on GitHub lives (see "저장소에 올라가지 않는 것" in tools/README.md).
// The tools take their folders from here and never spell a folder name themselves. The Python twin
// is tools/paths.py; tools/test_paths.py checks that the two name the same folders.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL = path.join(ROOT, 'local-only');
export const TEMP = path.join(LOCAL, 'temp'); // everything that can be made again; may be deleted at any time
export const VIDEO = path.join(LOCAL, 'video'); // the exported videos (test exports in video/tests/)
export const MODELS = path.join(LOCAL, 'models'); // downloaded model weights
export const LOSSLESS = path.join(LOCAL, 'review-lossless'); // the lossless copy of a review bundle
export const PUBLIC = path.join(LOCAL, 'public'); // the public tree (public/fractal/, the public repository's checkout) and its file list, written by the publication tooling (not part of the published copy)
export const EDGE_PROFILES = path.join(TEMP, 'edge'); // headless Edge's profiles (browser.mjs; one a killed tool left behind may be removed)

// is p (relative paths are taken from ROOT) strictly inside TEMP? A path that leaves it by ".." is not.
export function inTemp(p) {
  const rel = path.relative(TEMP, path.resolve(ROOT, p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The page's addresses under the site's base path. The dev server serves the page at the site's root
// ('/'); GitHub Pages serves it under the repository's name (https://incheol-kim.github.io/fractal/, built
// with vite build --base=/fractal/), where nothing of the page is at the root. Vite gives the base it was
// started or built with as import.meta.env.BASE_URL; outside Vite (Node's tests) there is none, and the
// base is '/'.
const VITE_BASE = (import.meta.env && import.meta.env.BASE_URL) || '/';

// path: a file of assets/ (Vite serves that folder at the base: vite.config.js publicDir), as
// 'collage-web/b00_001.jpg' -> its address under base (on GitHub Pages /fractal/collage-web/b00_001.jpg).
// A path from the root, a whole URL or an empty one is refused: it would not be under the base.
export function assetUrl(path, base = VITE_BASE) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(`assetUrl: not a file of assets/: ${JSON.stringify(path)}`);
  }
  return (base.endsWith('/') ? base : `${base}/`) + path;
}

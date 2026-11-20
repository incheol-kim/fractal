// The page's addresses under the site's base path (src/base.js assetUrl): the dev server serves the page at
// the root ('/'), GitHub Pages under the repository's name ('/fractal/', built with --base=/fractal/), so no
// address of the page may start at the site's root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetUrl } from '../src/base.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('assetUrl: a file of assets/ under the base, "/" on the dev server and "/fractal/" on GitHub Pages', () => {
  assert.equal(assetUrl('key_hires.png', '/'), '/key_hires.png');
  assert.equal(assetUrl('key_hires.png', '/fractal/'), '/fractal/key_hires.png');
  assert.equal(assetUrl('collage-web/b00_001.jpg', '/'), '/collage-web/b00_001.jpg');
  assert.equal(assetUrl('collage-web/b00_001.jpg', '/fractal/'), '/fractal/collage-web/b00_001.jpg');
  assert.equal(assetUrl('fonts/geo/Geo-Regular.ttf', '/fractal/'), '/fractal/fonts/geo/Geo-Regular.ttf');
  // a base without its closing slash is the same folder
  assert.equal(assetUrl('score.json', '/fractal'), '/fractal/score.json');
  // a relative base (vite build --base=./) stays relative
  assert.equal(assetUrl('score.json', './'), './score.json');
});

test('assetUrl: without a base, the one Vite gives the page; "/" where there is none (these tests)', () => {
  assert.equal(assetUrl('score.json'), '/score.json');
});

test('assetUrl: refuses an address that is not a file of assets/ (from the root, a whole URL, empty)', () => {
  for (const bad of ['/key_hires.png', 'https://example.com/a.png', '', 'data:,']) {
    assert.throws(() => assetUrl(bad, '/fractal/'), /assetUrl/, JSON.stringify(bad));
  }
  assert.throws(() => assetUrl(undefined, '/'), /assetUrl/);
});

// The page's own code (src/, every .js file): no string that starts at the site's root ('/score.json',
// `/${name}.json`, '/' + file). Every address the page fetches goes through assetUrl. index.html's two
// (the audio and the module script) are rewritten by Vite's build and checked by loading the built site
// under /fractal/ (plan 5, Task 2, Step 3).
const ROOT_STRING = /(['"`])\/(?![/*'"`\s])|(['"`])\/\2\s*\+/;
test('src/ has no address from the site\'s root: every fetch goes through assetUrl', () => {
  assert.ok(ROOT_STRING.test("fetch('/score.json')") && ROOT_STRING.test('`/${n}.json`') && ROOT_STRING.test("'/' + c.file"), 'the scan sees each form');
  assert.ok(!ROOT_STRING.test("c.file.lastIndexOf('/') + 1") && !ROOT_STRING.test("assetUrl('score.json')"), 'and not a lone slash');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  };
  walk(path.join(root, 'src'));
  assert.ok(files.length >= 20, `${files.length} files in src/`);
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (ROOT_STRING.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});

// The renderer, the layers, cutouts.js and ribbons.js only draw the frame state: every time-to-state
// computation lives in timeline.js (frameState). So none of them imports ease.js (smooth, hash21,
// ...), and the one thing any of them takes from timeline.js is cameraAt in layers/washes.js (each
// wash's zoom at its own time, read once when the layer is made). ribbons.js, shared by the layers
// that draw pencil strokes, imports no layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (...p) => path.join(root, 'src', ...p);
const RIBBONS = src('ribbons.js');
const FILES = [
  src('renderer.js'),
  src('cutouts.js'),
  RIBBONS,
  ...readdirSync(src('layers'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => src('layers', f)),
];
const EASE = src('ease.js');
const TIMELINE = src('timeline.js');

// The module imports of a file -> [{ file (absolute), names }]; names: the imported bindings
// ('default' for a default import, '*' for a namespace or a bare / dynamic import).
function importsOf(file) {
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const out = [];
  const at = (spec) => (spec.startsWith('.') ? path.resolve(path.dirname(file), spec.replace(/\?.*$/, '')) : spec);
  for (const m of code.matchAll(/\b(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const names = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (/\*/.test(rest)) names.push('*');
    else if (rest) names.push('default');
    out.push({ file: at(m[2]), names });
  }
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push({ file: at(m[1]), names: ['*'] });
  for (const m of code.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) out.push({ file: at(m[1]), names: ['*'] });
  return out;
}

test('purity: the import reader sees named, default and namespace imports', () => {
  const r = importsOf(src('renderer.js'));
  assert.ok(r.some((i) => i.file === 'three' && i.names.includes('*')), 'import * as THREE');
  assert.ok(r.some((i) => i.file === src('shaders', 'common.glsl') && i.names.includes('default')), 'import commonGLSL from');
  assert.ok(r.some((i) => i.file === src('layers', 'paper.js') && i.names.includes('createGrainLayer')), 'named imports');
  assert.ok(FILES.length >= 8, `${FILES.length} files`);
});

test('purity: the renderer, the layers, cutouts.js and ribbons.js do not import ease.js', () => {
  for (const f of FILES) {
    for (const i of importsOf(f)) {
      assert.notEqual(i.file, EASE, `${path.relative(root, f)} imports ease.js (${i.names.join(', ')})`);
    }
  }
});

test('purity: of timeline.js they import cameraAt in layers/washes.js, and nothing else', () => {
  const uses = [];
  for (const f of FILES) {
    for (const i of importsOf(f)) {
      if (i.file === TIMELINE) uses.push(`${path.relative(root, f).replace(/\\/g, '/')}: ${i.names.join(', ')}`);
    }
  }
  assert.deepEqual(uses, ['src/layers/washes.js: cameraAt']);
});

test('purity: the layers do not import each other', () => {
  const layers = FILES.filter((f) => f.startsWith(src('layers') + path.sep));
  for (const f of layers) {
    for (const i of importsOf(f)) {
      assert.ok(!layers.includes(i.file), `${path.relative(root, f)} imports ${path.relative(root, i.file)}`);
    }
  }
});

// src/card.js holds the end card's constants and cardAt (the time to its state, called by timeline.js
// only): it imports no layer and nothing that draws; the layers take its constants, never cardAt
const CARD = src('card.js');
test('purity: card.js imports no layer and nothing that draws; no layer calls cardAt', () => {
  for (const i of importsOf(CARD)) {
    assert.ok(!i.file.startsWith(src('layers') + path.sep), `src/card.js imports ${path.relative(root, i.file)}`);
    assert.ok(![src('renderer.js'), src('assets.js'), 'three'].includes(i.file), `src/card.js imports ${i.file}`);
  }
  for (const f of FILES) {
    for (const i of importsOf(f)) {
      if (i.file === CARD) assert.ok(!i.names.includes('cardAt') && !i.names.includes('*'), `${path.relative(root, f)} imports ${i.names.join(', ')} of card.js`);
    }
  }
});

// src/controls.js holds the playback controls' logic (taps, seeks, steps by cello note, keys): no
// DOM, no time source and no layer; src/ui.js does the DOM and main.js the audio and the clock
const CONTROLS = src('controls.js');
test('purity: controls.js imports no layer, nothing that draws and no DOM code; it reads no clock and touches no page', () => {
  const banned = [src('renderer.js'), src('assets.js'), src('ui.js'), src('main.js'), src('timeline.js'), 'three'];
  for (const i of importsOf(CONTROLS)) {
    assert.ok(!i.file.startsWith(src('layers') + path.sep), `src/controls.js imports ${path.relative(root, i.file)}`);
    assert.ok(!banned.includes(i.file), `src/controls.js imports ${i.file}`);
  }
  const code = readFileSync(CONTROLS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const word of ['document', 'window', 'globalThis', 'navigator', 'performance', 'Date', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'addEventListener', 'Math.random']) {
    assert.ok(!new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(code), `src/controls.js uses ${word}`);
  }
});

// src/subframes.js holds the sub-frames' times, jitters and the score's cut times (pure): no layer,
// nothing that draws, no DOM; renderer.js draws the sub-frames and main.js asks for them
const SUBFRAMES = src('subframes.js');
test('purity: subframes.js imports no layer, nothing that draws and no DOM code', () => {
  const banned = [src('renderer.js'), src('assets.js'), src('ui.js'), src('main.js'), src('timeline.js'), 'three'];
  for (const i of importsOf(SUBFRAMES)) {
    assert.ok(!i.file.startsWith(src('layers') + path.sep), `src/subframes.js imports ${path.relative(root, i.file)}`);
    assert.ok(!banned.includes(i.file), `src/subframes.js imports ${i.file}`);
  }
  const code = readFileSync(SUBFRAMES, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  for (const word of ['document', 'window', 'globalThis', 'navigator', 'performance', 'Date', 'requestAnimationFrame', 'addEventListener', 'Math.random']) {
    assert.ok(!new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(code), `src/subframes.js uses ${word}`);
  }
});

test('purity: ribbons.js is not a layer and imports none', () => {
  assert.ok(!RIBBONS.startsWith(src('layers') + path.sep));
  for (const i of importsOf(RIBBONS)) {
    assert.ok(!i.file.startsWith(src('layers') + path.sep), `src/ribbons.js imports ${path.relative(root, i.file)}`);
  }
});

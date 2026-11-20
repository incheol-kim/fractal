// What the published copy needs (plan 5), tested in this repository and in the copy alike: a README whose
// links and controls are right, no path of this computer in any file that is published, a page that
// speaks English, the third-party notices served with the site, and the public tree's mark
// (test/public_tree.js) read the same way everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keyAction } from '../src/controls.js';
import { ROOT, MARKER, isPublicTree, skipUnpublished } from './public_tree.js';

// ---- the public tree's mark

test('public_tree: the mark is a file PUBLIC_TREE at the root; a test skips only there, and only for what is missing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'public-tree-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'review'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'review', 'here.json'), '{}');
    // not the public tree: nothing skips, whatever is missing (the test runs and fails)
    assert.equal(isPublicTree(dir), false);
    assert.equal(skipUnpublished('docs/review/gone.json', 'the sheet', dir), false);
    writeFileSync(path.join(dir, MARKER), 'generated\n');
    assert.equal(isPublicTree(dir), true);
    const why = skipUnpublished('docs/review/gone.json', 'the candidate sheet', dir);
    assert.equal(typeof why, 'string');
    assert.match(why, /docs\/review\/gone\.json/);
    assert.match(why, /PUBLIC_TREE/);
    assert.match(why, /the candidate sheet/);
    // what the public tree has runs there too
    assert.equal(skipUnpublished('docs/review/here.json', 'x', dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- no path of this computer in what is published

// A drive path, built from pieces so that this file does not match itself.
const DRIVE = new RegExp('\\b[Cc]' + ':' + '[\\\\/]');
// The tests of the export's path scrubbing and the scrubber's comment use made-up paths (a work folder
// "proj", users "bob", "ed", "eddie", "someone", "qzxkv"): they stay, and the privacy scan the published
// copy passes before it is published lets them through too.
const MADE_UP_PATHS = ['test/export.test.js', 'tools/export_lib.mjs'];
// The working process's records, not published (and frozen: not edited for this)
const NOT_PUBLISHED = /^(docs|prompts)\//;
// folders that are never part of a tree (installed, generated, or kept off GitHub: .gitignore)
const NOT_FILES = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'local-only', '.superpowers', '.claude']);

// The files that go public, as paths from the root ('/' between folders). Where this folder is a git
// repository of its own: its tracked files, docs/ and prompts/ left out. In the public tree as it is
// generated, before it becomes a repository: every file in it. Anywhere else (a folder inside another
// repository, not marked): an error, never an empty list that passes.
function publishedFiles() {
  let top = null;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    top = null;
  }
  const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  if (top && same(top, ROOT)) {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter((p) => p && !NOT_PUBLISHED.test(p));
  }
  if (!isPublicTree()) throw new Error(`${ROOT} is neither a git repository of its own nor the public tree (${MARKER}): its files cannot be listed`);
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!NOT_FILES.has(e.name)) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      } else out.push(`${rel}${e.name}`);
    }
  };
  walk(ROOT, '');
  return out;
}

// text, as git tells it: no zero byte in the first 8000
function isText(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(8000);
    const n = readSync(fd, b, 0, b.length, 0);
    return !b.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

test('no published text file holds a path of this computer (a drive path), but the made-up ones of the scrubbing tests', () => {
  assert.ok(DRIVE.test('at ' + 'C' + ':\\x') && DRIVE.test('c' + ':/x') && !DRIVE.test('https://x') && !DRIVE.test('ABC' + ':/x'), 'the pattern');
  const files = publishedFiles();
  assert.ok(files.length > 50 && files.includes('package.json') && files.includes('src/main.js'), `${files.length} files listed`);
  for (const f of MADE_UP_PATHS) assert.ok(files.includes(f), `${f} is published`);
  const hits = [];
  for (const rel of files) {
    if (MADE_UP_PATHS.includes(rel)) continue;
    const file = path.join(ROOT, ...rel.split('/'));
    if (!existsSync(file) || !isText(file)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (DRIVE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  assert.deepEqual(hits, []);
});

// ---- the third-party notices, served with the site (assets/ is the site's root)

test("the third-party notices carry three.js's licence as installed, the version package-lock.json pins, and where the font's licence is", () => {
  const notices = readFileSync(path.join(ROOT, 'assets', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const version = lock.packages['node_modules/three'].version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(notices.includes(`three.js ${version}`), `the notices name three.js ${version}`);
  const licence = readFileSync(path.join(ROOT, 'node_modules', 'three', 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.match(licence, /^The MIT License/);
  assert.ok(notices.includes(licence), "the notices hold node_modules/three/LICENSE's text");
  // the font's licence, by its address on the site (the build copies assets/ to the site's root)
  assert.match(notices, /fonts\/geo\/OFL\.txt/);
  assert.ok(existsSync(path.join(ROOT, 'assets', 'fonts', 'geo', 'OFL.txt')));
});

// ---- the page speaks English (the public site's viewers; the README is English)

// Hangul, as Unicode escapes so that this file holds none
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
// text with its comments blanked, lines kept: /* */ blocks, <!-- --> in HTML, and // to the end of the line
// where // starts the line or follows a space (the // of an address, http://, is not a comment)
function withoutComments(text, html = false) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let t = html ? text.replace(/<!--[\s\S]*?-->/g, blank) : text;
  t = t.replace(/\/\*[\s\S]*?\*\//g, blank);
  return t
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

test('the page shows no Korean: no Hangul outside the comments of src/ and index.html', () => {
  const ko = '한글'; // two Hangul syllables
  assert.ok(!HANGUL.test(withoutComments(`// ${ko}\nconst a = 1; // ${ko}\n/* ${ko} */`)), 'comments are not scanned');
  assert.ok(!HANGUL.test(withoutComments(`<!-- ${ko} -->`, true)), 'nor HTML comments');
  assert.ok(HANGUL.test(withoutComments(`show('http://localhost ${ko}')`)) && HANGUL.test(withoutComments(`<p>${ko}</p>`, true)), 'strings and HTML text are');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  };
  walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'index.html'));
  const hits = [];
  for (const f of files) {
    withoutComments(readFileSync(f, 'utf8'), f.endsWith('.html'))
      .split('\n')
      .forEach((line, i) => {
        if (HANGUL.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.ok(files.length >= 20, `${files.length} files`);
  assert.deepEqual(hits, []);
});

// ---- the README

const README = path.join(ROOT, 'README.md');
const readme = () => readFileSync(README, 'utf8').replace(/\r\n/g, '\n');

// the lines from the one that starts a part (a heading, or the bold line "**Watch it**") to the next heading
function part(text, start) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === start);
  assert.ok(i >= 0, `README.md: no line "${start}"`);
  const j = lines.findIndex((l, k) => k > i && /^#{1,6} /.test(l));
  return lines.slice(i + 1, j < 0 ? lines.length : j);
}

test('README: Watch it gives the web version under /fractal/ and one YouTube line, its placeholder or a YouTube address', () => {
  const items = part(readme(), '**Watch it**').filter((l) => /^- /.test(l));
  const web = items.filter((l) => l.includes('https://incheol-kim.github.io/fractal/'));
  assert.equal(web.length, 1, `the web version's line:\n${items.join('\n')}`);
  const yt = items.filter((l) => /youtu|YOUTUBE_URL/i.test(l));
  assert.equal(yt.length, 1, `one YouTube line:\n${items.join('\n')}`);
  assert.ok(
    yt[0].includes('<!-- YOUTUBE_URL -->') || /https:\/\/(youtu\.be\/[\w-]+|www\.youtube\.com\/\S+)/.test(yt[0]),
    `the YouTube line has the placeholder <!-- YOUTUBE_URL --> or a YouTube address: ${yt[0]}`,
  );
});

// The README's names of keys (in backticks in the Controls table's first column) -> KeyboardEvent.code
const KEY_NAMES = { Space: 'Space', '←': 'ArrowLeft', '→': 'ArrowRight', ',': 'Comma', '.': 'Period' };
// codes to ask keyAction about: whatever it answers is a key the page knows
const CODES = [
  ...['Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'],
  ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
  ...['Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal', 'Backquote'],
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

test("README: the Controls table's keys are the keys keyAction knows (src/controls.js), with the taps and the bar", () => {
  const rows = part(readme(), '## Controls')
    .filter((l) => /^\|/.test(l))
    .slice(2) // the header and its rule
    .map((l) => l.split('|').map((c) => c.trim()));
  assert.ok(rows.length >= 3, `the table:\n${rows.join('\n')}`);
  const named = new Set();
  for (const cells of rows) {
    for (const [, name] of cells[1].matchAll(/`([^`]+)`/g)) {
      assert.ok(Object.hasOwn(KEY_NAMES, name), `README.md Controls: a key the test does not know: ${name}`);
      named.add(KEY_NAMES[name]);
    }
  }
  const known = CODES.filter((code) => keyAction({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false }) !== null);
  assert.deepEqual([...named].sort(), known.sort());
  // the touch controls: a tap plays or pauses, a double tap on a side seeks (tapControl), the bar jumps (ui.js)
  const inputs = rows.map((c) => c[1]).join('\n');
  for (const word of [/\bTap\b/, /\bDouble-tap\b/, /\bDrag\b/]) assert.match(inputs, word);
});

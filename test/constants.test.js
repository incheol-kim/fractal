// Constants the page and the Python tools both hold (tools/test_constants.py checks the Python side),
// and those the end card takes from Echolocation and from its font file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { cameraAt, LIFE_SWAY } from '../src/timeline.js';
import { CARD, CARD_FONT } from '../src/card.js';

const score = JSON.parse(readFileSync(new URL('../assets/score.json', import.meta.url), 'utf8'));
const ribbonsJs = readFileSync(new URL('../src/ribbons.js', import.meta.url), 'utf8');
const shader = (name) => readFileSync(new URL(`../src/shaders/${name}`, import.meta.url), 'utf8');

test('constants: the committed camera shows the four section A frames', () => {
  const want = [
    [0, 8, [0.4375, 0.3325, 0.5625, 0.4575]],
    [4.7, 4, [0.375, 0.27, 0.625, 0.52]],
    [8.3, 2, [0.25, 0.145, 0.75, 0.645]],
    [12.0, 1, [0, 0, 1, 1]],
  ];
  for (const [t, zoom, frame] of want) {
    const cam = cameraAt(t, score.camera);
    assert.ok(Math.abs(cam.zoom - zoom) < 1e-6, `zoom at ${t}: ${cam.zoom}`);
    const { cx, cy } = cam;
    const got = [cx - 0.5 / zoom, cy - 0.5 / zoom, cx + 0.5 / zoom, cy + 0.5 / zoom];
    got.forEach((v, i) => assert.ok(Math.abs(v - frame[i]) < 1e-6, `frame at ${t}: ${got} vs ${frame}`));
  }
});

// a swaying wire is read at most LIFE_SWAY picture px up or down (stroke.frag.glsl wire()), inside
// its band, which is WIRE_PAD wider than the wire on each side (ribbons.js, read from the file so that
// the test does not load three)
test('constants: the wires sway less than their band reaches past them (LIFE_SWAY < WIRE_PAD)', () => {
  const m = /^export const WIRE_PAD = ([0-9.]+);/m.exec(ribbonsJs);
  assert.ok(m, 'src/ribbons.js: export const WIRE_PAD = <number>;');
  const pad = Number(m[1]);
  assert.ok(LIFE_SWAY > 0 && LIFE_SWAY < pad, `LIFE_SWAY ${LIFE_SWAY}, WIRE_PAD ${pad}`);
});

// the depth of the collage's fragments being torn off: piece.vert.glsl's TORN_Z mirrors the literal of
// the torn draw in collage.vert.glsl (the folding cut-outs go between it and the other pieces)
test('constants: piece.vert.glsl TORN_Z is the depth of collage.vert.glsl\'s torn draw', () => {
  const torn = /^const float TORN_Z = (-?[0-9.]+);/m.exec(shader('piece.vert.glsl'));
  const draw = /\(torn \? (-?[0-9.]+) : /.exec(shader('collage.vert.glsl'));
  assert.ok(torn, 'src/shaders/piece.vert.glsl: const float TORN_Z = <number>;');
  assert.ok(draw, 'src/shaders/collage.vert.glsl: (torn ? <number> : ...)');
  assert.equal(torn[1], draw[1]);
});

// The end card's timing starts from Echolocation's (the owner's previous piece, read only, in a folder
// echolocation beside this repository's): SR.END_CARD of its src/js/50-app.js. Skipped where that project
// is not on disk (it is not part of this repository).
const ECHO = new URL('../../echolocation/src/js/50-app.js', import.meta.url);
const ECHO_NAME = "Echolocation's src/js/50-app.js (a folder echolocation beside this repository)";
test("constants: the end card's in, hold, out and black are Echolocation's SR.END_CARD", { skip: existsSync(ECHO) ? false : `${ECHO_NAME} is not on this computer` }, () => {
  const m = /^SR\.END_CARD\s*=\s*\{([^}]*)\};/m.exec(readFileSync(ECHO, 'utf8'));
  assert.ok(m, `${ECHO_NAME}: SR.END_CARD = { ... };`);
  const echo = Object.fromEntries(m[1].split(',').map((kv) => kv.split(':').map((s) => s.trim())).map(([k, v]) => [k, Number(v)]));
  assert.deepEqual(echo, { in: CARD.in, hold: CARD.hold, out: CARD.out, black: CARD.black });
});

// The loading notice is set in the end card's face before anything is loaded: index.html declares an
// @font-face of the same file (served at fonts/ under the base; Vite's build adds the base to the url),
// under a name of its own, so that the end card's canvas text keeps the face src/assets.js loads as
// CARD_FONT.family; #notice.status uses it.
test("constants: index.html's @font-face for the loading notice is the end card's font file, under its own name", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = /@font-face\s*\{[^}]*font-family:\s*"([^"]+)"[^}]*src:\s*url\("([^"]+)"\)/.exec(html);
  assert.ok(m, 'index.html: an @font-face { font-family: "<name>"; src: url("<file>") }');
  assert.equal(m[2], `/fonts/${CARD_FONT.file}`);
  assert.notEqual(m[1], CARD_FONT.family);
  assert.match(html, new RegExp(`#notice\\.status\\s*\\{[^}]*"${m[1]}"`), 'the loading notice is set in it');
  assert.match(html, /font-display:\s*swap/, 'the fallback face shows until it arrives');
});

// A TrueType file's family and subfamily (name ids 16 / 17, else 1 / 2, Windows platform) and its
// variation axes ({ tag: [min, max] } from fvar; none for a static font).
function ttfInfo(b) {
  const tables = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) tables[b.toString('latin1', 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16);
  const names = {};
  const nt = tables.name;
  const strings = nt + b.readUInt16BE(nt + 4);
  for (let i = 0; i < b.readUInt16BE(nt + 2); i++) {
    const r = nt + 6 + i * 12;
    const id = b.readUInt16BE(r + 6);
    if (b.readUInt16BE(r) !== 3 || names[id] !== undefined) continue;
    const s = b.subarray(strings + b.readUInt16BE(r + 10), strings + b.readUInt16BE(r + 10) + b.readUInt16BE(r + 8));
    names[id] = Array.from({ length: s.length / 2 }, (_, k) => String.fromCharCode(s.readUInt16BE(k * 2))).join('');
  }
  const axes = {};
  if (tables.fvar) {
    const f = tables.fvar;
    for (let i = 0; i < b.readUInt16BE(f + 8); i++) {
      const a = f + b.readUInt16BE(f + 4) + i * b.readUInt16BE(f + 10);
      axes[b.toString('latin1', a, a + 4)] = [b.readInt32BE(a + 4) / 65536, b.readInt32BE(a + 12) / 65536];
    }
  }
  return { family: names[16] ?? names[1], sub: names[17] ?? names[2], axes };
}

// The end card's font is a file in the repository (assets/fonts/<CARD_FONT.file>, from
// github.com/google/fonts), beside its licence as google/fonts keeps it in ofl/: OFL.txt (SIL Open
// Font License). It is the only font there (tools/README.md).
test("constants: the end card's font is Geo's upright TrueType file in assets/fonts/, with its OFL.txt beside it, and the only one there", () => {
  const fonts = new URL('../assets/fonts/', import.meta.url);
  const file = new URL(CARD_FONT.file, fonts);
  assert.ok(existsSync(file), `assets/fonts/${CARD_FONT.file} is not there`);
  const b = readFileSync(file);
  assert.equal(b.readUInt32BE(0), 0x00010000, `assets/fonts/${CARD_FONT.file}: not a TrueType file`);
  const info = ttfInfo(b);
  assert.equal(info.family, CARD_FONT.family, `assets/fonts/${CARD_FONT.file}: the family`);
  // a static font, drawn as it is: its upright regular, no wght axis to set
  assert.deepEqual(info.axes, {}, `assets/fonts/${CARD_FONT.file}: a variable font`);
  assert.equal(info.sub, 'Regular', `assets/fonts/${CARD_FONT.file}: the subfamily`);
  const [dir, name] = CARD_FONT.file.split('/');
  const licence = new URL(`${dir}/OFL.txt`, fonts);
  assert.ok(existsSync(licence), `assets/fonts/${dir}/OFL.txt is not there`);
  assert.match(readFileSync(licence, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i, `assets/fonts/${dir}/OFL.txt`);
  assert.deepEqual(readdirSync(fonts), [dir], 'assets/fonts/ holds the one font folder');
  assert.deepEqual(readdirSync(new URL(`${dir}/`, fonts)).sort(), [name, 'OFL.txt'].sort(), `assets/fonts/${dir}/: the font and its licence`);
});

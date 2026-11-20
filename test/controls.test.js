// The playback controls' logic (src/controls.js), after Echolocation's (the owner's previous piece:
// its src/js/50-app.js SR.tapControl, SR.seekTarget, SR.seekRun, SR.fmtTime, and their tests in
// test/app.test.js, whose values these keep; only the length is this piece's, VIDEO_END), and the
// steps by cello note (noteStep) on the committed music data. src/ui.js draws the controls over
// the canvas (index.html), main.js moves the audio and the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIDEO_END, CARD_INK, CARD_INK_RGB } from '../src/card.js';
import { DUR } from '../src/music.js';
import { hexRGB } from '../src/assets.js';
import { SEEK, END_GAP, tapControl, seekTarget, seekRun, fmtTime, noteStep, keyAction, seekText, noteText, inAudio } from '../src/controls.js';

const music = JSON.parse(readFileSync(new URL('../assets/music.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// --- taps and clicks on the picture, the same for mouse, touch and pen (phones have no arrow keys)
test('taps: the centre third plays/pauses at once; while paused any tap resumes at once (audio needs the gesture)', () => {
  const c = tapControl();
  assert.deepEqual(c.tap('C', 0, true), [{ type: 'toggle' }]);
  assert.deepEqual(c.tap('C', 1, false), [{ type: 'toggle' }]);
  assert.deepEqual(c.tap('R', 2, false), [{ type: 'toggle' }]);
  assert.deepEqual(c.tap('L', 3, false), [{ type: 'toggle' }]);
});

test('taps: a single side tap while playing pauses after a short wait; a double tap seeks 5 s instead', () => {
  const c = tapControl();
  assert.deepEqual(c.tap('R', 10, true), []);
  assert.deepEqual(c.tick(10.2), [], 'still waiting for a second tap');
  assert.deepEqual(c.tick(10.35), [{ type: 'toggle' }]);
  assert.deepEqual(c.tap('R', 20, true), []);
  assert.deepEqual(c.tap('R', 20.2, true), [{ type: 'seek', dt: 5, dir: 1 }]);
  assert.deepEqual(c.tick(20.6), [], 'a double tap never pauses');
  assert.deepEqual(c.tap('L', 30, true), []);
  assert.deepEqual(c.tap('L', 30.15, true), [{ type: 'seek', dt: -5, dir: -1 }]);
});

test('taps: further taps on the same side keep seeking until the streak lapses', () => {
  const c = tapControl();
  c.tap('R', 0, true);
  c.tap('R', 0.2, true);
  assert.deepEqual(c.tap('R', 0.7, true), [{ type: 'seek', dt: 5, dir: 1 }]);
  assert.deepEqual(c.tap('R', 1.3, true), [{ type: 'seek', dt: 5, dir: 1 }]);
  c.tick(2.5);
  assert.deepEqual(c.tap('R', 2.6, true), [], 'after the streak a side tap waits again');
});

test('taps: a streak that reaches the end (playback stops there) keeps seeking: it never restarts from the beginning', () => {
  const c = tapControl();
  c.tap('R', 0, true);
  c.tap('R', 0.2, true); // seek streak; the video reaches the end and stops
  assert.deepEqual(c.tap('R', 0.6, false), [{ type: 'seek', dt: 5, dir: 1 }], 'not a toggle (which would replay from 0:00)');
  assert.deepEqual(c.tap('R', 1.0, false), [{ type: 'seek', dt: 5, dir: 1 }]);
  assert.deepEqual(c.tap('C', 1.2, false), [{ type: 'toggle' }], 'the centre still plays');
  c.tap('R', 2, true);
  c.tap('R', 2.2, true);
  c.tick(3.5);
  assert.deepEqual(c.tap('R', 3.6, false), [{ type: 'toggle' }], 'after the streak, a tap while paused plays again');
});

// --- seeking
test('seek feedback counts only the time actually moved: it stops growing at the start and the end', () => {
  const r = seekRun();
  assert.equal(r.add(-1, -3, 0), 3, 'from 0:03 a 5 s step back moves 3 s');
  assert.equal(r.add(-1, 0, 0.3), 3, 'at the start');
  assert.equal(r.add(-1, 0, 0.6), 3);
  assert.equal(r.add(1, 5, 1.0), 5, 'the other way starts a new count');
  assert.equal(r.add(1, 2.5, 1.4), 7.5, 'up to the end');
  assert.equal(r.add(1, 0, 1.8), 7.5, 'at the end');
  assert.equal(r.add(1, 5, 3.0), 5, 'a new streak after a pause in tapping');
});

test('a seek never goes past the start or the end of the video, and never moves the wrong way', () => {
  const end = VIDEO_END;
  assert.equal(SEEK, 5);
  assert.equal(END_GAP, 0.05, "Echolocation's last frame: 0.05 s before the end");
  assert.equal(seekTarget(3, -5, end), 0);
  assert.equal(seekTarget(0, -5, end), 0);
  assert.equal(seekTarget(end - 3, 5, end), end - END_GAP);
  assert.equal(seekTarget(end, 5, end), end, 'at the very end (the card has run out): stays, never steps back');
  assert.equal(seekTarget(20, 5, end), 25);
  assert.equal(seekTarget(45, 5, end), 50, 'into the end card after the audio');
  assert.ok(seekTarget(45, 5, end) > DUR);
});

// a seek lands in the audio (its position moves) or in the end card after it (the clock runs on its
// own): the boundary is DUR, or the audio's own end when the element says it is shorter
test('inAudio: before the audio ends a seek moves the audio; from its end on, the end card', () => {
  const full = 47.12; // the mp3 as Chromium reports it, a little longer than DUR
  assert.equal(inAudio(20, DUR, full), true, 'inside the audio');
  assert.equal(inAudio(0, DUR, full), true);
  assert.equal(inAudio(DUR - 0.001, DUR, full), true);
  assert.equal(inAudio(DUR, DUR, full), false, 'at the boundary: the card');
  assert.equal(inAudio(50, DUR, full), false, 'in the card');
  assert.equal(inAudio(47.0, DUR, 46.9), false, 'a shorter audio: past its own end is the card');
  assert.equal(inAudio(46.89, DUR, 46.9), true);
  assert.equal(inAudio(46.9, DUR, 46.9), false, "at a shorter audio's end: the card");
  for (const none of [NaN, undefined, 0, Infinity]) {
    assert.equal(inAudio(DUR - 0.001, DUR, none), true, `no usable duration yet (${none}): DUR`);
    assert.equal(inAudio(DUR, DUR, none), false, `no usable duration yet (${none}): DUR`);
  }
});

test('time label: m:ss; the video is 0:52', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(161.4), '2:41');
  assert.equal(fmtTime(355.9), '5:55');
  assert.equal(fmtTime(VIDEO_END), '0:52');
});

// --- steps by cello note: back, the last note that started before t - 0.02 s (paused) or t - 0.3 s
// (playing: a press goes to the note before the one just passed), else the start; on, the first that
// starts after t + 0.02 s, else none
test('noteStep: back to the note before, on to the next; i counts the notes from 0', () => {
  const on = [1, 2, 3, 4];
  assert.deepEqual(noteStep(on, 2.5, -1, false), { t: 2, i: 1 });
  assert.deepEqual(noteStep(on, 2, -1, false), { t: 1, i: 0 }, 'on a note: the one before it');
  assert.deepEqual(noteStep(on, 2.1, -1, true), { t: 1, i: 0 }, 'playing, within 0.3 s of a note: the one before it');
  assert.deepEqual(noteStep(on, 2.5, -1, true), { t: 2, i: 1 });
  assert.deepEqual(noteStep(on, 0.5, -1, false), { t: 0, i: -1 }, 'before the first note: the start');
  assert.deepEqual(noteStep(on, 2, 1, false), { t: 3, i: 2 });
  assert.equal(noteStep(on, 4, 1, false), null, 'after the last note: no move');
  assert.deepEqual(noteStep([], 10, -1, false), { t: 0, i: -1 });
  assert.equal(noteStep([], 10, 1, false), null);
});

test('noteStep (committed music data): on from the start passes every cello note once, in order; back from the end passes them all to 0', () => {
  const on = music.cello.map((n) => n[0]);
  assert.ok(on.length > 100, `${on.length} cello notes`);
  for (let k = 1; k < on.length; k++) assert.ok(on[k] > on[k - 1], `cello note ${k} at ${on[k]} after ${on[k - 1]}`);
  let t = 0;
  for (let k = 0; k < on.length; k++) {
    const s = noteStep(on, t, 1, false);
    assert.deepEqual(s, { t: on[k], i: k });
    t = s.t;
  }
  assert.equal(noteStep(on, t, 1, false), null);
  t = VIDEO_END;
  for (let k = on.length - 1; k >= 0; k--) {
    const s = noteStep(on, t, -1, false);
    assert.deepEqual(s, { t: on[k], i: k });
    t = s.t;
  }
  assert.deepEqual(noteStep(on, t, -1, false), { t: 0, i: -1 });
});

// --- the feedback bubble's text
test("the bubble: '« 10 s' and '5 s »' for seeks, '« ♪ 12 / 97' and '♪ 13 / 97 »' for notes (counted from 1)", () => {
  assert.equal(seekText(-1, 10), '\u00ab 10 s');
  assert.equal(seekText(1, 5), '5 s \u00bb');
  assert.equal(noteText(-1, 11, 97), '\u00ab \u266a 12 / 97');
  assert.equal(noteText(1, 12, 97), '\u266a 13 / 97 \u00bb');
  assert.equal(noteText(-1, -1, 97), '\u00ab \u266a 0 / 97', 'back to the start, before the first note');
});

// --- keys
test('keys: space plays or pauses (a held key once); the arrows seek and comma / period step by note, held keys repeating; none with Ctrl, Alt or Meta', () => {
  const k = (code, more = {}) => keyAction({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...more });
  assert.deepEqual(k('Space'), { type: 'toggle' });
  assert.equal(k('Space', { repeat: true }), null);
  assert.deepEqual(k('ArrowLeft'), { type: 'seek', dir: -1 });
  assert.deepEqual(k('ArrowRight'), { type: 'seek', dir: 1 });
  assert.deepEqual(k('Comma'), { type: 'note', dir: -1 });
  assert.deepEqual(k('Period'), { type: 'note', dir: 1 });
  for (const code of ['ArrowLeft', 'ArrowRight', 'Comma', 'Period']) {
    assert.deepEqual(k(code, { repeat: true }), k(code), `${code} held`);
    for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(k(code, { [mod]: true }), null, `${code} with ${mod}`);
  }
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(k('Space', { [mod]: true }), null, `Space with ${mod}`);
  for (const code of ['Digit1', 'Digit2', 'Digit3', 'KeyA', 'Enter', 'ArrowUp']) assert.equal(k(code), null, `${code}: not a playback key`);
});

// --- the pause screen in index.html: Echolocation's hint with this piece's keys, the end card's ivory
// (CARD_INK, set by src/ui.js as --ink, never typed in the page) and no trace of Echolocation's cyan
test('the pause screen: the hint names every control; its ivory is CARD_INK through --ink, not typed', () => {
  const hint = /<div id="hint">([^<]*)<\/div>/.exec(html);
  assert.ok(hint, 'index.html has #hint');
  assert.equal(hint[1], 'Tap or Space: play / pause \u00b7 Double-tap left / right or \u2190 / \u2192: 5 s \u00b7 , / . : cello note \u00b7 Drag the bar: jump');
  for (const id of ['controls', 'over', 'msg', 'ctl', 'bar', 'track', 'fill', 'knob', 'time', 'seekfx']) assert.ok(html.includes(`id="${id}"`), `#${id}`);
  assert.deepEqual(CARD_INK_RGB, hexRGB(CARD_INK).map((v) => Math.round(v * 255)), "CARD_INK_RGB is CARD_INK's channels");
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(/var\(--ink\)/.test(css), 'the styles take the ivory from --ink');
  const hex = CARD_INK.replace('#', '').toLowerCase();
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  assert.ok(!css.toLowerCase().includes(hex), 'CARD_INK is not typed in the page');
  assert.ok(!new RegExp(rgb.join('[ ,]+')).test(css), 'nor its channels');
  assert.ok(!/150,\s*255,\s*240/.test(css), "nor Echolocation's cyan");
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DUR } from '../src/music.js';
import { createClock } from '../src/clock.js';
import { CARD_LEN, VIDEO_END } from '../src/card.js';
import { clampT } from '../src/timeline.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const playing = (time) => ({ time, paused: false, ended: false });
const ended = (time) => ({ time, paused: true, ended: true });
// the tests that time the clock in the end card after the audio use a 3 s card of their own; the
// page's, CARD_LEN, is timed in its own test below
const AFTER = 3;

test('while the audio plays: its position, smoothed by at most 0.1 s between updates', () => {
  const c = createClock(DUR, CARD_LEN);
  assert.equal(c.read(playing(12.5), 1000), 12.5);
  near(c.read(playing(12.5), 1050), 12.55);
  near(c.read(playing(12.5), 1300), 12.6);
  assert.equal(c.atEnd(), false);
  assert.equal(c.inCard(), false);
});

// the smoothing ran past dur before the audio's ended event came, then snapped back to dur: the end
// card's cut and its text showed for a frame and went
test("the smoothed time stops at dur until the audio has ended, so the end card never shows early", () => {
  const c = createClock(DUR, CARD_LEN);
  const times = [c.read(playing(DUR - 0.03), 1000)];
  for (const ms of [1020, 1050, 1080, 1100]) times.push(c.read(playing(DUR - 0.03), ms));
  times.push(c.read(ended(DUR - 0.01), 1110));
  times.push(c.read(ended(DUR - 0.01), 1300));
  for (let k = 0; k < 5; k++) assert.ok(times[k] <= DUR, `${times[k]} before the audio ended`);
  near(times[3], DUR);
  for (let k = 1; k < times.length; k++) assert.ok(times[k] >= times[k - 1], `went back: ${times.join(', ')}`);
  near(times[6], DUR + 0.19);
  // audio that itself reports a time past dur (a file a little longer) is followed as it is
  c.reset();
  assert.equal(c.read(playing(DUR + 0.02), 2000), DUR + 0.02);
  assert.equal(c.read(playing(DUR + 0.02), 2050), DUR + 0.02);
});

test('paused audio: its position as it is, and toggle is left to the caller', () => {
  const c = createClock(DUR, CARD_LEN);
  const a = { time: 5, paused: true, ended: false };
  assert.equal(c.read(a, 1000), 5);
  assert.equal(c.read(a, 1500), 5);
  assert.equal(c.toggle(1500), false);
});

test('after the audio ends the page clock runs on and stops at dur + its time after the audio', () => {
  const c = createClock(DUR, AFTER);
  assert.equal(c.read(ended(47.1), 100000), 47.1);
  near(c.read(ended(47.1), 101000), 48.1);
  assert.equal(c.atEnd(), false);
  assert.equal(c.read(ended(47.1), 105000), DUR + AFTER);
  assert.equal(c.atEnd(), true);
  assert.equal(c.toggle(105000), false);
});

// the page's clock (main.js: createClock(DUR, CARD_LEN)) runs the end card after the audio on its own
// and stops at the video's end, where clampT stops the drawn time
test("the page's clock: from the audio's end on the page clock through the end card, to VIDEO_END", () => {
  const c = createClock(DUR, CARD_LEN);
  assert.equal(c.read(ended(47.1), 100000), 47.1);
  near(c.read(ended(47.1), 100000 + (VIDEO_END - 1 - 47.1) * 1000), VIDEO_END - 1);
  assert.equal(c.atEnd(), false, 'the card has not ended');
  assert.equal(c.read(ended(47.1), 110000), VIDEO_END);
  assert.equal(c.atEnd(), true);
  assert.equal(c.toggle(110000), false);
  assert.equal(clampT(c.read(ended(47.1), 130000)), VIDEO_END);
  assert.equal(clampT(99), VIDEO_END);
});

test('audio that ends a little short of dur never makes the time go back', () => {
  const c = createClock(DUR, CARD_LEN);
  assert.ok(c.read(ended(47.05), 100000) >= DUR);
});

test('after the audio, toggle pauses and resumes', () => {
  const c = createClock(DUR, AFTER);
  c.read(ended(47.1), 100000);
  assert.equal(c.toggle(101000), true);
  near(c.read(ended(47.1), 103000), 48.1);
  assert.equal(c.toggle(103000), true);
  near(c.read(ended(47.1), 104000), 49.1);
});

test('startAt runs the clock from a still after the audio, without any audio', () => {
  const c = createClock(DUR, AFTER);
  c.startAt(48.0, 0);
  assert.equal(c.inCard(), true);
  assert.equal(c.running(), true);
  near(c.read(playing(0), 1000), 49.0);
  assert.equal(c.read(playing(0), 9000), DUR + AFTER);
  assert.equal(c.atEnd(), true);
  assert.equal(c.running(), false, 'at its end the card has stopped');
});

// a seek into the end card while paused shows that frame and stays paused; a toggle runs it from there
test('startAt paused: the card stands at t0 until toggled, then runs from it', () => {
  const c = createClock(DUR, AFTER);
  c.startAt(48.0, 0, true);
  assert.equal(c.inCard(), true);
  assert.equal(c.running(), false);
  assert.equal(c.read(ended(47.1), 5000), 48.0);
  assert.equal(c.toggle(5000), true);
  assert.equal(c.running(), true);
  near(c.read(ended(47.1), 6000), 49.0);
  c.startAt(60, 6000, true);
  assert.equal(c.read(ended(47.1), 7000), DUR + AFTER, 'never past its end');
});

test('reset follows the audio position again', () => {
  const c = createClock(DUR, CARD_LEN);
  c.read(ended(47.1), 100000);
  assert.equal(c.inCard(), true);
  c.read(ended(47.1), 110000);
  c.reset();
  assert.equal(c.atEnd(), false);
  assert.equal(c.inCard(), false);
  assert.equal(c.read(playing(0), 111000), 0);
  assert.equal(c.toggle(111000), false);
});

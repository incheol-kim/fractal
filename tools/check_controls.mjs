// The page's playback controls (src/ui.js, src/controls.js, src/main.js), driven the way a person
// drives them and each one read back from the page.
//
//   node tools/check_controls.mjs [--w=1920] [--h=1080] [--shots=<folder under local-only/temp/>]
//
// Run it at 1920 x 1080 (the default) and once more as a phone held upright: --w=390 --h=844 (the
// 16:9 picture is then a 390 x 219 strip). Starts its own Vite dev server on port 5199 and one
// headless Edge on the page with no address options (tools/browser.mjs), sends keys and mouse
// events over CDP (Input.dispatchKeyEvent, Input.dispatchMouseEvent) and reads back the audio
// element (currentTime, paused, ended), the timeline's knob (its place is the page's time, also in
// the end card) and label, the centre line, the pause screen's class and opacity, the seek bubble,
// the hidden cursor and any banner. It covers space, the arrows, comma and period (paused, playing,
// held, with an input method's key, with Ctrl / Alt), taps on the thirds, the timeline (tap and a
// captured drag), the end card after the audio (seeking into it, playing it without sound to its
// end, playing again from the start), the audio ending while playing, and a #t= still. The audio
// plays in real time (the run takes about a minute). Each check prints PASS or FAIL with what it
// read; the last line is PASS or FAIL (exit 0 or 1).
// --shots also writes full-page screenshots (Page.captureScreenshot: the page as shown, not the
// canvas) of the moments worth looking at, <folder>/<name>.png: first, playing, paused20, right2,
// note, drag_middle, card_paused, end, t20.
import fs from 'node:fs';
import path from 'node:path';
import { root, arg, sleep, startServer, openBrowser, PORT } from './browser.mjs';
import { inTemp } from './paths.mjs';
import { VIDEO_END } from '../src/card.js';
import { DUR } from '../src/music.js';
import { END_GAP } from '../src/controls.js';

const W = Math.round(Number(arg('w', 1920)));
const H = Math.round(Number(arg('h', 1080)));
const SHOTS = arg('shots', '');
const unknown = process.argv.slice(2).filter((a) => !/^--(w|h|shots)=/.test(a));
const shotsDir = SHOTS ? path.resolve(root, SHOTS) : null;
if (!(W > 0 && H > 0) || unknown.length || (shotsDir && !inTemp(shotsDir))) {
  console.error('usage: node tools/check_controls.mjs [--w=1920] [--h=1080] [--shots=<folder under local-only/temp/>]');
  process.exit(2);
}
const onsets = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'music.json'), 'utf8')).cello.map((n) => n[0]);
const N = onsets.length;
const PLAY_FAILED = 'Could not play the audio'; // main.js's banner when a play fails

const KEYS = { Space: [' ', 32], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], Comma: [',', 188], Period: ['.', 190] };
const MOD = { alt: 1, ctrl: 2 };
// a key pressed (and released, unless it is an auto-repeat); key / keyCode override the key's own
async function key(B, code, { repeat = false, modifiers = 0, key: k, keyCode } = {}) {
  const [kk, kc] = KEYS[code];
  const p = { code, key: k ?? kk, windowsVirtualKeyCode: keyCode ?? kc, nativeVirtualKeyCode: keyCode ?? kc, modifiers };
  await B.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: repeat, ...p });
  if (!repeat) await B.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
}
const mouse = (B, type, x, y, more = {}) => B.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...more });
async function click(B, x, y, clickCount = 1) {
  await mouse(B, 'mouseMoved', x, y, { button: 'none' });
  await mouse(B, 'mousePressed', x, y, { clickCount });
  await mouse(B, 'mouseReleased', x, y, { clickCount });
}
// what the page shows: cur, paused, ended (the audio), t (the knob's place as a time), label, msg,
// shown (the pause screen), opacity, fx and fxOn (the bubble), cursorHidden, failed (a banner saying a
// play failed)
const STATE = `(() => {
  const a = document.getElementById('audio'), $ = (id) => document.getElementById(id), over = $('over');
  return { cur: +a.currentTime.toFixed(4), paused: a.paused, ended: a.ended,
    t: +((parseFloat($('knob').style.left) || 0) / 100 * ${VIDEO_END}).toFixed(4), knob: $('knob').style.left,
    label: $('time').textContent, msg: $('msg').textContent, shown: !over.classList.contains('hide'),
    opacity: +getComputedStyle(over).opacity, fx: $('seekfx').textContent, fxOn: $('seekfx').classList.contains('on'),
    cursorHidden: document.body.classList.contains('playing'),
    failed: [...document.body.children].some((el) => el.textContent.includes(${JSON.stringify(PLAY_FAILED)})) };
})()`;
const state = (B) => B.ev(STATE);
const rectOf = (B, id) => B.ev(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const near = (a, b, e) => Math.abs(a - b) <= e;

let failed = 0;
let passed = 0;
function check(ok, what, s) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (ok) passed++;
  else {
    failed++;
    if (s) console.log(`  read: ${JSON.stringify(s)}`);
  }
}
async function shot(B, name) {
  if (!shotsDir) return;
  const r = await B.send('Page.captureScreenshot', { format: 'png' }, 60000);
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(r.data, 'base64'));
}

async function run(B) {
  for (let i = 0; i < 100 && (await B.ev('document.getElementById("audio").readyState')) < 1; i++) await sleep(100);
  const box = await rectOf(B, 'controls');
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.4;
  console.log(`window ${W}x${H}: the controls' box ${box.w}x${box.h} at ${box.x},${box.y}`);
  await sleep(300);

  // the untouched first screen
  let s = await state(B);
  check(s.msg === 'Fractal' && s.shown && s.label === '0:00 / 0:52' && s.knob === '0%', 'first screen: "Fractal", the pause screen, 0:00 / 0:52, the knob at 0', s);
  await shot(B, 'first');

  // space plays (the pause screen fades out over 0.6 s, the cursor hides) and pauses
  await key(B, 'Space');
  await sleep(300);
  const mid = await state(B);
  await sleep(1200);
  s = await state(B);
  check(!s.paused && s.cur > 0.8 && mid.opacity > 0 && mid.opacity < 1 && !s.shown && s.opacity === 0 && s.cursorHidden, `space plays: audio at ${s.cur}, the pause screen at opacity ${mid.opacity} after 0.3 s and 0 after 1.5 s, the cursor hidden`, s);
  check(near(s.t, s.cur, 0.25), `the knob follows the time while playing (${s.t}, audio ${s.cur})`, s);
  await shot(B, 'playing');
  await key(B, 'Space');
  await sleep(700);
  s = await state(B);
  check(s.paused && s.shown && s.msg === 'Paused' && !s.cursorHidden, 'space pauses: "Paused", the cursor back', s);

  // the timeline: a tap jumps and does not play
  let tr = await rectOf(B, 'track');
  const by = tr.y + tr.h / 2;
  const barAt = (t) => tr.x + (tr.w * t) / VIDEO_END;
  await click(B, barAt(20.04), by);
  await sleep(400);
  s = await state(B);
  check(s.paused && near(s.cur, 20, 0.1) && s.label === '0:20 / 0:52' && near(s.t, s.cur, 0.01), `a tap on the timeline at 20 s: audio ${s.cur}, paused, 0:20, the knob there`, s);
  await sleep(500);
  await shot(B, 'paused20');

  // the arrows: 5 s, paused; the bubble adds up a run and goes after 0.7 s
  const t0 = s.cur;
  await key(B, 'ArrowRight');
  await sleep(150);
  s = await state(B);
  check(s.paused && near(s.cur, t0 + 5, 1e-3) && s.fx === '5 s »' && s.fxOn, `-> paused: ${t0} -> ${s.cur}, "${s.fx}"`, s);
  await sleep(1000);
  await key(B, 'ArrowRight');
  await key(B, 'ArrowRight');
  await sleep(100);
  s = await state(B);
  check(near(s.cur, t0 + 15, 1e-3) && s.fx === '10 s »', `-> -> : ${s.cur}, the bubble adds up: "${s.fx}"`, s);
  await shot(B, 'right2');
  await sleep(900);
  s = await state(B);
  check(!s.fxOn, 'the bubble goes after 0.7 s', s);
  await key(B, 'ArrowLeft');
  await sleep(100);
  s = await state(B);
  check(near(s.cur, t0 + 10, 1e-3) && s.fx === '« 5 s', `<- paused: ${s.cur}, "${s.fx}"`, s);
  await sleep(900);

  // comma and period, paused: the cello's notes, staying paused
  const tb = s.cur;
  const next = onsets.findIndex((o) => o > tb + 0.02);
  await key(B, 'Period');
  await sleep(150);
  s = await state(B);
  check(s.paused && near(s.cur, onsets[next], 1e-4) && s.fx === `♪ ${next + 1} / ${N} »`, `. paused: ${tb} -> note ${next} at ${onsets[next]} (audio ${s.cur}), paused, "${s.fx}"`, s);
  await shot(B, 'note');
  await key(B, 'Period');
  await sleep(100);
  s = await state(B);
  check(near(s.cur, onsets[next + 1], 1e-4) && s.fx === `♪ ${next + 2} / ${N} »`, `. again: the note after (${s.cur}), "${s.fx}"`, s);
  await key(B, 'Comma');
  await sleep(100);
  s = await state(B);
  check(near(s.cur, onsets[next], 1e-4) && s.fx === `« ♪ ${next + 1} / ${N}`, `, paused: one note back (${s.cur}), "${s.fx}"`, s);
  await key(B, 'Period', { key: 'Process', keyCode: 229 }); // an input method (a Korean one) owns the key
  await sleep(100);
  s = await state(B);
  check(near(s.cur, onsets[next + 1], 1e-4), `. through an input method (key "Process", code Period) still steps (${s.cur})`, s);
  await key(B, 'Period', { repeat: true });
  await key(B, 'Period', { repeat: true });
  await sleep(100);
  s = await state(B);
  check(near(s.cur, onsets[next + 3], 1e-4), `. held (two auto-repeats): two notes on (${s.cur})`, s);
  const tc = s.cur;
  await key(B, 'Period', { modifiers: MOD.ctrl });
  await key(B, 'ArrowRight', { modifiers: MOD.ctrl });
  await key(B, 'ArrowRight', { modifiers: MOD.alt });
  await key(B, 'Space', { modifiers: MOD.ctrl });
  await sleep(100);
  s = await state(B);
  check(s.cur === tc && s.paused, 'Ctrl+. , Ctrl+-> , Alt+-> , Ctrl+space: left to the browser', s);
  await key(B, 'ArrowRight', { repeat: true });
  await sleep(100);
  s = await state(B);
  check(near(s.cur, tc + 5, 1e-3), `-> held (an auto-repeat) seeks (${s.cur})`, s);
  await key(B, 'Space', { repeat: true });
  await sleep(100);
  s = await state(B);
  check(s.paused, 'space held (an auto-repeat) does not play', s);
  await sleep(800);

  // comma and period, playing: playing on from the note
  await key(B, 'Space');
  await sleep(500);
  const tp = (await state(B)).cur;
  const nx = onsets.findIndex((o) => o > tp + 0.02);
  await key(B, 'Period');
  await sleep(30);
  s = await state(B);
  check(!s.paused && s.cur >= onsets[nx] - 1e-4 && s.cur < onsets[nx] + 0.2, `. playing: ${tp} -> note ${nx} at ${onsets[nx]} (audio ${s.cur}), playing`, s);
  await sleep(400);
  s = await state(B);
  check(!s.paused && s.cur > onsets[nx] + 0.2, `and playing on (${s.cur})`, s);
  const tq = s.cur;
  const before = onsets.filter((o) => o < tq - 0.3).length - 1;
  await key(B, 'Comma');
  await sleep(30);
  s = await state(B);
  check(!s.paused && s.cur >= onsets[before] - 1e-4 && s.cur < onsets[before] + 0.15, `, playing at ${tq}: to note ${before} at ${onsets[before]}, the last before t - 0.3 (audio ${s.cur}), playing`, s);

  // taps: a double tap on the right third seeks 5 s and plays on; a lone side tap pauses after a moment;
  // the centre third plays and pauses at once
  await sleep(500);
  const td = (await state(B)).cur;
  await click(B, box.x + box.w * 0.85, cy);
  await sleep(120);
  await click(B, box.x + box.w * 0.85, cy, 2);
  await sleep(80);
  s = await state(B);
  check(!s.paused && near(s.cur, td + 5, 0.4) && s.fx === '5 s »', `a double tap on the right: ${td} -> ${s.cur}, playing, "${s.fx}"`, s);
  await sleep(1200);
  await click(B, box.x + box.w * 0.1, cy);
  await sleep(150);
  const s1 = await state(B);
  await sleep(350);
  s = await state(B);
  check(!s1.paused && s.paused && s.msg === 'Paused', 'a lone tap on the left: playing at 150 ms, paused by 500 ms', s);
  await click(B, cx, cy);
  await sleep(200);
  s = await state(B);
  check(!s.paused, 'a tap in the centre plays', s);
  await click(B, cx, cy);
  await sleep(200);
  s = await state(B);
  check(s.paused, 'a tap in the centre pauses', s);

  // the timeline dragged to the middle, off the bar on the way (the pointer is captured)
  tr = await rectOf(B, 'track');
  await mouse(B, 'mouseMoved', tr.x + tr.w * 0.2, by, { button: 'none' });
  await mouse(B, 'mousePressed', tr.x + tr.w * 0.2, by, { clickCount: 1 });
  const trail = [];
  for (const f of [0.3, 0.4, 0.45, 0.5]) {
    await mouse(B, 'mouseMoved', tr.x + tr.w * f, by - (f === 0.45 ? box.h * 0.3 : 0), { buttons: 1 });
    await sleep(80);
    trail.push((await state(B)).cur);
  }
  await mouse(B, 'mouseReleased', tr.x + tr.w * 0.5, by, { clickCount: 1 });
  await sleep(400);
  s = await state(B);
  check(s.paused && near(s.cur, VIDEO_END / 2, 0.06) && near(trail[2], VIDEO_END * 0.45, 0.06), `a drag to the middle: the time follows (${trail.join(', ')}), off the bar too, ends at ${s.cur}, paused`, s);
  await sleep(300);
  await shot(B, 'drag_middle');
  await click(B, tr.x + tr.w * 0.75, by);
  await sleep(200);
  s = await state(B);
  check(s.paused && near(s.cur, 0.75 * VIDEO_END, 0.06), `the timeline at 3/4: ${s.cur} s`, s);

  // the end card: a seek into it shows its frame, paused; playing it runs without sound to the end,
  // which shows "Fractal"; -> there stays; space plays again from the start
  await click(B, barAt(50.02), by);
  await sleep(300);
  s = await state(B);
  check(s.paused && near(s.t, 50, 0.06) && s.msg === 'Paused' && s.label === '0:50 / 0:52', `the timeline at 50 s: the card's frame at ${s.t}, paused (the audio paused at ${s.cur})`, s);
  await sleep(300);
  await shot(B, 'card_paused');
  await key(B, 'Space');
  await sleep(1000);
  s = await state(B);
  check(s.paused && !s.shown && near(s.t, 51, 0.2), `space in the card: its time runs (${s.t}) with the audio paused`, s);
  await sleep(1600);
  s = await state(B);
  check(s.knob === '100%' && s.label === '0:52 / 0:52' && s.msg === 'Fractal' && s.shown, 'the card runs out: 0:52 / 0:52, the pause screen with "Fractal"', s);
  await sleep(500);
  await shot(B, 'end');
  await key(B, 'ArrowRight');
  await sleep(100);
  s = await state(B);
  check(s.knob === '100%' && s.fx === '0 s »', `-> at the end: no move ("${s.fx}")`, s);
  await sleep(800);
  await key(B, 'Space');
  await sleep(600);
  s = await state(B);
  check(!s.paused && s.cur > 0.2 && s.cur < 1.2, `space after the end plays from the start (${s.cur})`, s);

  // playing: -> into the card runs on without sound; <- then -> at once (a play cut short by the seek
  // into the card) is not a failure; <- plays the audio again
  await click(B, cx, cy);
  await sleep(200);
  await click(B, barAt(44.5), by);
  await sleep(200);
  await key(B, 'Space');
  await sleep(300);
  await key(B, 'ArrowRight');
  await sleep(500);
  s = await state(B);
  check(s.t > DUR + 2.5 && !s.shown && s.paused, `-> playing into the card: it runs on (${s.t}) with the audio paused`, s);
  await key(B, 'ArrowLeft');
  await key(B, 'ArrowRight');
  await sleep(300);
  s = await state(B);
  check(s.t > DUR && !s.shown && s.paused && !s.failed, `<- -> at once from the running card: in the card again (${s.t}), no "could not play" banner`, s);
  await key(B, 'ArrowLeft');
  await sleep(300);
  s = await state(B);
  check(!s.paused && s.cur < DUR && s.cur > 44, `<- from the running card: the audio plays again (${s.cur})`, s);
  await key(B, 'Space');
  await sleep(100);
  for (let k = 0; k < 3; k++) await key(B, 'ArrowRight');
  await sleep(150);
  s = await state(B);
  check(s.paused && near(s.t, VIDEO_END - END_GAP, 0.001) && s.msg === 'Paused', `-> paused to the end: the last frame, VIDEO_END - ${END_GAP} (${s.t}), "${s.fx}"`, s);
  await key(B, 'Comma');
  await sleep(150);
  s = await state(B);
  check(s.paused && near(s.cur, onsets[N - 1], 1e-4) && s.fx === `« ♪ ${N} / ${N}`, `, from the card: the last cello note (${s.cur}), "${s.fx}"`, s);
  await key(B, 'Period');
  await sleep(100);
  const sp = await state(B);
  check(sp.cur === s.cur && sp.fx === s.fx, '. after the last note: no move, no new bubble', sp);
  await sleep(500);

  // the audio ends while playing: the card follows with no step back across DUR, never ahead of the
  // audio before it has ended, and no pause screen; <- then plays the audio again (not from the start)
  check(s.shown, 'paused, the timeline on the pause screen', s);
  await click(B, barAt(46.3), by);
  await sleep(200);
  await key(B, 'Space');
  const seq = [];
  for (let k = 0; k < 45; k++) {
    seq.push(await state(B));
    await sleep(40);
  }
  const back = seq.filter((x, k) => k && seq[k - 1].t > DUR - 0.15 && x.t < seq[k - 1].t - 1e-3);
  const ahead = seq.filter((x) => x.t > DUR + 1e-4 && !x.ended && x.cur <= DUR);
  const cross = seq.filter((x) => x.t > DUR - 0.1 && x.t < DUR + 0.2).map((x) => `${x.t}${x.ended ? ' (ended)' : ''}`);
  check(!back.length && !ahead.length && seq.slice(1).every((x) => !x.shown) && seq[seq.length - 1].t > DUR + 0.5 && seq.some((x) => x.ended),
    `the audio ends while playing: ${cross.join(' -> ')}: ${back.length} steps back, ${ahead.length} ahead of the audio, no pause screen`);
  s = await state(B);
  await key(B, 'ArrowLeft');
  await sleep(300);
  const s3 = await state(B);
  check(!s3.paused && near(s3.cur, s.t - 5 + 0.3, 0.25) && !s3.failed, `<- from the card after the audio ended: ${s.t} -> audio ${s3.cur}, playing`, s3);
  await sleep(300);

  // a #t= still: no pause screen
  await B.send('Page.navigate', { url: `http://localhost:${PORT}/#t=20` });
  await sleep(500);
  for (let i = 0; i < 1200 && !(await B.ev('!!window.FR_READY').catch(() => false)); i++) await sleep(100);
  await sleep(500);
  s = await state(B);
  check(!s.shown && s.opacity === 0 && s.label === '0:20 / 0:52', '#t=20: no pause screen (the timeline under it at 0:20)', s);
  await shot(B, 't20');
  const bad = B.logs.filter((l) => l.startsWith('error') || l.startsWith('exception'));
  check(!bad.length, `no error on the page${bad.length ? `: ${bad.join(' | ')}` : ''}`);
}

const server = await startServer(PORT);
let B = null;
try {
  B = await openBrowser(`http://localhost:${PORT}/`, { w: W, h: H });
  await run(B);
} catch (e) {
  console.error('FAILED: ' + (e && e.stack ? e.stack : e));
  if (B && B.logs.length) console.error('page messages:\n  ' + B.logs.join('\n  '));
  failed++;
} finally {
  if (B) await B.close();
  await server.close();
}
console.log(`${W}x${H}: ${passed} checks passed, ${failed} failed${shotsDir ? `; screenshots in ${path.relative(root, shotsDir)}` : ''}`);
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);

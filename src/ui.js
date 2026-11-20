// The playback controls over the canvas (index.html #controls), after Echolocation's
// (its src/js/50-app.js SR.app: onTap, the timeline's drag, showTime, the keys,
// the seek bubble): the pause screen (a centre line, the hint and the timeline) while nothing plays,
// fading out over 0.6 s when playing starts, the cursor hidden while playing. Taps, the timeline and
// the keys call back; this module never touches the audio or the clock (main.js does). HTML over the
// canvas, never in its pixels.
//   createUI({ stage, onToggle, onSeek(dir), onSeekTo(t), onNote(dir), getState: () => ({ playing }) })
//   -> { setPlaying(p), showTime(t), setMessage(text), flash(text, side 'L' | 'R'), setExporting() }
// setExporting: a still (#t=, renderFrame: the tools' path) has no pause screen; it goes at once, with
// no fade, until setPlaying is called again. setPlaying and setExporting may be called every frame
// (they change the page only when what is shown changes).
import { tapControl, keyAction, fmtTime } from './controls.js';
import { VIDEO_END, CARD_INK_RGB, CARD_FONT } from './card.js';

export function createUI({ stage, onToggle, onSeek, onSeekTo, onNote, getState }) {
  const $ = (id) => stage.querySelector(`#${id}`);
  const [over, msg, bar, track, fill, knob, timeLabel, seekfx] = ['over', 'msg', 'bar', 'track', 'fill', 'knob', 'time', 'seekfx'].map($);
  // the end card's ivory and face, defined once (card.js); the styles take them from here
  stage.style.setProperty('--ink', CARD_INK_RGB.join(' '));
  stage.style.setProperty('--title-font', `"${CARD_FONT.family}"`);
  over.classList.add('ready');

  const act = (list) => {
    for (const a of list) {
      if (a.type === 'toggle') onToggle();
      else if (a.type === 'seek') onSeek(a.dir);
      else if (a.type === 'note') onNote(a.dir);
    }
  };

  // taps and clicks: the centre third plays or pauses, a double tap on a side seeks (controls.js
  // tapControl); timed from when the finger or button came up (a heavy frame can delay the click
  // itself, which would spoil a double tap's timing)
  const taps = tapControl();
  let lastUp = -1e9;
  addEventListener(
    'pointerup',
    (e) => {
      lastUp = e.timeStamp;
    },
    true,
  );
  stage.addEventListener('click', (e) => {
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const nowMs = performance.now();
    const at = nowMs - lastUp < 1000 ? lastUp : nowMs;
    act(taps.tap(x < 1 / 3 ? 'L' : x > 2 / 3 ? 'R' : 'C', at / 1000, getState().playing));
    setTimeout(() => act(taps.tick(performance.now() / 1000)), 320); // a lone side tap pauses
  });

  // the timeline: drag (or tap) to jump; the picture follows while dragging; a tap on it never plays
  const fracAt = (e) => {
    const r = track.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  };
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    onSeekTo(fracAt(e) * VIDEO_END);
    e.stopPropagation();
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      // drags on without capture
    }
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragging) onSeekTo(fracAt(e) * VIDEO_END);
  });
  bar.addEventListener('pointerup', (e) => {
    dragging = false;
    e.stopPropagation();
  });
  bar.addEventListener('pointercancel', () => {
    dragging = false;
  });
  bar.addEventListener('click', (e) => e.stopPropagation());

  // the keys (controls.js keyAction); others are left to the browser and to main.js
  addEventListener('keydown', (e) => {
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    act([a]);
  });

  let mode = ''; // 'play', 'pause' or 'still', as shown
  let fxTimer = 0;
  let shownFill = '';
  let shownTime = '';
  const ui = {
    // -> true when this changed what is shown
    setPlaying(p) {
      const m = p ? 'play' : 'pause';
      if (m === mode) return false;
      if (mode === 'still') over.style.transition = '';
      mode = m;
      document.body.classList.toggle('playing', p);
      over.classList.toggle('hide', p);
      return true;
    },
    // the knob, the fill and 'm:ss / 0:52' at the page's time t, over the whole video
    showTime(t) {
      const f = `${(100 * Math.min(Math.max(t / VIDEO_END, 0), 1)).toFixed(3)}%`;
      if (f !== shownFill) {
        fill.style.width = f;
        knob.style.left = f;
        shownFill = f;
      }
      const label = `${fmtTime(t)} / ${fmtTime(VIDEO_END)}`;
      if (label !== shownTime) {
        timeLabel.textContent = label;
        shownTime = label;
      }
    },
    setMessage(text) {
      msg.textContent = text;
    },
    // the bubble on the left or the right for a moment (consecutive seeks say how far they went)
    flash(text, side) {
      seekfx.textContent = text;
      seekfx.className = `on ${side}`;
      clearTimeout(fxTimer);
      fxTimer = setTimeout(() => {
        seekfx.className = side;
      }, 700);
    },
    setExporting() {
      if (mode === 'still') return;
      mode = 'still';
      over.style.transition = 'none';
      over.classList.add('hide');
      document.body.classList.remove('playing');
    },
  };
  return ui;
}

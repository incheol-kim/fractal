// The playback controls' logic, after the owner's previous piece, Echolocation
// (its src/js/50-app.js: SR.tapControl, SR.seekTarget, SR.seekRun, SR.fmtTime),
// with steps by cello note. Pure: no DOM, no time source, no layer. Times in seconds; the caller
// passes them in. src/ui.js turns taps and keys into these actions, main.js carries them out.

// seconds a seek moves (the arrows, a double tap on a side)
export const SEEK = 5;

// Taps and clicks on the picture, the same for mouse, touch and pen (phones have no arrow keys). Centre
// third: play/pause at once. Left/right thirds while playing: a double tap seeks 5 s back/on and every
// further tap on that side within the streak seeks 5 s more, as on video sites; a single side tap
// pauses after a short wait. While paused every tap plays at once (browsers only start audio straight
// from the gesture), except a tap that continues a seek streak: a streak that ran into the end (where
// playback stops) must stay there, not play again from 0:00. tick(t) gives the waiting tap's pause.
export function tapControl(wait = 0.28, streak = 0.7, step = SEEK) {
  let pend = null; // a side tap waiting for a second one
  let run = null; // the current seek streak
  return {
    tap(zone, t, playing) {
      const dir = zone === 'L' ? -1 : zone === 'R' ? 1 : 0;
      if (dir && run && run.dir === dir && t - run.t <= streak) {
        run.t = t;
        return [{ type: 'seek', dt: dir * step, dir }];
      }
      if (!playing || !dir) {
        pend = null;
        run = null;
        return [{ type: 'toggle' }];
      }
      if (pend && pend.dir === dir && t - pend.t <= wait) {
        pend = null;
        run = { dir, t };
        return [{ type: 'seek', dt: dir * step, dir }];
      }
      run = null;
      pend = { dir, t };
      return [];
    },
    tick(t) {
      if (run && t - run.t > streak) run = null;
      if (pend && t - pend.t > wait) {
        pend = null;
        return [{ type: 'toggle' }];
      }
      return [];
    },
  };
}

// seconds before the video's end where a seek stops: its last frame (Echolocation's)
export const END_GAP = 0.05;

// Where a seek of dt seconds from cur lands in a video that ends at end: never before the start or past
// its last frame (end - END_GAP), and never the wrong way (at the very end the time is past that frame).
export function seekTarget(cur, dt, end) {
  const t = Math.min(Math.max(cur + dt, 0), end - END_GAP);
  return dt > 0 ? Math.max(t, cur) : Math.min(t, cur);
}

// Whether a seek to t lands in the audio (its position moves) or, false, in the end card after it (the
// page's clock runs on its own). The audio ends at dur (DUR), or at the audio element's own duration
// when that is shorter; before the element knows its duration (NaN, 0, Infinity), at dur.
export function inAudio(t, dur, mediaDur) {
  const end = Number.isFinite(mediaDur) && mediaDur > 0 ? Math.min(dur, mediaDur) : dur;
  return t < end;
}

// The seconds shown for a run of seeks the same way ('« 10 s'): only the time actually moved, so it
// stops growing at the start and the end. A new direction or a pause of more than `streak` seconds
// starts a new count.
export function seekRun(streak = 0.7) {
  let run = null;
  return {
    add(dir, moved, t) {
      if (run && run.dir === dir && t - run.t <= streak) run.total += Math.abs(moved);
      else run = { dir, total: Math.abs(moved) };
      run.t = t;
      return run.total;
    },
  };
}

// 'm:ss'
export function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// A step by cello note from t -> { t, i } (the note's start and its number, from 0) or null (no move).
// onsets: the notes' starts, ascending. Back (dir -1): the last note that started before t - 0.02 s
// paused, before t - 0.3 s playing (a press while playing goes to the note before the one just
// passed, not to that one), else the start ({ t: 0, i: -1 }). On (dir 1): the first note that starts
// after t + 0.02 s, else null.
export function noteStep(onsets, t, dir, playing) {
  if (dir < 0) {
    const before = t - (playing ? 0.3 : 0.02);
    let i = -1;
    while (i + 1 < onsets.length && onsets[i + 1] < before) i++;
    return i < 0 ? { t: 0, i: -1 } : { t: onsets[i], i };
  }
  const i = onsets.findIndex((on) => on > t + 0.02);
  return i < 0 ? null : { t: onsets[i], i };
}

// The feedback bubble: '« 10 s' / '5 s »' (seconds moved), '« ♪ 12 / 97' / '♪ 13 / 97 »' (the note
// gone to, counted from 1 of n; 0 is the start, before the first note).
export const seekText = (dir, secs) => (dir < 0 ? `\u00ab ${secs} s` : `${secs} s \u00bb`);
export const noteText = (dir, i, n) => (dir < 0 ? `\u00ab \u266a ${i + 1} / ${n}` : `\u266a ${i + 1} / ${n} \u00bb`);

// A key ({ code, repeat, ctrlKey, altKey, metaKey } of a keydown) -> its action, or null (left to the
// browser, or to main.js's own keys). Space plays or pauses (a held key once); the arrows seek and
// comma / period step by cello note, held keys repeating. By e.code, the key's place, so comma and
// period work in any layout and input mode (a Korean one too). With Ctrl, Alt or Meta, none.
const MOVES = new Map([
  ['ArrowLeft', ['seek', -1]],
  ['ArrowRight', ['seek', 1]],
  ['Comma', ['note', -1]],
  ['Period', ['note', 1]],
]);
export function keyAction({ code, repeat, ctrlKey, altKey, metaKey }) {
  if (ctrlKey || altKey || metaKey) return null;
  if (code === 'Space') return repeat ? null : { type: 'toggle' };
  const m = MOVES.get(code);
  return m ? { type: m[0], dir: m[1] } : null;
}

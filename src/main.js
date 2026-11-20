// Page: loads the material, draws the frame for the audio's time, and offers the address options.
// The page's time: the picture to the audio's end (DUR, 47.08 s), then the end card (src/card.js):
// the screen cuts to black and "Fractal" and "Incheol Kim" come and go in ivory with Echolocation's
// timing, the page's clock running the card's 5.0 s on its own (the audio has ended); it stops at
// the video's end (VIDEO_END, 52.08 s). Playing after the end plays from the start.
// The playback controls, Echolocation's (src/ui.js over the canvas, src/controls.js): a tap, a click
// or space plays or pauses; a double tap on the left or right third or the arrows seek 5 s; comma
// and period step to the cello's note before or after; the pause screen's timeline jumps (all of
// the video, the end card too, which plays on without sound).
//   #t=<s>        still frame at that time (any value goes through clampT), with no pause screen;
//                 playing or seeking goes on from there
//   ?w=&h=        fixed canvas size in pixels (the stage is then that size, not 16:9)
//   ?tex=half     half-size pictures (decoded straight to half size; the web set's collage pieces stay
//                 as they were made: half size, but for the punch-in's few at the original's size)
//   ?pieces=      full | web: the set of the collage's pieces (src/collage_set.js), the originals
//                 (assets/collage/) or the JPEG set (assets/collage-web/: half size, but for the
//                 pieces on screen while the camera is pushed in after the strike). Without it the
//                 originals when this copy has them (assets/pieces.json says), else the web set; a set
//                 it does not have is an error, not the other set
//   ?fx=0         no paper texture, grain, gate weave, stroke tremor or piece jitter (nothing moves
//                 with tick12), and no signs of life after the last note (the plate turns into the
//                 key image, as tools/check_final.mjs compares)
//   ?ref=1        the key image alone, covering the stage
//   ?hud=1        frames per second, the GPU name, the collage's strength, cuts and memory
//   ?collage=     calm | mid | high: how often the collage's blocks change their cut (default:
//                 the score's); the keys 1, 2, 3 switch it at once and write it into the address
//                 (a look-test aid; with Ctrl, Alt or Meta, or with ?ref=1, they do nothing)
// window.renderFrame(t) draws time t and resolves when the GPU has finished; then FR_READY is true.
// window.renderFrame(t, { sub, shutter, jitter }) draws the frame at t as the average of sub
// sub-frames (a whole number, 1 by default) over a shutter window of shutter frames at 60 fps (0 to
// 1, 0 by default) that opens forward from t and stops short of the score's cuts (src/subframes.js),
// each shifted by a sub-pixel jitter while jitter is true, the default (renderer.js renderAveraged;
// with jitter false the sub-frames differ in time only, so with shutter 0 they are the plain frame);
// one sub-frame is drawn plainly, and sub 1 with shutter 0 is renderFrame(t). The page's loop draws
// a still again (a resize) with the same sub-frames.
// window.FR_INFO() says what the page draws with: the canvas, the GPU, the render targets' sizes
// (targets; the sub-frame targets' apart, averaging), the collage (its strength, the cuts loaded, their
// GPU size, the set of pieces they came from: collage.set, 'full' or 'web'), and the GPU memory of the
// collage's cuts, of the life map, of the picture in picture's targets, of the end card's text
// texture and of the sub-frame targets (memory, bytes); sub, shutter and jitter, those of the frame
// drawn last.
// window.setStrength(name) switches the collage's strength (false for an unknown name).
import { initMusic, DUR } from './music.js';
import { createClock } from './clock.js';
import { CARD_LEN, CARD_TEXT, CARD_INK_RGB, VIDEO_END } from './card.js';
import { SEEK, END_GAP, seekTarget, seekRun, noteStep, seekText, noteText, inAudio } from './controls.js';
import { createUI } from './ui.js';
import { clampT, frameState, strengths } from './timeline.js';
import { FPS, subFrameTimes, jittersFor, averagingBytes, cutTimes } from './subframes.js';
import { fitStage, gpuNotice, lostNotice, halfHint } from './geometry.js';
import { memoryNotice, lostCollageNotice, decodeNotice, gigabytes, pipBytes } from './collage.js';
import { loadAssets } from './assets.js';
import { createRenderer } from './renderer.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const canvas = $('view');
const notice = $('notice');
const controls = $('controls'); // the playback controls' box over the canvas (src/ui.js)

const q = new URLSearchParams(location.search);
const intParam = (k) => {
  const v = Math.round(Number(q.get(k)));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 16384) : 0;
};
const opts = {
  w: intParam('w'),
  h: intParam('h'),
  tex: q.get('tex') === 'half' ? 'half' : 'full',
  fx: q.get('fx') !== '0',
  ref: q.get('ref') === '1',
  hud: q.get('hud') === '1',
  collage: q.get('collage'),
  pieces: q.get('pieces'), // null when the address has none
};
const fixedSize = opts.w > 0 && opts.h > 0;

// #t=<seconds> -> a time (clampT turns anything odd into a valid one), or null for playback
function hashT() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return h.has('t') ? clampT(parseFloat(h.get('t'))) : null;
}

// text into an element (one inline block, so a flex container keeps it as one paragraph), with
// any http(s) address in it as a link and a line break for each newline
function setText(el, text) {
  const box = document.createElement('span');
  for (const part of String(text).split(/(https?:\/\/\S+|\n)/)) {
    if (part === '\n') {
      box.append(document.createElement('br'));
    } else if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.style.cssText = 'color:#ffd27a;word-break:break-all;';
      box.append(a);
    } else if (part) {
      box.append(part);
    }
  }
  el.replaceChildren(box);
}

// a message over everything, in the page's plain text face (index.html #notice)
function showFatal(msg) {
  setText(notice, msg);
  notice.classList.remove('status');
  notice.style.display = 'flex';
}

// The loading notice: a short status in the end card's face and ivory (index.html #notice.status, its
// own @font-face of the same Geo file, there before anything is loaded). lines: the status, then a
// quieter line under it (or none).
notice.style.setProperty('--ink', CARD_INK_RGB.join(' '));
function showStatus(...lines) {
  const box = document.createElement('span');
  lines.forEach((text, i) => {
    const line = document.createElement('span');
    line.className = i ? 'line quiet' : 'line';
    line.textContent = text;
    box.append(line);
  });
  notice.replaceChildren(box);
  notice.classList.add('status');
  notice.style.display = 'flex';
}

function overlay(css) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;z-index:20;pointer-events:none;font:13px/1.45 system-ui,sans-serif;color:#fff;' + css;
  document.body.appendChild(el);
  return el;
}

// a message over the picture for a few seconds (or until clicked when sticky)
function banner(msg, sticky) {
  const el = overlay(
    'top:12px;left:50%;transform:translateX(-50%);max-width:min(880px,92vw);padding:10px 14px;' +
      'background:rgba(20,18,16,.88);border-radius:6px;pointer-events:auto;cursor:pointer;',
  );
  setText(el, msg);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    el.remove();
  });
  if (!sticky) setTimeout(() => el.remove(), 6000);
  return el;
}

// the mp3 may fail before the pictures have loaded, so this is watched from the start
function audioFailed() {
  const err = audio.error;
  banner(`Could not load the audio file (${audio.currentSrc || audio.src}${err ? `, code ${err.code}` : ''})`, true);
}

// The GPU's name and largest texture from a throwaway WebGL2 context, before anything heavy is
// loaded, so a weak GPU is named (with the half-size link) before a long or failing load.
function probeGPU() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return { name, maxTex };
  } catch {
    return null;
  }
}

// One banner for the GPU notice, filled in again whenever more is known (a banner closed by a
// click stays closed unless the message changes).
const gpu = { name: '', maxTex: NaN, need: NaN, el: null, text: '' };
function updateGpuNotice() {
  const msg = gpuNotice(gpu.name, gpu.maxTex, gpu.need, location.href);
  if (!msg) {
    if (gpu.el) gpu.el.remove();
    gpu.el = null;
    gpu.text = '';
    return;
  }
  if (msg === gpu.text) return;
  gpu.text = msg;
  if (!gpu.el || !gpu.el.isConnected) gpu.el = banner(msg, true);
  else setText(gpu.el, msg);
}

async function start() {
  if (location.protocol === 'file:') return; // index.html already says how to open the page
  if (audio.error) audioFailed();
  else audio.addEventListener('error', audioFailed);
  const probe = probeGPU();
  if (!probe) {
    showFatal('This browser cannot use WebGL2, so the picture cannot be drawn.');
    return;
  }
  Object.assign(gpu, { name: probe.name, maxTex: probe.maxTex });
  updateGpuNotice();
  // the collage's cuts: how many and how much GPU memory (known once the manifest is read), and the set
  // of pieces they come from (known with them: loadAssets's onCollage)
  const collage = { images: 0, bytes: 0, loaded: 0, set: null };
  // a lost context leaves a black canvas: say so, with the GPU and the half-size link, and stop
  // drawing; with the collage's cuts on the GPU memory may be the cause (a sleep or a driver reset
  // loses it too), and the notice says how much they take (and, with the web set, that its pieces
  // are lighter already)
  let lost = false;
  canvas.addEventListener('webglcontextlost', () => {
    lost = true;
    showFatal(collage.bytes > 0 ? lostCollageNotice(collage.bytes, gpu.name, location.href, collage.set) : lostNotice(gpu.name, location.href));
  });

  // the size spelled out (gigabytes()'s "GB" reads as "68" in Geo)
  const loading = () =>
    collage.images
      ? showStatus(`Loading… collage pieces ${collage.loaded} / ${collage.images}`, `about ${(collage.bytes / 2 ** 30).toFixed(1)} gigabytes of graphics memory`)
      : showStatus('Loading…');
  loading();
  let assets;
  try {
    assets = await loadAssets({
      tex: opts.tex,
      pieces: opts.pieces,
      ref: opts.ref,
      onPictureSize: ({ w, h }) => {
        gpu.need = Math.max(Number.isFinite(gpu.need) ? gpu.need : 0, w, h);
        updateGpuNotice();
      },
      onCollage: (c) => {
        Object.assign(collage, c);
        loading();
      },
    });
  } catch (e) {
    if (e.problems) {
      showFatal(`The page’s material does not fit together, so nothing is drawn. The tools that make it (tools/) must be run again:\n${e.problems.join('\n')}`);
    } else if (e.pieces) {
      showFatal(`Cannot choose the set of collage pieces (?pieces=full: the originals, ?pieces=web: the web set):\n${e.message}`);
    } else if (e.cut && e.kind === 'decode') {
      // most likely memory (every cut is decoded before anything is drawn): the size and the half-size link
      showFatal(decodeNotice(e.cut, e.why, collage.bytes, location.href, e.set));
    } else if (e.cut && e.set === 'web') {
      // the web set is what a viewer of the published page gets: a reload asks for the piece again (the
      // set's own words, e.why, without the mend for whoever makes the set)
      showFatal(`A collage piece could not be loaded: ${e.cut}\nThe file may not have arrived: please reload the page.\n(${e.why})`);
    } else if (e.cut) {
      showFatal(`A collage piece is missing or does not match its list: assets/${e.cut}\nIn the repository folder, run .venv\\Scripts\\python.exe tools\\make_collage.py --bake to bake the pieces, then reload.\n(${e.message})`);
    } else {
      const hint = halfHint(location.href);
      showFatal(`Could not load the page’s material: ${e.message}${hint ? `\n${hint}` : ''}`);
    }
    throw e;
  }
  initMusic(assets.music);
  collage.set = assets.collageSet;
  // the end card's font, if it did not load, is drawn in the browser's fallback face: said, not fatal
  if (assets.fontProblem) {
    console.warn(assets.fontProblem);
    banner(`The end card’s font could not be loaded, so it is drawn in the browser’s default font:\n${assets.fontProblem}`, true);
  }

  let R;
  try {
    R = createRenderer(canvas, assets, { fx: opts.fx, ref: opts.ref });
  } catch (e) {
    const hint = halfHint(location.href);
    showFatal(`Cannot draw with WebGL2 (GPU: ${gpu.name}): ${e.message}${hint ? `\n${hint}` : ''}`);
    throw e;
  }
  notice.style.display = 'none';
  const info = R.info(); // the drawing context's own answer (the same GPU as the probe)
  Object.assign(gpu, { name: info.gpu, maxTex: info.maxTex, need: Math.max(assets.key.width, assets.key.height) });
  updateGpuNotice();

  // ---- layout: 16:9 stage letterboxed in the window, size and place in whole device pixels (the
  // CSS box is derived from them, so the canvas is shown 1:1 at any Windows scaling)
  let still = hashT();
  let dirty = true;
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const s = fixedSize
      ? fitStage(window.innerWidth, window.innerHeight, 1, opts.w / opts.h)
      : fitStage(window.innerWidth, window.innerHeight, dpr);
    const box = { position: 'absolute', left: `${s.left}px`, top: `${s.top}px`, width: `${s.cssW}px`, height: `${s.cssH}px` };
    Object.assign(canvas.style, box, { aspectRatio: 'auto' });
    R.resize(fixedSize ? opts.w : s.pxW, fixedSize ? opts.h : s.pxH);
    // the controls lie over the canvas, sized by its height (Echolocation's --u)
    Object.assign(controls.style, box);
    controls.style.setProperty('--u', (s.cssH / 1080).toFixed(4));
    dirty = true;
  }
  window.addEventListener('resize', layout);
  // a change of Windows scaling or a move to another monitor changes devicePixelRatio
  (function watchDpr() {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', () => {
      layout();
      watchDpr();
    }, { once: true });
  })();
  layout();

  // ---- clock: the audio position, then the page's own time through the end card, to the video's
  // end (VIDEO_END, clampT's end)
  const clock = createClock(DUR, CARD_LEN);

  // ---- the collage's strength: ?collage= if it is one of the score's, else the score's default
  // (none with ?ref=1, which draws no collage)
  const names = opts.ref ? [] : strengths(assets.score);
  let strength = names.includes(opts.collage) ? opts.collage : names.length ? assets.score.collage.default : null;
  // the keys 1, 2, 3: calm, mid, high, of those the score has (by name, not by the JSON's key order)
  const keyStrengths = ['calm', 'mid', 'high'].filter((name) => names.includes(name));
  const stateOf = (t) => frameState(t, assets.score, { fx: opts.fx, strength });

  // ---- sub-frames (renderFrame's { sub, shutter, jitter }): never across the score's cuts. PLAIN,
  // one at the frame's own time, is how the page draws everything else; stillSub, how renderFrame's
  // still is drawn (again too, by the loop); drawnSub, how the frame on the canvas was (FR_INFO)
  const cuts = cutTimes(assets.score);
  const PLAIN = { sub: 1, shutter: 0, jitter: true };
  let stillSub = PLAIN;
  let drawnSub = PLAIN;

  let drawnT = -1;
  let frames = 0;
  let cpuMs = 0;
  // t with the sub-frames o; sub-frames that cannot be averaged here throw before anything is drawn or
  // noted (renderer.js renderAveraged)
  function draw(t, o = PLAIN) {
    const t0 = performance.now();
    const ts = subFrameTimes(t, o.sub, FPS, o.shutter, cuts);
    if (ts.length === 1) R.render(stateOf(ts[0]));
    else R.renderAveraged(ts.map(stateOf), jittersFor(ts.length, o.jitter));
    cpuMs += performance.now() - t0;
    frames++;
    drawnT = t;
    drawnSub = o;
    dirty = false;
  }

  // ---- HUD
  const hud = opts.hud ? overlay('left:8px;bottom:8px;padding:4px 8px;background:rgba(0,0,0,.6);font-family:ui-monospace,monospace;white-space:pre;') : null;
  let hudFrames = 0;
  let hudCpu = 0;
  let hudLast = performance.now();
  let hudNow = false; // refresh at the next frame (a change of strength), not only every 500 ms
  function updateHud(now) {
    if (!hud || (!hudNow && now - hudLast < 500)) return;
    hudNow = false;
    const df = frames - hudFrames;
    const fps = (df * 1000) / (now - hudLast);
    const ms = df ? (cpuMs - hudCpu) / df : 0;
    const i = R.info();
    hud.textContent =
      `${fps.toFixed(1)} fps  ${ms.toFixed(2)} ms cpu  t=${drawnT.toFixed(3)}\n` +
      `${i.width}x${i.height}  msaa ${i.samples}  ${i.calls} draws\n` +
      (strength ? `collage ${strength}  ${collage.images} cuts  ${gigabytes(collage.bytes)}  tex ${opts.tex}  pieces ${collage.set}\n` : '') +
      i.gpu;
    hudFrames = frames;
    hudCpu = cpuMs;
    hudLast = now;
  }

  function tick(now) {
    if (lost) {
      if (hud) hud.remove();
      return;
    }
    const t = pageT(now);
    if (t !== drawnT || dirty) draw(t, still === null ? PLAIN : stillSub);
    syncControls(t);
    updateHud(now);
    requestAnimationFrame(tick);
  }

  window.addEventListener('hashchange', () => {
    clock.reset();
    still = hashT();
    stillSub = PLAIN;
    dirty = true;
  });

  // ---- playback. The page's time: a still's, else the end card's clock after the audio, else the
  // audio's position (one chosen before the audio has its metadata is held until it takes it: some
  // phones load none before the first play)
  let want = null;
  const audioPos = () => (want !== null && audio.readyState < 1 ? want : audio.currentTime);
  audio.addEventListener('loadedmetadata', () => {
    if (want !== null) audio.currentTime = want;
  });
  audio.addEventListener('seeked', () => {
    want = null;
  });
  function setAudio(t) {
    want = t;
    try {
      audio.currentTime = t;
    } catch {
      // taken on loadedmetadata
    }
  }
  function pageT(now = performance.now()) {
    return still !== null ? still : clampT(clock.read({ time: audioPos(), paused: audio.paused, ended: audio.ended }, now));
  }
  const playing = () => still === null && (clock.inCard() ? clock.running() : !audio.paused);
  // a play interrupted by a pause (a quick seek into the end card) rejects with AbortError: not a failure
  const play = () =>
    audio.play().catch((e) => {
      if (e.name !== 'AbortError') banner(`Could not play the audio: ${e.message}`);
    });

  // to t (0 .. VIDEO_END - END_GAP), leaving a still: in the audio (controls.js inAudio) its position,
  // playing on if the page played (from the end card, where the audio had ended, the audio plays
  // again); in the end card the clock from t without sound (the audio paused at its end), running if
  // the page played
  function goTo(t) {
    const to = Math.min(Math.max(t, 0), VIDEO_END - END_GAP);
    const run = playing();
    still = null;
    if (inAudio(to, DUR, audio.duration)) {
      clock.reset();
      setAudio(to);
      if (run && audio.paused) play();
      else if (!run && !audio.paused) audio.pause();
    } else {
      audio.pause();
      setAudio(audio.duration || DUR);
      clock.startAt(to, performance.now(), !run);
    }
    dirty = true;
  }

  // play / pause; after the end, from the start; a still, from its time
  function toggle() {
    if (clock.atEnd()) goTo(0);
    else if (still !== null) goTo(still);
    if (clock.toggle(performance.now())) return; // in the end card: its own clock
    if (audio.paused) play();
    else audio.pause();
  }
  // a seek of the controls, and "Paused" if nothing plays (the title is for the untouched first
  // screen and the very end)
  function seekTo(t) {
    goTo(t);
    if (!playing()) ui.setMessage('Paused');
  }
  // 5 s back or on; the bubble says how far a run of them went
  const runs = seekRun();
  function seekBy(dir) {
    const cur = pageT();
    const to = seekTarget(cur, dir * SEEK, VIDEO_END);
    if (to !== cur) seekTo(to);
    ui.flash(seekText(dir, Math.round(runs.add(dir, to - cur, performance.now() / 1000))), dir < 0 ? 'L' : 'R');
  }
  // to the cello's note before or after (controls.js noteStep); the bubble gives its number
  const onsets = assets.music.cello.map((n) => n[0]);
  function stepNote(dir) {
    const to = noteStep(onsets, pageT(), dir, playing());
    if (!to) return;
    seekTo(to.t);
    ui.flash(noteText(dir, to.i, onsets.length), dir < 0 ? 'L' : 'R');
  }

  // the controls over the canvas (src/ui.js); with ?ref=1 nothing plays
  const live = (fn) => (...a) => {
    if (!opts.ref) fn(...a);
  };
  const ui = createUI({ stage: controls, onToggle: live(toggle), onSeek: live(seekBy), onSeekTo: live(seekTo), onNote: live(stepNote), getState: () => ({ playing: playing() }) });
  // the controls at the page's time t: no pause screen over a still (#t=, renderFrame: the tools'
  // path) or with ?ref=1; else it shows while nothing plays, with the title on the untouched first
  // screen and at the very end, "Paused" otherwise; the timeline follows t
  function syncControls(t) {
    ui.showTime(t);
    if (still !== null || opts.ref) return ui.setExporting();
    const p = playing();
    if (ui.setPlaying(p) && !p) ui.setMessage(t > 0.1 && !clock.atEnd() ? 'Paused' : CARD_TEXT.title);
  }

  // ---- the collage's strength, switched while the page runs: drawn from the next frame on, written
  // into the address (?collage=, hash kept) so a reload keeps it
  function setStrength(name) {
    if (!names.includes(name)) return false;
    strength = name;
    dirty = true;
    hudNow = true; // the HUD says so at once
    const u = new URL(location.href);
    u.searchParams.set('collage', name);
    history.replaceState(history.state, '', u);
    return true;
  }
  window.setStrength = setStrength;

  // the keys 1, 2, 3 (the playback keys are src/ui.js's)
  window.addEventListener('keydown', (e) => {
    if (e.repeat || opts.ref || e.ctrlKey || e.altKey || e.metaKey) return; // a held key acts once
    if (['1', '2', '3'].includes(e.key)) {
      const name = keyStrengths[Number(e.key) - 1];
      if (name) setStrength(name);
    }
  });
  // ---- stills for tools/shot.mjs and the video export. A lost context draws nothing, so then
  // renderFrame rejects (an exporter would otherwise write black frames); so it does for sub-frames it
  // is not given right or cannot average, leaving the page as it was.
  const lostError = () => new Error(`the WebGL context is lost (GPU: ${gpu.name}): no frame was drawn`);
  window.renderFrame = async (t, { sub = 1, shutter = 0, jitter = true } = {}) => {
    if (lost || R.lost()) throw lostError();
    if (!(Number.isInteger(sub) && sub >= 1)) throw new Error(`renderFrame: sub is a whole number of sub-frames, 1 or more (not ${JSON.stringify(sub)})`);
    if (!(typeof shutter === 'number' && shutter >= 0 && shutter <= 1)) throw new Error(`renderFrame: shutter is a part of one frame, 0 to 1 (not ${JSON.stringify(shutter)})`);
    if (typeof jitter !== 'boolean') throw new Error(`renderFrame: jitter is true or false (not ${JSON.stringify(jitter)})`);
    const t0 = performance.now();
    clock.reset();
    const at = clampT(Number(t));
    const o = sub === 1 && shutter === 0 && jitter ? PLAIN : { sub, shutter, jitter };
    draw(at, o);
    still = at;
    stillSub = o;
    syncControls(still); // no pause screen, at once
    R.finish();
    if (R.lost()) throw lostError();
    window.FR_LAST_MS = performance.now() - t0; // draw + GPU finish (tools/shot.mjs --bench)
    return still;
  };
  // the life map's GPU memory: RGBA 8-bit with mipmaps, w x h x 4 x 4/3 (as collage.js collageBytes)
  // of the picture as uploaded (decoded at half size with tex=half); none with ?ref=1, which does not
  // load it
  const lifeBytes = assets.lifeMap ? assets.lifeMap.width * assets.lifeMap.height * 4 * (4 / 3) : 0;
  window.FR_INFO = () => {
    const i = R.info();
    return {
      ...i,
      pictures: [assets.key.width, assets.key.height],
      tex: opts.tex,
      collage: { strength, images: collage.images, bytes: collage.bytes, set: collage.set },
      // the miniatures' targets of the picture in picture follow the canvas (collage.js pipBytes); so
      // does the end card's text texture, RGBA 8-bit without mipmaps at the canvas's own size
      // (layers/card.js), not made with ?ref=1; the sub-frame targets, made by the first averaged
      // frame and kept (subframes.js averagingBytes; 0 before)
      memory: {
        collage: collage.bytes,
        life: lifeBytes,
        pip: pipBytes(i.targets.pip),
        card: opts.ref ? 0 : i.width * i.height * 4,
        subframes: averagingBytes(i.averaging),
      },
      sub: drawnSub.sub,
      shutter: drawnSub.shutter,
      jitter: drawnSub.jitter,
    };
  };

  // every program compiled and every texture and buffer uploaded before the first frame, so
  // playback never stalls where a layer first appears (nothing of the warm-up reaches a frame)
  const firstT = still === null ? 0 : still;
  R.warm(stateOf(firstT));
  draw(firstT);
  syncControls(firstT);
  R.finish();
  // the GPU could not hold everything: say how much is needed and offer the half-size pictures. Any
  // other error goes to the console (reading the flag clears it; the tools treat a console error
  // as a failed frame, as they do the flag)
  const err = R.error();
  if (err === R.OUT_OF_MEMORY) {
    banner(memoryNotice(collage.bytes, gpu.name, location.href, collage.set), true);
    console.error(`WebGL: out of memory after loading ${collage.images} collage cuts (${gigabytes(collage.bytes)})`);
  } else if (err) {
    console.error(`WebGL error 0x${err.toString(16)} while getting ready`);
  }
  window.FR_READY = true;
  requestAnimationFrame(tick);
}

start().catch((e) => console.error(e));

// The end card (design 7, its end card row, and 14; the owner's choices, 2026-11-19): when the
// picture ends, at the audio's end (DUR, music.js), the screen cuts to black and "Fractal" with
// "Incheol Kim" under it come and go in ivory, with the timing and the layout of the owner's previous
// piece's end card (Echolocation: src/js/50-app.js SR.END_CARD and SR.endCardOpacity,
// src/template.html #over.endcard), in Geo at 1.8 times Echolocation's size, the name at 85 % of the
// ink. The video ends when the card does (VIDEO_END).
// Pure: constants and cardAt, the time to the card's state (called by timeline.js frameState only);
// layers/card.js draws it from frameState's card and takes the constants that say how it looks.

import { cubicBezier } from './ease.js';
import { DUR } from './music.js';

// Echolocation's timing, seconds: the text comes in, holds, goes, then black alone
export const CARD = { in: 0.6, hold: 2.5, out: 1.5, black: 0.4 };
export const CARD_LEN = CARD.in + CARD.hold + CARD.out + CARD.black;
// the video's end, seconds: the picture to the audio's end, then the card (timeline.js clampT, the
// page's clock in main.js)
export const VIDEO_END = DUR + CARD_LEN;

export const CARD_TEXT = { title: 'Fractal', name: 'Incheol Kim' };
// ivory, as a display sRGB value (drawn as it is, no colour conversion)
export const CARD_INK = '#f4efdf';
// the same as channels 0..255 (the page's controls take it as CSS, src/ui.js)
export const CARD_INK_RGB = [1, 3, 5].map((i) => parseInt(CARD_INK.slice(i, i + 2), 16));
// in stage heights at Echolocation's size (its px at 1080p over 1080): the title's and the name's
// font size, and the gap between the title's letters and the name's (from the lowest ink of the one
// to the highest of the other: Echolocation's 32 px between the two lines of text, which its CSS puts
// there with Consolas, 31.4 px ink to ink)
export const CARD_SIZE = { title: 46 / 1080, name: 37 / 1080, gap: 32 / 1080 };
// the card is drawn at this many times CARD_SIZE
export const CARD_SCALE = 1.8;
// the name is drawn at this opacity of the ink, over the black
export const CARD_NAME_ALPHA = 0.85;
// letter spacing, em (of each line's font size)
export const CARD_TRACKING = 0.12;

// The font, a Google font (github.com/google/fonts, its licence beside it) in assets/fonts/<file>,
// loaded by assets.js before the first frame: Geo, upright (its Oblique is not used), loaded and
// drawn under its own family name at its own weight.
export const CARD_FONT = { family: 'Geo', file: 'geo/Geo-Regular.ttf', weight: 400 };

// CSS's ease (the text coming in, as Echolocation's 0.6 s CSS transition) and ease-in-out (going)
const EASE = cubicBezier(0.25, 0.1, 0.25, 1);
const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);
// a time this close to one of the card's boundaries is on it (the float rounding of t - end)
const EDGE = 1e-9;

// The text's opacity v seconds after it starts to come in (Echolocation's SR.endCardOpacity): 0 up to
// 0, EASE(v / in) while it comes in, 1 to in + hold, then 1 - EASE_IN_OUT of the way out, exactly 0
// from in + hold + out on.
function textAt(v) {
  const { in: rise, hold, out } = CARD;
  if (v <= EDGE) return 0;
  if (v < rise - EDGE) return EASE(v / rise);
  if (v <= rise + hold + EDGE) return 1;
  if (v >= rise + hold + out - EDGE) return 0;
  return 1 - EASE_IN_OUT((v - rise - hold) / out);
}

// The end card at t for a picture that ends at end -> { black, a }: black, the opacity of the black
// over the whole frame; a, the text's. Nothing (0, 0) before end; from end on all black (a cut), the
// text starting there.
export function cardAt(t, end) {
  const u = t - end;
  if (u < 0) return { black: 0, a: 0 };
  return { black: 1, a: textAt(u) };
}

// The halftone the flats and the photo pieces' moment of ink share: its cell, the tone that
// still prints ink, and the threshold of a tone against the screen of common.glsl halftoneScreen.
// No DOM, no WebGL (tests import it).

export const CELL = 6; // halftone cell, in 1/1080 of the stage height
export const TONE_MAX = 0.75; // tone 1 (paper) still prints a quarter of the ink, as in the review sheets

// The halftone threshold of a leaf's tone (< 0: solid).
export function toneThreshold(tone) {
  return threshold(1 - Math.min(Math.max(tone || 0, 0), 1) * TONE_MAX);
}

// The halftone prints ink where f > thr, f = 0.5 + 0.25 (cos 2πx + cos 2πy). thr for a wanted
// coverage comes from the distribution of f over one cell, so the printed fraction is exact.
let fSorted = null;
function threshold(coverage) {
  if (coverage >= 0.999) return -1; // solid
  if (!fSorted) {
    const n = 256;
    fSorted = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        fSorted[j * n + i] = 0.5 + 0.25 * (Math.cos((2 * Math.PI * (i + 0.5)) / n) + Math.cos((2 * Math.PI * (j + 0.5)) / n));
      }
    }
    fSorted.sort();
  }
  const k = Math.min(fSorted.length - 1, Math.max(0, Math.round((1 - coverage) * fSorted.length)));
  return fSorted[k];
}

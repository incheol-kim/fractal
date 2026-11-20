// Music data access. All times are audio time (seconds).
export const OFFSET = 0.923077;
// the audio's length: the picture ends here, and the end card follows it (src/card.js)
export const DUR = 47.076938;
export const BAR = 1.846154;
export const M1 = 0.923077; // the first bar line

const BARS = 24;
const ENV_RATE = 100;

let data = null;

export function initMusic(json) {
  data = json;
}

export function music() {
  return data;
}

export function sectionAt(t) {
  const s = data.sections;
  if (t < s.A[0]) return 'pre';
  for (const name of ['A', 'B', 'C', 'coda', 'tail']) {
    if (t < s[name][1]) return name;
  }
  return 'end';
}

export function barAt(t) {
  if (t < M1) return 0;
  const bar = Math.floor((t - M1) / BAR) + 1;
  return bar <= BARS ? bar : 0;
}

export function envAt(t) {
  const env = data.env;
  const x = t * ENV_RATE;
  if (x <= 0) return env[0] / 1000;
  const i = Math.floor(x);
  if (i >= env.length - 1) return env[env.length - 1] / 1000;
  const f = x - i;
  return (env[i] * (1 - f) + env[i + 1] * f) / 1000;
}

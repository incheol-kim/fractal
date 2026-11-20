// Small pure helpers. No randomness: hashes are integer based and deterministic.

export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

export function lerp(a, b, x) {
  return a + (b - a) * x;
}

// Smoothstep from e0 to e1.
export function smooth(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const u = clamp((x - e0) / (e1 - e0), 0, 1);
  return u * u * (3 - 2 * u);
}

// Ease-out with overshoot. outBack(0) = 0, outBack(1) = 1 exactly.
export function outBack(x, s = 1.7) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const u = x - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

// CSS's cubic-bezier(x1, y1, x2, y2) timing function -> (x) => y: the curve from (0, 0) to (1, 1)
// with those two control points, read at x by solving its x for the curve's parameter (Newton
// steps, and bisection where they do not converge), as Echolocation's SR.cubicBezier. Exactly 0 at
// and below x = 0 and exactly 1 at and above x = 1. ease = (0.25, 0.1, 0.25, 1), ease-in-out =
// (0.42, 0, 0.58, 1).
export function cubicBezier(x1, y1, x2, y2) {
  const B = (a, b, u) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  const dB = (a, b, u) => 3 * a * (1 - u) * (1 - u) + 6 * (b - a) * u * (1 - u) + 3 * (1 - b) * u * u;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let k = 0; k < 8; k++) {
      const e = B(x1, x2, u) - x;
      const d = dB(x1, x2, u);
      if (Math.abs(e) < 1e-12 || Math.abs(d) < 1e-9) break;
      u -= e / d;
    }
    if (!(u >= 0 && u <= 1) || Math.abs(B(x1, x2, u) - x) > 1e-9) {
      let lo = 0;
      let hi = 1;
      u = x;
      for (let k = 0; k < 60; k++) {
        if (B(x1, x2, u) < x) lo = u;
        else hi = u;
        u = (lo + hi) / 2;
      }
    }
    return B(y1, y2, u);
  };
}

function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function int(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? v | 0 : 0;
}

// -> [0, 1)
export function hash11(n) {
  return mix32(int(n) ^ 0x9e3779b9) / 4294967296;
}

// -> [0, 1)
export function hash21(a, b) {
  const h = mix32(int(a) ^ 0x9e3779b9);
  return mix32(h ^ Math.imul(int(b) + 0x7f4a7c15, 0x27d4eb2f)) / 4294967296;
}

// Smooth value noise -> -1..1: hash21(i, seed) * 2 - 1 at every whole x, joined by u^2 (3 - 2u).
export function noise1(x, seed) {
  const i = Math.floor(x);
  const u = x - i;
  const a = hash21(i, seed) * 2 - 1;
  const b = hash21(i + 1, seed) * 2 - 1;
  return lerp(a, b, u * u * (3 - 2 * u));
}

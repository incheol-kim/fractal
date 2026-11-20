"""Pure helpers for tools/make_score.py: heights, the greedy assignment, view frames, timing,
when the collage's images change.

No file access and no hidden randomness: everything here is a function of its arguments (the
"random" numbers are rand01 of a seed that is one of them).
Coordinates are 0..1 of the key image (x by width, y by height, y down).
"""
import math

import numpy as np
from scipy.optimize import linear_sum_assignment

BAR = 1.846154              # one 4/4 bar at 130 BPM (s)
CHILD_STEP = BAR / 16       # a child stroke every sixteenth of a bar ...
FAMILY_SPAN = 2 * BAR       # ... and a whole family drawn within two bars of its parent
INK_FROM, INK_TO = 24.9, 28.6   # the cello crescendo: pencil (0) -> ink (1)


def rel_height(pitch, lo, hi):
    """Where pitch sits in the range lo..hi: 0 at lo, 1 at hi, clamped (0.5 for a one-pitch range)."""
    if hi <= lo:
        return 0.5
    return min(max((pitch - lo) / (hi - lo), 0.0), 1.0)


def assign(notes, candidates, cost):
    """The assignment of smallest total cost.

    notes: (key, t) pairs; candidates: a list; cost(key, cand) -> number. Every candidate is
    used at most once (scipy's linear_sum_assignment). With more notes than candidates only
    len(candidates) notes are served. Notes are put in (t, key) order first, so the result
    does not depend on the order they are given in. Returns {key: candidate}.
    """
    order = [k for k, _ in sorted(notes, key=lambda n: (n[1], n[0]))]
    if not order or not candidates:
        return {}
    m = np.array([[cost(k, c) for c in candidates] for k in order], dtype=float)
    rows, cols = linear_sum_assignment(m)
    return {order[r]: candidates[c] for r, c in zip(rows, cols)}


def rank_corr(a, b):
    """Spearman rank correlation (ties get their average rank)."""
    ra, rb = _ranks(a), _ranks(b)
    n = len(ra)
    ma, mb = sum(ra) / n, sum(rb) / n
    sab = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    saa = sum((x - ma) ** 2 for x in ra)
    sbb = sum((y - mb) ** 2 for y in rb)
    return sab / math.sqrt(saa * sbb) if saa > 0 and sbb > 0 else 0.0


def _ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def midpoint(pts, k):
    """The point halfway along a polyline, lengths measured with y scaled by k (= h / w) so a
    stroke on the non-square picture is halved in true length."""
    p = [(x, y * k) for x, y in pts]
    if len(p) == 1:
        return (p[0][0], p[0][1] / k)
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:])]
    half = sum(seg) / 2
    acc = 0.0
    for (a, b), s in zip(zip(p, p[1:]), seg):
        if acc + s >= half and s > 0:
            u = (half - acc) / s
            return (a[0] + u * (b[0] - a[0]), (a[1] + u * (b[1] - a[1])) / k)
        acc += s
    return (p[-1][0], p[-1][1] / k)


def view_center(zoom, center):
    """The camera centre at a zoom: the wanted centre, moved just enough to keep the view
    inside the picture (at zoom 1 it is always the middle)."""
    h = 0.5 / zoom
    return tuple(min(max(c, h), 1.0 - h) for c in center)


def view_frame(zoom, center):
    """The part of the picture [x0, y0, x1, y1] seen at a zoom around a (wanted) centre."""
    h = 0.5 / zoom
    cx, cy = view_center(zoom, center)
    return [cx - h, cy - h, cx + h, cy + h]


def in_frame(p, f):
    return f[0] <= p[0] <= f[2] and f[1] <= p[1] <= f[3]


def ink_at(t):
    """How much a stroke drawn at t is ink rather than pencil: 0 before the crescendo, 1 after."""
    return min(max((t - INK_FROM) / (INK_TO - INK_FROM), 0.0), 1.0)


def family_step(t0, n, end):
    """Interval between the n descendants of a parent stroke starting at t0. Child k starts at
    t0 + k * step and is drawn for one step, so the family ends at t0 + (n + 1) * step: a step
    of BAR / 16 unless that would run past two bars after t0 (or past end), then shorter."""
    span = min(FAMILY_SPAN, end - t0)
    return min(CHILD_STEP, span / (n + 1))


def nearest_attack(attacks, t, tol=0.03):
    """Index of the attack ([t, [note indices]]) nearest t; ValueError if none is within tol."""
    best = min(range(len(attacks)), key=lambda i: (abs(attacks[i][0] - t), i))
    if abs(attacks[best][0] - t) > tol:
        raise ValueError(f"no piano attack within {tol} s of {t}")
    return best


def rand01(seed, k):
    """Deterministic number in [0, 1) from two integers (splitmix64)."""
    z = (seed * 0x9E3779B97F4A7C15 + (k + 1) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    z ^= z >> 31
    return (z >> 11) / float(1 << 53)


def blocks_on_screen(blocks, t):
    """{block index: area showing} of the collage blocks on screen at t: those with a leaf
    (t_on, t_off, area) that has t_on <= t < t_off, the area the sum over those leaves."""
    out = {}
    for b, blk in enumerate(blocks):
        shown = [a for on, off, a in blk["leaves"] if on <= t < off]
        if shown:
            out[b] = sum(shown)
    return out


def schedule_changes(notes, blocks, mean, seed, limits, accent_min=0.0):
    """Which collage blocks move on to their next cut on which cello notes (design 6.3).

    notes: [(cello note number, t)], the notes that may change images, in time order. blocks:
    [{"leaves": [(t_on, t_off, area)], "stop": t, "cuts": int, "accent": int}]. A block is on
    screen at t when one of its leaves has t_on <= t < t_off; its area then is the sum of those
    leaves' areas (a share of the picture). limits: {"area", "gap_few", "gap_many", "many"}.

    The notes are taken one at a time. With n blocks on screen the least gap between two
    changes of a block is gap_many from `many` blocks on, else gap_few (counted in note numbers).
    A block draws its timer (notes to its next change) when it first shows and whenever it
    changes: 3-5 when it is alone on screen, else an integer from gap to 2 x mean - gap (gap
    when mean is smaller). It may change when it is on screen, t < stop, a cut is left, its
    timer is full and gap notes have passed. Those that may change are taken longest-waiting
    first (notes since the timer filled; ties by the seed) unless the area changed on that
    note would pass limits["area"]; a block left out waits for the next note, its timer full.
    Cuts: start at the smallest that is not the accent, then on in order past the accent, none
    shown twice. An accent block (accent >= 0), once all the above is decided, shows its accent
    for at least accent_min seconds before its stop: its last change at or before
    stop - accent_min goes to the accent instead and its later changes are dropped; with no
    such change it starts on its accent and does not change (so does a block whose only cut is
    the accent). Dropping changes keeps every limit; the timers are not run again.

    -> (start: [cut per block], events: [{"t", "note", "block", "to"}] in time order).
    """
    nb = len(blocks)
    lo_gap, hi_gap, many, cap = limits["gap_few"], limits["gap_many"], limits["many"], limits["area"]
    order = [[k for k in range(b["cuts"]) if k != b["accent"]] for b in blocks]   # cuts in the order shown
    pos = [0] * nb                       # place in order of the cut shown
    last = [None] * nb                   # note number of the block's first showing or last change
    timer = [0] * nb

    def draw(note, b, n, gap):
        lo, hi = (3, 5) if n == 1 else (gap, max(gap, math.floor(2 * mean - gap + 1e-9)))
        return lo + min(int(rand01(seed, 2 * (note * nb + b)) * (hi - lo + 1)), hi - lo)

    events = []
    for note, t in notes:
        area = blocks_on_screen(blocks, t)
        n = len(area)
        gap = hi_gap if n >= many else lo_gap
        for b in area:
            if last[b] is None:
                last[b], timer[b] = note, draw(note, b, n, gap)
        ready = [b for b in area if t < blocks[b]["stop"] and pos[b] + 1 < len(order[b])
                 and note - last[b] >= max(timer[b], gap)]
        ready.sort(key=lambda b: (-(note - last[b] - timer[b]), rand01(seed, 2 * (note * nb + b) + 1), b))
        total = 0.0
        for b in ready:
            if total + area[b] > cap:
                continue
            total += area[b]
            pos[b] += 1
            events.append({"t": t, "note": note, "block": b, "to": order[b][pos[b]]})
            last[b], timer[b] = note, draw(note, b, n, gap)
    events.sort(key=lambda e: (e["t"], e["block"]))
    start, dropped = [], set()
    for b, blk in enumerate(blocks):
        start.append(order[b][0] if order[b] else blk["accent"])
        if blk["accent"] < 0:
            continue
        mine = [e for e in events if e["block"] == b]
        early = [e for e in mine if e["t"] <= blk["stop"] - accent_min]     # a prefix: mine is in time order
        if early:
            early[-1]["to"] = blk["accent"]
        else:
            start[b] = blk["accent"]
        dropped.update(id(e) for e in mine[len(early):])
    return start, [e for e in events if id(e) not in dropped]


def piece_from(seed, c, aspect):
    """Where a photo piece starts before it lands: [dx, dy, rotDeg, scale].

    dx, dy are in screen heights, pointing from the middle of the picture out through c
    (0..1 coordinates; aspect = width / height), 3-8 % of the screen height long; rotation
    within +-6 degrees, scale 1.08-1.20. seed (the note number) picks the numbers."""
    vx, vy = (c[0] - 0.5) * aspect, c[1] - 0.5
    n = math.hypot(vx, vy)
    if n < 1e-9:
        a = 2 * math.pi * rand01(seed, 3)
        vx, vy, n = math.cos(a), math.sin(a), 1.0
    mag = 0.03 + 0.05 * rand01(seed, 0)
    rot = -6.0 + 12.0 * rand01(seed, 1)
    scale = 1.08 + 0.12 * rand01(seed, 2)
    return [mag * vx / n, mag * vy / n, rot, scale]

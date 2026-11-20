"""Every line the pencil will draw: vector polylines with a parent/child hierarchy.

    .venv\\Scripts\\python.exe tools\\make_plate.py      (first: it writes the wire mask)
    .venv\\Scripts\\python.exe tools\\make_strokes.py

Sources of the strokes (all coordinates 0..1 of the key image, x by width, y by height):
- "edge": the boundaries between the leaves of assets/regions.json. A boundary shared by two
  leaves is one stroke carrying both ids ("leaf" is the smaller leaf, "leaf2" the other);
  boundaries between the tone pieces of one split leaf (name, name_t2, ...) are shading, not
  lines, and the image border is not a line. Each boundary is cut at its corners
  (strokes_lib.split_at_corners), nearly straight pieces become straight
  (strokes_lib.straighten) and straight pieces run past their ends (strokes_lib.overshoot).
- "detail": straight segments found inside a leaf (OpenCV's line segment detector on the
  wire-free plate at 2944 px): window bars, railings, keys. Segments along a leaf boundary,
  doubles (both sides of one bar) and leaves of foliage and people are left out.
- "wire_black", "wire_red": the wire mask of tools/make_plate.py traced into polylines
  (strokes_lib.trace_wires), pieces in line joined. The pieces along the "last" guide of
  data/strokes_hand.json are chained into one stroke, the longest red wire, marked "last".
  The renderer reveals the key image along a wire with a ribbon w + 2 px each side (2944
  scale); "w" (at most WIRE_W_MAX where possible) and extra pieces for wires running side
  by side make the ribbons cover every pixel the plate repainted, which is asserted. Wires
  belong to no leaf ("leaf": -1).
- "mark": the arrows and crosses listed under "marks" in data/strokes_hand.json; never gen 0.

Generations: strokes_lib.assign_generations with region = the leaf an edge outlines (its
sides are siblings), region box = that leaf's box (edges) or the stroke's own box (details,
marks), zone = the section-A view ring of the midpoint (a frame's lines are drawn in that
frame), family = pencil / black wire / red wire. Wires contain nothing. Then choose_gen0
keeps exactly 189 gen-0 strokes: the 10 longest black and 12 longest red wires, and per ring
the longest pencil strokes in numbers that make each ring's median about twice the one inside
it (a ring short of strokes borrows its gen-1 strokes no longer than its median:
strokes_lib.promote); the rest become gen 1 (strokes_lib.demote). The "last" stroke gets no
children (they go to the nearest other gen-0 red wire), and a gen-0 stroke keeps at most
MAX_CHILDREN gen-1 children (strokes_lib.balance). The count conditions are asserted at the
end (check).

Writes assets/strokes.json, { "regions": the fingerprint of the region map the strokes were
made from (regions_lib.fingerprint of assets/regions_id.png, which must be the "fingerprint" of
assets/regions.json), "strokes": [...] }, and local-only/temp/strokes_debug.png (generations in
colours on white) with crops local-only/temp/strokes_debug_x8.png, _x4.png, _x2.png.
"""
import json
import os
import re
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import make_plate  # noqa: E402
import regions_lib  # noqa: E402
import strokes_lib  # noqa: E402

REGIONS = os.path.join(ROOT, "assets", "regions.json")
REGIONS_ID = os.path.join(ROOT, "assets", "regions_id.png")
PLATE = os.path.join(ROOT, "assets", "key_plate.png")
WIRE_MASK = make_plate.OUT_MASK
HAND = make_plate.HAND
OUT = os.path.join(ROOT, "assets", "strokes.json")
DEBUG = str(paths.TEMP / "strokes_debug.png")

# section A view frames (x0, y0, x1, y1 in 0..1), innermost first
FRAMES = [(0.4375, 0.3325, 0.5625, 0.4575), (0.375, 0.270, 0.625, 0.520),
          (0.25, 0.145, 0.75, 0.645)]
WIRE_PAD_PX = 2.0           # a wire's ribbon is its width plus this on each side (2944 px; src/ribbons.js WIRE_PAD)
RING_NAMES = ["x8", "x4 ring", "x2 ring", "x1 ring"]
CELLO_PER_RING = [17, 15, 17, 16]       # minimum gen-0 strokes per ring
RING_SLACK = 10
MAX_CHILDREN = 12           # gen-1 children per gen-0 stroke (strokes_lib.balance)
GEN0 = 189
WIRE_GEN0 = {"wire_black": 10, "wire_red": 12}
LAST_MIN_LEN = 0.85
MIN_STROKES = 600
MEDIAN_RATIO = (1.5, 2.5)

CORNER_DEG = 35.0
EDGE_TOL_PX = 2.5           # boundaries are simplified by this before looking for corners
STRAIGHT_TOL = 0.0015       # strokes_lib.straighten tolerance (fraction of the width)
MIN_EDGE_PX = 8.0
EDGE_OVERSHOOT = 0.06
DETAIL_OVERSHOOT = 0.04
NO_DETAIL = re.compile(r"tree|plant|coral|person|figure")
DETAIL_MIN_PX = 10.0
DETAIL_EDGE_PX = 3.0        # details closer than this to a leaf boundary double an edge
DETAIL_SAME_PX = 4.0        # two segments closer than this ...
DETAIL_SAME_DEG = 5.0       # ... and parallel within this are one bar
DETAIL_PER_KPX = 0.3        # at most this many details per 1000 px of leaf area ...
DETAIL_MAX = 25             # ... and this many per leaf
WIRE_JOIN_PX = 60           # hi-res px
WIRE_JOIN_DEG = 12.0
WIRE_BEND_DEG = 25.0        # traced wires are cut where they turn more than this ...
WIRE_BEND_TOL = 3.0         # ... after simplifying by this (px)
WIRE_MIN_PX = 40.0          # shorter parts stay with their neighbour
WIRE_DROP_PX = 12.0         # shorter bits are left to the ribbons of the wires around them
WIRE_W_MAX = 6.0            # a wire's w (2944 px) is at most this unless nothing else covers
LAST_NEAR_PX = 12.0         # pieces this close to the "last" guide belong to it
GROW_PX = make_plate.GROW_PX


def tone_base(name):
    return re.sub(r"_t\d+$", "", name)


def ring_of(mid):
    x, y = mid
    for k, (x0, y0, x1, y1) in enumerate(FRAMES):
        if x0 <= x <= x1 and y0 <= y <= y1:
            return k
    return len(FRAMES)


class Space:
    """0..1 image coordinates <-> width units (x and y both divided by the width)."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.k = h / w

    def to_u(self, pts):
        p = np.asarray(pts, float).copy()
        p[:, 1] *= self.k
        return p

    def from_u(self, pts):
        p = np.asarray(pts, float).copy()
        p[:, 1] /= self.k
        return p


# ---------------------------------------------------------------- edges

def edge_strokes(leaves, sp):
    """Edge strokes and the number of boundary segments that matched no neighbour.

    Stretches on the image border are not lines. A stretch whose segments no other leaf has
    (reversed) is still a line: it is kept with its one leaf ("leaf2" left out)."""
    by_id = {lf["id"]: lf for lf in leaves}
    out = []
    unmatched = 0
    for lid, nid, pts, closed in strokes_lib.boundary_runs(leaves):
        if nid == strokes_lib.BORDER:
            continue
        if nid == strokes_lib.UNMATCHED:
            unmatched += len(pts) - (0 if closed else 1)
            small, big = by_id[lid], None
        else:
            if lid > nid:
                continue
            a, b = by_id[lid], by_id[nid]
            if a["group"] == b["group"] and tone_base(a["name"]) == tone_base(b["name"]):
                continue
            small, big = (a, b) if (a["area"], a["id"]) <= (b["area"], b["id"]) else (b, a)
        x0, y0, x1, y1 = small["bbox"]
        box = [x0, y0 * sp.k, x1, y1 * sp.k]
        for piece in strokes_lib.split_at_corners(sp.to_u(pts), CORNER_DEG, closed=closed,
                                                  tol=EDGE_TOL_PX / sp.w):
            piece = strokes_lib.straighten(piece, STRAIGHT_TOL)
            if strokes_lib.polyline_length(piece) * sp.w < MIN_EDGE_PX:
                continue
            s = {"kind": "edge", "leaf": small["id"], "pts": piece, "box": box, "region": small["id"]}
            if big is not None:
                s["leaf2"] = big["id"]
            out.append(s)
    return out, unmatched


# ---------------------------------------------------------------- details

def detail_strokes(leaves, labels, plate, sp):
    h, w = labels.shape
    by_id = {lf["id"]: lf for lf in leaves}
    grey = cv2.cvtColor(plate, cv2.COLOR_RGB2GRAY)
    lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    found = lsd.detect(grey)[0]
    segs = np.zeros((0, 4)) if found is None else np.asarray(found, float).reshape(-1, 4)
    edge = np.zeros((h, w), bool)
    edge[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    edge[1:, :] |= labels[1:, :] != labels[:-1, :]
    dist = ndimage.distance_transform_edt(~edge)
    allowed = {lf["id"] for lf in leaves
               if lf["kind"] in ("mass", "part", "object") and not NO_DETAIL.search(lf["name"])}
    per_leaf = {}
    for x0, y0, x1, y1 in segs:
        length = float(np.hypot(x1 - x0, y1 - y0))
        if length < DETAIL_MIN_PX:
            continue
        t = np.linspace(0, 1, max(int(length), 2))
        xs = np.clip((x0 + t * (x1 - x0)).astype(int), 0, w - 1)
        ys = np.clip((y0 + t * (y1 - y0)).astype(int), 0, h - 1)
        ids, counts = np.unique(labels[ys, xs], return_counts=True)
        lid = int(ids[np.argmax(counts)])
        if lid not in allowed or counts.max() < 0.9 * len(t):
            continue
        if np.median(dist[ys, xs]) < DETAIL_EDGE_PX:
            continue
        per_leaf.setdefault(lid, []).append((length, x0, y0, x1, y1))
    out = []
    for lid in sorted(per_leaf):
        cands = sorted(per_leaf[lid], key=lambda s: (-s[0], s[1], s[2]))
        kept = []
        for length, x0, y0, x1, y1 in cands:
            a, b = np.array([x0, y0]), np.array([x1, y1])
            if any(_same_bar(a, b, k[0], k[1]) for k in kept):
                continue
            kept.append((a, b))
        area_px = by_id[lid]["area"] * h * w
        cap = int(min(DETAIL_MAX, max(1, DETAIL_PER_KPX * area_px / 1000)))
        for a, b in kept[:cap]:
            pts = np.array([a, b]) / w                 # pixels -> width units
            out.append({"kind": "detail", "leaf": lid, "pts": pts.tolist()})
    return out


def _same_bar(a, b, c, d):
    """Segments ab and cd (pixels) are the two sides of one bar, or one inside the other."""
    u, v = b - a, d - c
    ang = np.degrees(np.arccos(min(1.0, abs(float(u @ v)) / (np.hypot(*u) * np.hypot(*v)))))
    if ang > DETAIL_SAME_DEG:
        return False
    n = np.array([-v[1], v[0]]) / np.hypot(*v)
    if max(abs(float((a - c) @ n)), abs(float((b - c) @ n))) > DETAIL_SAME_PX:
        return False
    t = v / np.hypot(*v)
    s0, s1 = sorted([float((a - c) @ t), float((b - c) @ t)])
    overlap = min(s1, np.hypot(*v)) - max(s0, 0.0)
    return overlap > 0.5 * min(s1 - s0, np.hypot(*v))


# ---------------------------------------------------------------- wires

def _near_runs(line, guide, near):
    """Split a polyline (resampled every 4 px) into runs near the guide and runs away from it."""
    p = np.asarray(line, float)
    seg = np.hypot(*np.diff(p, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    s = np.linspace(0, cum[-1], max(int(cum[-1] / 4) + 1, 2))
    q = np.stack([np.interp(s, cum, p[:, 0]), np.interp(s, cum, p[:, 1])], 1)
    g = np.asarray(guide, float)
    d = np.min([strokes_lib.seg_dist(q, g[i], g[i + 1]) for i in range(len(g) - 1)], axis=0)
    close = d <= near
    runs = []
    start = 0
    for i in range(1, len(q) + 1):
        if i == len(q) or close[i] != close[start]:
            runs.append((bool(close[start]), q[start:i]))
            start = i
    return runs


def _bend_parts(line):
    """A traced wire cut where it bends sharply (it went from one wire to another at a
    crossing); parts shorter than WIRE_MIN_PX stay with their neighbour."""
    out = []
    for p in strokes_lib.split_at_corners(line, WIRE_BEND_DEG, tol=WIRE_BEND_TOL):
        if out and min(strokes_lib.polyline_length(p), strokes_lib.polyline_length(out[-1])) < WIRE_MIN_PX:
            out[-1] = out[-1] + p[1:]
        else:
            out.append(p)
    return out


def wire_polylines(mask, guide):
    """Traced wire polylines (hi-res px) per kind, and the chained "last" polyline."""
    lines = {}
    last_parts = []
    fringe = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * make_plate.FRINGE_PX + 1,) * 2)
    for kind, value in (("wire_black", 255), ("wire_red", 128)):
        core = cv2.erode((mask == value).astype(np.uint8), fringe) > 0   # without the fringe
        pieces = strokes_lib.trace_wires(core, spur=12, max_turn=make_plate.CROSS_TURN)
        joined = strokes_lib.join_pieces(pieces, WIRE_JOIN_PX, WIRE_JOIN_DEG)
        parts = [q for ln in joined for q in _bend_parts(ln)]
        parts = [q for q in parts if strokes_lib.polyline_length(q) >= WIRE_DROP_PX]
        if kind == "wire_red":
            rest = []
            for ln in parts:
                for close, q in _near_runs(ln, guide, LAST_NEAR_PX):
                    if len(q) < 2:
                        continue
                    (last_parts if close and len(q) >= 5 else rest).append(q)
            parts = [strokes_lib.simplify(q, 0.5).tolist() for q in rest]
        lines[kind] = parts
    last = strokes_lib.simplify(np.asarray(strokes_lib.chain_along(last_parts, guide)), 0.5).tolist()
    return lines, last


def ribbon_cover(shape, lines, half):
    """Pixels inside the capless ribbons (half-width per line, px) of the polylines (points
    with pixel centres at +0.5), with round joints (a mitred joint covers more)."""
    cover = np.zeros(shape, np.uint8)
    for ln, hw in zip(lines, half):
        p = np.asarray(ln, float) - 0.5
        for a, b in zip(p[:-1], p[1:]):
            d = b - a
            n = np.hypot(*d)
            if n == 0:
                continue
            o = np.array([-d[1], d[0]]) / n * hw
            quad = np.array([a + o, b + o, b - o, a - o])
            cv2.fillConvexPoly(cover, np.round(quad * 16).astype(np.int32), 1, cv2.LINE_8, 4)
        for c in p[1:-1]:
            cv2.circle(cover, tuple(np.round(c * 16).astype(int)), int(round(hw * 16)), 1, -1, cv2.LINE_8, 4)
    return cover > 0


def _reach(target, lines):
    """For every polyline, the distance (px) to the farthest target pixel nearer to it than
    to any other polyline."""
    ids = np.zeros(target.shape, np.int32)
    for i, ln in enumerate(lines):
        cv2.polylines(ids, [np.round(np.asarray(ln) - 0.5).astype(np.int32)], False, i + 1, 1)
    dist, (iy, ix) = ndimage.distance_transform_edt(ids == 0, return_indices=True)
    owner = (ids[iy, ix] - 1)[target]
    reach = np.zeros(len(lines))
    np.maximum.at(reach, owner, dist[target])
    return reach


def fit_wires(mask, lines, kinds):
    """Wire polylines (hi-res px) and widths whose ribbons cover what the plate repainted.

    The renderer reveals the key image along a wire with a ribbon w + 2 x 2 px wide at the
    2944 scale, i.e. w + 4 hi-res px on each side of the line, without caps. Each wire takes
    the repainted pixels (the mask grown by GROW_PX) nearest to it and w is set to reach the
    farthest, at most WIRE_W_MAX; the wire runs w + 4 px past its ends. Repainted pixels the
    ribbons still miss (wires running side by side traced as one) are traced again into
    more wire pieces of their colour; only what is left after that widens a wire beyond
    WIRE_W_MAX. Every polyline is cut at the image frame (strokes_lib.clip_polyline) before
    its coverage is measured. The first line must stay one piece (it is the "last" stroke).
    Returns (lines, kinds, w, wires widened beyond the cap, pixels left uncovered).
    """
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * GROW_PX + 1, 2 * GROW_PX + 1))
    target = cv2.dilate((mask > 0).astype(np.uint8), grow) > 0
    by_kind = {kind: cv2.dilate((mask == v).astype(np.uint8), grow) > 0
               for kind, v in (("wire_black", 255), ("wire_red", 128))}
    frame = (0.0, 0.0, float(mask.shape[1]), float(mask.shape[0]))   # pixel centres at +0.5

    def extend_clip(lines, kinds, w):
        out, k2, w2 = [], [], []
        for i, (ln, kind, wi) in enumerate(zip(lines, kinds, w)):
            pieces = strokes_lib.clip_polyline(strokes_lib.extend(ln, wi + 2 * WIRE_PAD_PX, span=10.0), frame)
            make_plate.require(i > 0 or len(pieces) == 1, "the last wire is cut in pieces by the frame")
            out += pieces
            k2 += [kind] * len(pieces)
            w2 += [wi] * len(pieces)
        return out, k2, np.array(w2)

    lines, kinds = list(lines), list(kinds)
    for _ in range(4):
        w = np.clip(np.ceil(_reach(target, lines) + 1.0) - 4.0, 1.0, WIRE_W_MAX)
        ext, ext_kinds, ext_w = extend_clip(lines, kinds, w)
        miss = target & ~ribbon_cover(target.shape, ext, ext_w + 4.0)
        if not miss.any():
            return ext, ext_kinds, ext_w, 0, 0
        added = 0
        for kind, region in by_kind.items():
            for ln in strokes_lib.trace_wires(miss & region, spur=4, min_len=2.0):
                lines.append(ln)
                kinds.append(kind)
                added += 1
        if not added:
            break
    # the rest: widen the wires nearest to the pixels still missed
    w = np.clip(np.ceil(_reach(target, lines) + 1.0) - 4.0, 1.0, WIRE_W_MAX)
    ext, ext_kinds, ext_w = extend_clip(lines, kinds, w)
    miss = target & ~ribbon_cover(target.shape, ext, ext_w + 4.0)
    wide = np.ceil(_reach(miss, lines) + 1.0) - 4.0
    w = np.where(wide > w, wide, w)
    ext, ext_kinds, ext_w = extend_clip(lines, kinds, w)
    miss = target & ~ribbon_cover(target.shape, ext, ext_w + 4.0)
    return ext, ext_kinds, ext_w, int((wide > WIRE_W_MAX).sum()), int(miss.sum())


# ---------------------------------------------------------------- marks

def mark_strokes(marks, labels, sp):
    """Arrows ({"arrow": [[x, y] from, [x, y] to]}) and crosses ({"cross": [x, y], "size": s,
    s a fraction of the width}), 0..1 coordinates."""
    h, w = labels.shape
    out = []
    for m in marks:
        if "arrow" in m:
            a, b = sp.to_u(m["arrow"])
            d = b - a
            head = max(0.2 * float(np.hypot(*d)), 0.006)
            u = d / np.hypot(*d)
            parts = [[a, b]]
            for ang in (np.radians(150), np.radians(-150)):
                r = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
                parts.append([b, b + r @ u * head])
            centre = b
        else:
            c = sp.to_u([m["cross"]])[0]
            s = m["size"]
            parts = [[c + (-s, -s), c + (s, s)], [c + (-s, s), c + (s, -s)]]
            centre = c
        x, y = sp.from_u([centre])[0]
        leaf = int(labels[min(int(y * h), h - 1), min(int(x * w), w - 1)])
        for p in parts:
            out.append({"kind": "mark", "leaf": leaf, "pts": np.asarray(p).tolist(), "gen0": False})
    return out


# ---------------------------------------------------------------- build

def build():
    with open(REGIONS, encoding="utf-8") as f:
        reg = json.load(f)
    with open(HAND, encoding="utf-8") as f:
        hand = json.load(f)
    sp = Space(reg["w"], reg["h"])
    leaves = reg["leaves"]
    labels = np.asarray(Image.open(REGIONS_ID)).astype(np.int32)
    fp = regions_lib.fingerprint(labels)
    make_plate.require(reg.get("fingerprint") == fp,
                       f"assets/regions.json has fingerprint {reg.get('fingerprint')}, assets/regions_id.png "
                       f"is {fp}: run tools/make_regions.py and tools/make_flat.py first")
    Image.MAX_IMAGE_PIXELS = None
    plate_hi = np.asarray(Image.open(PLATE).convert("RGB"))
    plate = cv2.resize(plate_hi, (sp.w, sp.h), interpolation=cv2.INTER_AREA)
    del plate_hi

    strokes, unmatched = edge_strokes(leaves, sp)
    n_edge = len(strokes)
    strokes += detail_strokes(leaves, labels, plate, sp)
    print(f"edges {n_edge} ({unmatched} boundary segments matched no neighbour: kept with "
          f"their one leaf), details {len(strokes) - n_edge}")
    seed = 0
    for s in strokes:
        frac = EDGE_OVERSHOOT if s["kind"] == "edge" else DETAIL_OVERSHOOT
        s["pts"] = strokes_lib.overshoot(s["pts"], frac, seed)
        seed += 1
    strokes += mark_strokes(hand.get("marks", []), labels, sp)
    # overshoots at the image border are cut at the frame (wires are cut in fit_wires)
    clipped, cut = [], 0
    for s in strokes:
        pieces = strokes_lib.clip_polyline(s["pts"], (0.0, 0.0, 1.0, sp.k))
        cut += pieces != [s["pts"]]
        clipped += [dict(s, pts=piece) for piece in pieces]
    print(f"  {cut} pencil strokes cut at the image frame")
    strokes = clipped

    mask = np.asarray(Image.open(WIRE_MASK))
    hw = mask.shape[1]
    guide = np.asarray(hand["last"], float) * (mask.shape[1], mask.shape[0])
    wires, last = wire_polylines(mask, guide)
    kinds = ["wire_red"] + ["wire_black"] * len(wires["wire_black"]) + ["wire_red"] * len(wires["wire_red"])
    lines = [last] + wires["wire_black"] + wires["wire_red"]
    n_traced = len(lines)
    lines, kinds, w, wide, miss = fit_wires(mask, lines, kinds)
    print(f"wires: {n_traced} traced (black {len(wires['wire_black'])}, red {len(wires['wire_red']) + 1}), "
          f"{len(lines) - n_traced} more for bundles; w median {np.median(w):.1f}, max {w.max():.0f}, "
          f"{wide} wider than {WIRE_W_MAX:.0f}; {miss} repainted px uncovered")
    for i, (kind, ln) in enumerate(zip(kinds, lines)):
        s = {"kind": kind, "leaf": -1, "pts": (np.asarray(ln) / hw).tolist(), "w": float(w[i]),
             "family": kind, "box": None}
        if i == 0:
            s["last"] = True
        strokes.append(s)
    return strokes, sp, labels, hand, miss, fp


# ---------------------------------------------------------------- generations

def choose_gen0(gens):
    """The strokes that are gen 0 in the end: (keep, lift), lift being gen-1 strokes to raise.

    Wires: the WIRE_GEN0 longest of each colour. Pencil strokes: per view ring, the longest
    N_k of its gen-0 strokes, the N_k chosen (189 in all) so that each ring's gen-0 median is
    as close as possible to twice the one inside it. A ring with fewer gen-0 strokes than
    its minimum + RING_SLACK (its lines sit inside one big box of the same ring) also offers,
    after all of its own, its longest gen-1 strokes no longer than its own median; those
    are raised to gen 0 if chosen."""
    keep = set()
    wires_in = [0] * 4
    ring_lens = [[] for _ in range(4)]
    for kind, n in WIRE_GEN0.items():
        idx = sorted((i for i, s in enumerate(gens) if s["kind"] == kind and s["gen"] == 0),
                     key=lambda i: (-gens[i]["len"], i))
        if len(idx) < n:
            raise SystemExit(f"only {len(idx)} {kind} strokes, {n} needed as gen 0")
        for i in idx[:n]:
            keep.add(i)
            wires_in[gens[i]["ring"]] += 1
            ring_lens[gens[i]["ring"]].append(gens[i]["len"])
    cands = []
    for k in range(4):
        own = sorted((i for i, s in enumerate(gens) if s["gen"] == 0 and s["ring"] == k
                      and s["kind"] in ("edge", "detail")), key=lambda i: (-gens[i]["len"], i))
        need = CELLO_PER_RING[k] + RING_SLACK - len(own)
        if need > 0:
            cap = np.median([gens[i]["len"] for i in own]) if own else np.inf
            more = sorted((i for i, s in enumerate(gens) if s["gen"] == 1 and s["ring"] == k
                           and s["kind"] in ("edge", "detail") and s["len"] <= cap),
                          key=lambda i: (-gens[i]["len"], i))
            own += more[:need]                  # used only after all of the ring's own
        cands.append(own)
    n_lines = GEN0 - sum(WIRE_GEN0.values())
    lo, hi = MEDIAN_RATIO
    best = None
    for n0 in range(CELLO_PER_RING[0], len(cands[0]) + 1):
        for n1 in range(CELLO_PER_RING[1], len(cands[1]) + 1):
            for n2 in range(CELLO_PER_RING[2], len(cands[2]) + 1):
                n3 = n_lines - n0 - n1 - n2
                if n3 < CELLO_PER_RING[3] or n3 > len(cands[3]):
                    continue
                med = [np.median(ring_lens[k] + [gens[i]["len"] for i in cands[k][:n]])
                       for k, n in enumerate((n0, n1, n2, n3))]
                ratios = [med[k + 1] / med[k] for k in range(3)]
                if not all(lo + 0.1 <= r <= hi - 0.1 for r in ratios):
                    continue
                cost = (sum(abs(np.log(r / 2.0)) for r in ratios), n0, n1, n2)
                if best is None or cost < best[0]:
                    best = (cost, (n0, n1, n2, n3))
    if best is None:
        raise SystemExit("no choice of gen-0 strokes per ring meets the median ratios")
    for k, n in enumerate(best[1]):
        keep.update(cands[k][:n])
    lift = {i for i in keep if gens[i]["gen"] == 1}
    return keep, lift


def free_last(gens):
    """The last stroke is the last note of the piece: nothing can follow it, so its children
    go to the nearest other gen-0 red wire (by midpoint)."""
    out = [dict(s) for s in gens]
    last = next(i for i, s in enumerate(out) if s.get("last"))
    others = [i for i, s in enumerate(out) if s["gen"] == 0 and s["kind"] == "wire_red" and i != last]
    mids = {i: strokes_lib.midpoint(out[i]["pts"]) for i in others}
    for s in out:
        if s["parent"] == last:
            m = strokes_lib.midpoint(s["pts"])
            s["parent"] = min(others, key=lambda i: (float(np.hypot(*(mids[i] - m))), i))
    return out


def pencil_width(s):
    if s["kind"] == "edge":
        return 1.2 + 1.3 * min(1.0, s["len"] / 0.15)
    if s["kind"] == "detail":
        return 0.9 + 0.5 * min(1.0, s["len"] / 0.05)
    return 1.3


# ---------------------------------------------------------------- checks and output

def check(out):
    """The count conditions of the brief, and every point inside 0..1; raises if one fails
    (make_plate.require), returns lines to print."""
    require = make_plate.require
    gen0 = [s for s in out if s["gen"] == 0]
    msg = []
    require(len(gen0) == GEN0, f"gen 0: {len(gen0)} strokes, want {GEN0}")
    for kind, n in WIRE_GEN0.items():
        c = sum(s["kind"] == kind for s in gen0)
        require(c >= n, f"gen-0 {kind}: {c}, want >= {n}")
    last = [s for s in out if s.get("last")]
    require(len(last) == 1 and last[0]["kind"] == "wire_red" and last[0]["gen"] == 0,
            "exactly one last stroke, a gen-0 red wire")
    require(last[0]["len"] >= LAST_MIN_LEN, f"last stroke len {last[0]['len']:.3f} < {LAST_MIN_LEN}")
    require(not any(s["parent"] == last[0]["id"] for s in out), "the last stroke has children")
    require(max(s["len"] for s in out if s["kind"] == "wire_red") == last[0]["len"],
            "the last stroke is not the longest red wire")
    meds = []
    for k in range(4):
        ring = [s for s in gen0 if ring_of(midpoint01(s)) == k]
        pencil = [s for s in ring if not s["kind"].startswith("wire")]
        require(len(ring) >= CELLO_PER_RING[k], f"{RING_NAMES[k]}: {len(ring)} gen-0 strokes")
        require(len(pencil) >= CELLO_PER_RING[k], f"{RING_NAMES[k]}: {len(pencil)} gen-0 pencil strokes")
        meds.append(float(np.median([s["len"] for s in ring])))
        msg.append(f"  {RING_NAMES[k]:>8}: {len(ring)} gen 0 ({len(ring) - len(pencil)} wires), "
                   f"median length {meds[-1]:.4f}")
    for k in range(3):
        r = meds[k + 1] / meds[k]
        require(MEDIAN_RATIO[0] <= r <= MEDIAN_RATIO[1], f"median ratio {RING_NAMES[k + 1]}: {r:.2f}")
        msg.append(f"  median {RING_NAMES[k + 1]} / {RING_NAMES[k]} = {r:.2f}")
    require(len(out) >= MIN_STROKES, f"{len(out)} strokes, want >= {MIN_STROKES}")
    for s in out:
        if s["gen"] == 0:
            require(s["parent"] == -1 and s["kind"] != "mark", f"stroke {s['id']}: gen 0 with a parent, or a mark")
        else:
            p = out[s["parent"]] if s["parent"] >= 0 else None
            require(p is not None and p["gen"] == s["gen"] - 1, f"stroke {s['id']}: bad parent")
            require(p["kind"].startswith("wire") == s["kind"].startswith("wire"),
                    f"stroke {s['id']}: a wire and a pencil stroke as parent and child")
    pts = np.concatenate([np.asarray(s["pts"], float) for s in out])
    require(pts.min() >= 0.0 and pts.max() <= 1.0,
            f"points outside 0..1: {int(((pts < 0) | (pts > 1)).any(axis=1).sum())}")
    msg.append(f"  all {len(pts)} points inside 0..1")
    return msg


def midpoint01(s):
    """Midpoint (0..1 coordinates) halfway along the stroke in true (isotropic) length."""
    p = np.asarray(s["pts"], float) * (1.0, HEIGHT_RATIO)
    return strokes_lib.midpoint(p) / (1.0, HEIGHT_RATIO)


def finish(gens, sp):
    """Renumber (gen, longest first), round, and convert to 0..1 coordinates."""
    order = sorted(range(len(gens)), key=lambda i: (gens[i]["gen"], -round(gens[i]["len"], 9),
                                                    gens[i]["kind"], gens[i]["pts"][0]))
    new = {old: k for k, old in enumerate(order)}
    out = []
    for k, i in enumerate(order):
        s = gens[i]
        pts = np.round(sp.from_u(s["pts"]), 5)
        rec = {"id": k, "kind": s["kind"], "gen": s["gen"],
               "parent": new[s["parent"]] if s["parent"] >= 0 else -1, "leaf": s["leaf"]}
        if "leaf2" in s:
            rec["leaf2"] = s["leaf2"]
        rec["w"] = round(float(s["w"]), 2)
        rec["len"] = round(float(s["len"]), 6)
        rec["pts"] = pts.tolist()
        if s.get("last"):
            rec["last"] = True
        out.append(rec)
    return out


GEN_COLOURS = [(27, 26, 24), (47, 95, 174), (217, 72, 43)]


def render(out, box, width, frames=True):
    """The strokes on white, generations in colours, for the view box (0..1) at width px."""
    x0, y0, x1, y1 = box
    ss = 2                                               # drawn at 2x, reduced: smooth lines
    scale = width * ss / (x1 - x0)                       # px per unit of x (0..1)
    hgt = int(round((y1 - y0) * scale * HEIGHT_RATIO))
    im = Image.new("RGB", (width * ss, hgt), (255, 255, 255))
    dr = ImageDraw.Draw(im)
    px = scale / 2944                                    # px per 2944-px
    if frames:
        for f in FRAMES:
            r = [((f[0] - x0) * scale, (f[1] - y0) * scale * HEIGHT_RATIO),
                 ((f[2] - x0) * scale, (f[3] - y0) * scale * HEIGHT_RATIO)]
            dr.rectangle(r, outline=(200, 200, 200), width=max(1, int(px)))
    for g in (2, 1, 0):
        for s in out:
            if s["gen"] != g:
                continue
            p = [((x - x0) * scale, (y - y0) * scale * HEIGHT_RATIO) for x, y in s["pts"]]
            wpx = (1.2 if s["kind"].startswith("wire") else s["w"]) * px * (1.0 if g == 0 else 0.8)
            dr.line(p, fill=GEN_COLOURS[g], width=max(1, int(round(wpx))))
    return im.resize((width, hgt // ss), Image.LANCZOS)


HEIGHT_RATIO = 1648 / 2944


def main():
    strokes, sp, labels, hand, miss, fp = build()
    make_plate.require(miss == 0, f"wire ribbons leave {miss} repainted pixels uncovered")
    for s in strokes:
        s["len"] = strokes_lib.polyline_length(s["pts"])
        s["ring"] = ring_of(sp.from_u([strokes_lib.midpoint(s["pts"])])[0])
        if not s["kind"].startswith("wire"):
            s["zone"] = s["ring"]
            s["w"] = pencil_width(s)
    gens = strokes_lib.assign_generations(strokes)
    keep, lift = choose_gen0(gens)
    natural = sum(s["gen"] == 0 for s in gens)
    gens = strokes_lib.demote(strokes_lib.promote(gens, lift), keep)
    gens = strokes_lib.balance(free_last(gens), MAX_CHILDREN)
    print(f"gen 0: {natural} by containment, {natural + len(lift) - GEN0} made gen 1, "
          f"{len(lift)} gen-1 raised (short rings)")
    out = finish(gens, sp)
    msg = check(out)

    os.makedirs(os.path.dirname(DEBUG), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"regions": fp, "strokes": out}, f, separators=(",", ":"))
    render(out, (0, 0, 1, 1), 2944).save(DEBUG)
    for name, fr in zip(("x8", "x4", "x2"), FRAMES):
        render(out, fr, 1600).save(DEBUG.replace(".png", f"_{name}.png"))

    kinds = sorted({s["kind"] for s in out})
    print(f"{len(out)} strokes -> {os.path.relpath(OUT, ROOT)}, {os.path.relpath(DEBUG, ROOT)}")
    for kind in kinds:
        c = [sum(1 for s in out if s["kind"] == kind and s["gen"] == g) for g in range(3)]
        print(f"  {kind:>10}: {sum(c):5d}  gen 0/1/2: {c[0]}/{c[1]}/{c[2]}")
    c = [sum(1 for s in out if s["gen"] == g) for g in range(3)]
    print(f"  {'all':>10}: {len(out):5d}  gen 0/1/2: {c[0]}/{c[1]}/{c[2]}")
    last = [s for s in out if s.get("last")][0]
    print(f"  last: stroke {last['id']}, len {last['len']:.3f}")
    kids = np.bincount([s["parent"] for s in out if s["gen"] == 1], minlength=len(out))
    print(f"  gen-1 children per gen-0 stroke: max {kids.max()}, mean {kids[[s['id'] for s in out if s['gen'] == 0]].mean():.1f}")
    print("\n".join(msg))


if __name__ == "__main__":
    main()

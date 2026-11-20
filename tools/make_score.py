"""The score: every note of assets/music.json given something on screen (design 6.3, 7, 9.7).

    .venv\\Scripts\\python.exe tools\\make_score.py [--out assets/score.json]
                                                    [--table local-only/temp/score_table.txt]

Reads assets/music.json, assets/regions.json (+ regions_id.png), assets/strokes.json, the
collage's blocks of assets/collage.json and the hand-written star moments of data/cues.json.
Writes assets/score.json (read by src/timeline.js) and a table for people,
local-only/temp/score_table.txt. Deterministic: the same input gives the same bytes.

The region map's fingerprint: the "fingerprint" of regions.json must be the one of
regions_id.png (regions_lib.fingerprint) and the "regions" of strokes.json and collage.json the
same, or the score stops and names the tool to run again; score.json carries it as "regions".

Every "assign" below is score_lib.assign: the matching of smallest total cost in one pool.

- strokes: one gen-0 stroke per cello note. In section A the candidates of a note are the
  pencil strokes whose midpoint is in the view of that moment but not in the view before it
  (the next ring out); later the pencil strokes still free.
  The 10 notes of the solo window take the black wires, the 12 of the coda the red ones and
  the last note the "last" stroke. Cost = height difference (target = the note's place in
  the cello range of its section, laid over the height of the view) + W_LEN x length-grade
  mismatch (terciles of note length and of stroke length in that pool). Children follow
  their root in breadth-first order, one every BAR/16, the step shortened evenly when the
  family would not end within two bars (or by END).
- washes: the four chords of A, over the mass/part leaves with pixels in the view; a wash
  cue may narrow them to named groups or to kinds (design 7: the second chord blooms in the
  shape of the white room, the third in the shapes of the blocks, the fourth is the tower).
- arrivals of B: one or more leaves per piano note of B: mass/part leaves of size >= 1 by
  height, the upper voice of an attack on the higher leaf; leaves left over join the note
  nearest in height. Those of the first two bars of B are the flats (flat ink); the others
  arrive showing the collage.
- collage (design 6.3, 6.4): each leaf of a collage block shows the collage from its arrival
  (a flat's leaf from when the collage covers it, "until": the next arrival in its block after
  the two bars, at the latest the last piano attack two bars after them) until its photo piece
  comes ("off"; "tear" when a big cut-out lands with a snap before the glue chord). A block's
  image changes on cello notes (score_lib.schedule_changes) in three strengths, until its widest
  leaf is a photo or the glue chord ("stop"); accent blocks end on their accent cut, shown for
  at least ACCENT_MIN before their stop. The score stops before writing when the collage breaks
  design 10.4's check (check_collage).
- pieces: one group of its own per piano note from 30.30 s. The pins and develop entries of
  cues.json come first (lowest note first; they hold the star moments: the climb, the blocks
  and what hangs on them). The other notes outside the six high chords of 39.02-41.05 s take
  medium-or-larger groups (total area >= A_MED), big before small: below C3 the largest left,
  above it by height (the run of cues.json over its own pitch range, the rest over the
  section's). The 33 chord notes take small groups (no mass, back or sky leaf) by height.
  Groups left over ride with their parent group (the group of the parent leaf of their
  largest leaf), else a small one is dealt to the six chords, else it rides with the nearest
  group placed outside them. A rider copies t, note, style and from of the group it rides
  with, so a wall's windows arrive with the wall as one cut-out.
- camera: x8 at t = 0, x4 / x2 / x1 cut on chords 2-4 of A, plus the punch-ins.
- pip (make_pip): the glass rooms of cues.json's pip become windows showing the whole frame in
  miniature on the piano attack nearest each cue, until their accent cut (collage.json) comes.
  The collage check stops when a leaf of a room would arrive after its window has ended.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import regions_lib  # noqa: E402
import score_lib  # noqa: E402

OUT = os.path.join(ROOT, "assets", "score.json")
TABLE = str(paths.TEMP / "score_table.txt")

END = 44.87                 # the last cello note ends; everything is drawn by then
B_PIANO = (15.60, 30.30)    # the piano of B (its first two notes come just before the bar line)
LATE_PIANO = 30.30          # the piano of C and the coda
LOW_PITCH = 48              # C3: lower piano notes take the largest group left
LONG_NOTE = 1.0             # piano notes this long (s) develop instead of slamming
RIDERS = (39.02, 41.05)     # first and last of the six high chords (small groups only)
HIGH_SPAN = (39.0, 41.1)    # where the six chords land: large leftovers ride with groups outside it
A_MED = 0.003               # total area (of the picture) from which a group is medium or larger
MASSY = {"mass", "back", "sky"}     # kinds of leaf that never land on the six high chords
ATTACK_TOL = 0.03
ZOOMS = (8, 4, 2, 1)        # the views of section A, one per chord
W_LEN = 0.2                 # weight of a full length-grade mismatch (0 <-> 2) against height
CHILD_W = {1: 0.6, 2: 0.4}  # child stroke width, times its gen-0 root's
FLAT_KINDS = ("mass", "part")
DIGITS = 6
# the collage
STRENGTHS = {"calm": 8.0, "mid": 4.5, "high": 2.0}     # mean cello notes between a block's image changes
DEFAULT_STRENGTH = "high"   # the page's strength without ?collage= (the video is made in it)
COLLAGE_LIMITS = {"area": 0.22, "gap_few": 3, "gap_many": 2, "many": 6}
COLLAGE_SEED = 20261116
ACCENT_MIN = 1.0            # s an accent is on screen at least before its block's photo (start value)
TEAR_MIN_SIZE = 3           # a photo cut-out with a piece this size or larger tears the collage off ...
TEAR_STYLES = ("slam", "fold", "slide")     # ... when it lands with one of these
# design 6.4: after the glue chord only the coda's tree and two white squares still show the
# collage, and they become photos on the coda's notes
LEFT_AFTER_GLUE = ("coral_tree_1", "coral_tree_2", "coral_tree_3", "coral_tree_4", "coral_tree_5",
                   "white_square_a", "white_square_b")
LEFT_ATTACKS = (42.59, 43.02, 43.46, 43.86)
DENSE = 20                  # the table's averages are over the notes with this many blocks on screen


def r6(x):
    return round(float(x), DIGITS) + 0.0


def fit(t, d, limit):
    """t and d rounded so that t + d <= limit still holds."""
    t, d = r6(t), r6(d)
    if t + d > limit:
        d = math.floor((limit - t) * 10 ** DIGITS) / 10 ** DIGITS
    return t, d


def load_inputs(root=ROOT):
    def rd(*p):
        with open(os.path.join(root, *p), encoding="utf-8") as f:
            return json.load(f)
    ids = np.array(Image.open(os.path.join(root, "assets", "regions_id.png"))).astype(np.int64)
    strokes = rd("assets", "strokes.json")
    return {"music": rd("assets", "music.json"), "regions": rd("assets", "regions.json"),
            "strokes": strokes["strokes"], "strokes_regions": strokes.get("regions"),
            "collage": rd("assets", "collage.json"), "cues": rd("data", "cues.json"), "ids": ids}


def region_map(inp):
    """The fingerprint of the region map, once regions.json, regions_id.png, strokes.json and
    collage.json are known to agree on it; stops with the tool to run again otherwise."""
    fp = inp["regions"].get("fingerprint")
    ids_fp = regions_lib.fingerprint(inp["ids"])
    require(fp == ids_fp, f"assets/regions.json has fingerprint {fp}, assets/regions_id.png is {ids_fp}: "
                          "run tools/make_regions.py and the tools after it (tools/README.md)")
    require(inp.get("strokes_regions") == fp,
            f"assets/strokes.json was made from the region map {inp.get('strokes_regions')}, "
            f"assets/regions.json is {fp}: run tools/make_strokes.py again")
    require(inp["collage"].get("regions") == fp,
            f"assets/collage.json was made from the region map {inp['collage'].get('regions')}, "
            f"assets/regions.json is {fp}: run tools/make_collage.py again")
    return fp


def grades(values, n=3):
    """Rank grades 0..n-1 (terciles for n = 3) of the values; equal values keep list order."""
    order = sorted(range(len(values)), key=lambda i: (values[i], i))
    g = [0] * len(values)
    for r, i in enumerate(order):
        g[i] = min(n - 1, n * r // len(values))
    return g


def section_of(t, sections):
    for name in ("A", "B", "C", "coda", "tail"):
        lo, hi = sections[name]
        if lo <= t < hi:
            return name
    return None


def require(cond, msg):
    if not cond:
        raise SystemExit(f"make_score: {msg}")


# ---------------------------------------------------------------- camera and washes

def a_chords(music):
    ch = [a for a in music["attacks"] if a[0] < B_PIANO[0]]
    require(len(ch) == len(ZOOMS), f"{len(ch)} piano attacks before B, want {len(ZOOMS)}")
    return ch


def make_camera(music, cues):
    cc = cues["camera_center"]
    chords = a_chords(music)
    times = [0.0] + [a[0] for a in chords[1:]]
    cam = [{"t": r6(t), "zoom": z, "c": [r6(v) for v in score_lib.view_center(z, cc)]}
           for t, z in zip(times, ZOOMS)]
    for p in cues["punch"]:
        a = music["attacks"][score_lib.nearest_attack(music["attacks"], p["attack_t"], ATTACK_TOL)]
        cam.append({"t": r6(a[0]), "zoom": p["zoom"], "c": list(p["c"]), "hold": p["hold"], "ease": p["ease"]})
    cam.sort(key=lambda e: e["t"])
    return cam


def make_shake(cues, glue):
    """The hand shake's window {from, to}: forward, and over at least 0.1 s before the glue chord."""
    require("shake" in cues, "data/cues.json has no shake: the hand shake's window [from, to] in seconds")
    lo, hi = cues["shake"]
    require(lo < hi <= glue - 0.1, f"shake window {lo}..{hi} (data/cues.json): want from < to <= glue {glue} - 0.1")
    return {"from": lo, "to": hi}


def make_pip(music, cues, col, collage):
    """The picture in picture (design 6.2's 4): from each cue's piano attack its glass room shows the
    whole frame in miniature (src/timeline.js pipCollage) until its accent cut comes.
    -> [{block: its row in the score's collage blocks, t: the attack, accent: collage.json's}] in time
    order. Stops for a block the collage does not have and for a window on or after the block's photo
    (its stop: the window would never show)."""
    require("pip" in cues, "data/cues.json has no pip: the glass rooms that become windows, "
                           "[{block, attack_t}, ...]")
    names = [b["name"] for b in col["blocks"]]
    out = []
    for c in cues["pip"]:
        require(c["block"] in names, f"pip (data/cues.json): no collage block {c['block']!r} in assets/collage.json")
        row = names.index(c["block"])
        t = r6(music["attacks"][score_lib.nearest_attack(music["attacks"], c["attack_t"], ATTACK_TOL)][0])
        stop = col["blocks"][row]["stop"]
        require(t < stop, f"pip (data/cues.json): {c['block']} would be a window from {t}, on or after its photo at {stop}")
        out.append({"block": row, "t": t, "accent": collage["blocks"][row]["accent"]})
    return sorted(out, key=lambda p: p["t"])


def frame_at(t, camera):
    """The view [x0, y0, x1, y1] of the camera cut in force at t (punch-ins left out)."""
    cut = [e for e in camera if "hold" not in e and e["t"] <= t][-1]
    return score_lib.view_frame(cut["zoom"], cut["c"])


def leaves_in(frame, ids):
    """Ids of the leaves with at least one pixel (centre) inside the frame."""
    h, w = ids.shape
    x0, x1 = math.ceil(frame[0] * w - 0.5), math.floor(frame[2] * w - 0.5)
    y0, y1 = math.ceil(frame[1] * h - 0.5), math.floor(frame[3] * h - 0.5)
    return set(int(v) for v in np.unique(ids[max(y0, 0):min(y1, h - 1) + 1, max(x0, 0):min(x1, w - 1) + 1]))


def make_washes(music, regions, cues, camera, ids):
    chords = a_chords(music)
    piano = music["piano"]
    flat_ids = {l["id"] for l in regions["leaves"] if l["kind"] in FLAT_KINDS}
    out = []
    for wc in sorted(cues["washes"], key=lambda w: w["attack_index"]):
        t, notes = chords[wc["attack_index"]]
        seen = leaves_in(frame_at(t, camera), ids) & flat_ids
        if "groups" in wc:
            for g in wc["groups"]:
                require(g in regions["groups"], f"wash {wc['attack_index']} (data/cues.json): no group {g!r} in assets/regions.json")
            seen &= {i for g in wc["groups"] for i in regions["groups"][g]}
        if "kinds" in wc:
            seen &= {l["id"] for l in regions["leaves"] if l["kind"] in wc["kinds"]}
        require(seen, f"wash {wc['attack_index']} covers no leaf in its view")
        out.append({"t": r6(t), "d": r6(max(piano[i][1] for i in notes)), "gain": wc["gain"],
                    "leaves": sorted(seen)})
    return out


# ---------------------------------------------------------------- strokes

def stroke_scopes(music, cues, camera):
    """The cello notes in groups that share a candidate pool: (name, notes, pool, frame, range)."""
    cello, sec = music["cello"], music["sections"]
    chords = a_chords(music)
    cuts = [0.0] + [a[0] for a in chords[1:]] + [sec["A"][1]]
    solo = cues["solo_wires"]
    by_sec = {}
    for i, n in enumerate(cello):
        s = section_of(n[0], sec)
        require(s in ("A", "B", "C", "coda"), f"cello note {i} at {n[0]} is outside A-coda")
        by_sec.setdefault(s, []).append(i)
    rng = {s: (min(cello[i][2] for i in v), max(cello[i][2] for i in v)) for s, v in by_sec.items()}
    full = [0.0, 0.0, 1.0, 1.0]
    scopes = []
    for k in range(len(ZOOMS)):
        notes = [i for i in by_sec["A"] if cuts[k] <= cello[i][0] < cuts[k + 1]]
        frame = frame_at(cuts[k], camera)
        inner = frame_at(cuts[k - 1], camera) if k else None
        scopes.append((f"A x{ZOOMS[k]}", notes, ("pencil", frame, inner), frame, rng["A"]))
    scopes.append(("B", by_sec["B"], ("pencil", None, None), full, rng["B"]))
    c_solo = [i for i in by_sec["C"] if solo[0] <= cello[i][0] < solo[1]]
    c_rest = [i for i in by_sec["C"] if i not in c_solo]
    scopes.append(("C", c_rest, ("pencil", None, None), full, rng["C"]))
    scopes.append(("C solo", c_solo, ("wire_black", None, None), full, rng["C"]))
    scopes.append(("coda", by_sec["coda"], ("wire_red", None, None), full, rng["coda"]))
    return scopes


def assign_strokes(music, cues, camera, strokes, k):
    """{cello note: gen-0 stroke id}, plus per-scope lines for the table."""
    cello = music["cello"]
    gen0 = [s for s in strokes if s["gen"] == 0]
    mid = {s["id"]: score_lib.midpoint(s["pts"], k) for s in gen0}
    last = [s["id"] for s in gen0 if s.get("last")]
    require(len(last) == 1, "want exactly one gen-0 'last' stroke")
    used = set()
    got = {}
    info = []
    for name, notes, (family, frame, inner), view, (lo, hi) in stroke_scopes(music, cues, camera):
        if name == "coda":
            require(len(cello) - 1 in notes, "the last cello note is not in the coda")
            got[len(cello) - 1] = last[0]
            used.add(last[0])
            notes = [i for i in notes if i != len(cello) - 1]
        pool = []
        for s in gen0:
            if s["id"] in used:
                continue
            fam = "pencil" if not s["kind"].startswith("wire") else s["kind"]
            if fam != family:
                continue
            if frame is not None and not score_lib.in_frame(mid[s["id"]], frame):
                continue
            if inner is not None and score_lib.in_frame(mid[s["id"]], inner):
                continue
            pool.append(s["id"])
        require(len(pool) >= len(notes), f"{name}: {len(pool)} candidate strokes for {len(notes)} notes")
        gn = dict(zip(notes, grades([cello[i][1] for i in notes]))) if notes else {}
        gs = dict(zip(pool, grades([strokes[s]["len"] for s in pool]))) if pool else {}
        fh = view[3] - view[1]

        def cost(i, s, view=view, lo=lo, hi=hi, fh=fh, gn=gn, gs=gs):
            ty = view[3] - score_lib.rel_height(cello[i][2], lo, hi) * fh
            return abs(ty - mid[s][1]) / fh + W_LEN * abs(gn[i] - gs[s]) / 2

        a = score_lib.assign([(i, cello[i][0]) for i in notes], pool, cost)
        require(len(a) == len(notes), f"{name}: {len(notes) - len(a)} notes without a stroke")
        got.update(a)
        used.update(a.values())
        info.append((name, len(notes), len(pool)))
    require(sorted(got) == list(range(len(cello))), "a cello note has no stroke")
    require(len(set(got.values())) == len(gen0), "gen-0 strokes left over or used twice")
    return got, info


def descendants(strokes):
    """{gen-0 id: its descendants in breadth-first order (children by id)}."""
    kids = {}
    for s in strokes:
        if s["parent"] >= 0:
            kids.setdefault(s["parent"], []).append(s["id"])
    out = {}
    for s in strokes:
        if s["gen"] != 0:
            continue
        order, queue = [], [s["id"]]
        while queue:
            nxt = []
            for p in queue:
                for c in sorted(kids.get(p, [])):
                    order.append(c)
                    nxt.append(c)
            queue = nxt
        out[s["id"]] = order
    return out


def make_strokes(music, strokes, got):
    cello = music["cello"]
    fams = descendants(strokes)
    events, steps = [], {}
    for i, sid in sorted(got.items()):
        t0, d, _, vel = cello[i]
        t0, d = fit(t0, min(d, END - t0), END)
        w = vel / 127
        s = strokes[sid]
        events.append({"s": sid, "t": t0, "d": d, "w": r6(w), "ink": r6(score_lib.ink_at(t0)),
                       "note": i, "gen": 0, "photo": s["kind"].startswith("wire")})
        fam = fams[sid]
        if not fam:
            continue
        step = score_lib.family_step(t0, len(fam), END)
        steps[sid] = step
        limit = min(t0 + score_lib.FAMILY_SPAN, END)
        for n, cid in enumerate(fam, 1):
            c = strokes[cid]
            t, dd = fit(t0 + n * step, step, limit)
            events.append({"s": cid, "t": t, "d": dd, "w": r6(w * CHILD_W[c["gen"]]),
                           "ink": r6(score_lib.ink_at(t)), "note": -1, "gen": c["gen"],
                           "photo": c["kind"].startswith("wire")})
    placed = sorted(e["s"] for e in events)
    require(placed == list(range(len(strokes))), "a stroke is not reached from any gen-0 stroke")
    events.sort(key=lambda e: (e["t"], e["gen"], e["s"]))
    return events, steps


# ---------------------------------------------------------------- flats

def height(leaf):
    return 1.0 - leaf["c"][1]


def make_flats(music, regions):
    piano = music["piano"]
    leaves = {l["id"]: l for l in regions["leaves"]}
    notes = [i for i, p in enumerate(piano) if B_PIANO[0] <= p[0] < B_PIANO[1]]
    lo, hi = min(piano[i][2] for i in notes), max(piano[i][2] for i in notes)
    rel = {i: score_lib.rel_height(piano[i][2], lo, hi) for i in notes}
    cand = sorted(i for i, l in leaves.items() if l["kind"] in FLAT_KINDS and l["size"] >= 1)
    require(len(cand) >= len(notes), f"{len(cand)} flat leaves for {len(notes)} notes")
    own = score_lib.assign([(i, piano[i][0]) for i in notes], cand,
                           lambda i, c: abs(rel[i] - height(leaves[c])))
    require(len(own) == len(notes), "a B piano note has no flat")
    # the upper voice of an attack on the higher leaf
    inb = set(notes)
    for _, ix in music["attacks"]:
        ix = [i for i in ix if i in inb]
        if len(ix) < 2:
            continue
        by_pitch = sorted(ix, key=lambda i: (piano[i][2], i))
        by_h = sorted((own[i] for i in ix), key=lambda c: (height(leaves[c]), c))
        own.update(zip(by_pitch, by_h))
    events = [(i, own[i]) for i in notes]
    for c in sorted(set(cand) - set(own.values())):
        i = min(notes, key=lambda n: (abs(rel[n] - height(leaves[c])), piano[n][0], n))
        events.append((i, c))
    out = [{"leaf": c, "t": r6(piano[i][0]), "note": i} for i, c in events]
    out.sort(key=lambda e: (e["t"], e["note"], e["leaf"]))
    return out, (lo, hi)


# ---------------------------------------------------------------- pieces

def group_info(regions):
    """Per group: leaves, total area, area-weighted centre c, height h = 1 - c.y, the kinds of
    its leaves, and its parent group (the group of the parent leaf of its largest leaf; None
    when that leaf has no parent or the parent is in the group itself)."""
    leaves = {l["id"]: l for l in regions["leaves"]}
    info = {}
    for name, ids in regions["groups"].items():
        ls = [leaves[i] for i in ids]
        a = sum(l["area"] for l in ls)
        cx = sum(l["area"] * l["c"][0] for l in ls) / a
        cy = sum(l["area"] * l["c"][1] for l in ls) / a
        big = max(ls, key=lambda l: (l["area"], -l["id"]))
        p = leaves.get(big["parent"])
        info[name] = {"leaves": list(ids), "area": a, "c": (cx, cy), "h": 1.0 - cy,
                      "kinds": {l["kind"] for l in ls},
                      "parent": p["group"] if p and p["group"] != name else None}
    return info


def assign_pieces(music, regions, cues):
    """Who brings which group.

    Returns own {note: its own group}, style {note: pinned style or None}, ride {group left
    over: ("group", g) | ("note", i)} with every chain resolved to a group that has its own
    note or to a high-chord note, how each rider got there {group: "parent" | "chord" |
    "near"}, and the pitch ranges.
    """
    piano, attacks, sec = music["piano"], music["attacks"], music["sections"]
    g = group_info(regions)
    notes = [i for i, p in enumerate(piano) if p[0] >= LATE_PIANO]
    rng = {}
    for i in notes:
        s = section_of(piano[i][0], sec)
        require(s in ("C", "coda"), f"piano note {i} at {piano[i][0]} is outside C and the coda")
        lo, hi = rng.get(s, (piano[i][2], piano[i][2]))
        rng[s] = (min(lo, piano[i][2]), max(hi, piano[i][2]))
    rel = {i: score_lib.rel_height(piano[i][2], *rng[section_of(piano[i][0], sec)]) for i in notes}

    def medium(n):
        return g[n]["area"] >= A_MED

    def small(n):
        return g[n]["area"] < A_MED and not g[n]["kinds"] & MASSY

    own, style = {}, {}
    for kind, entries in (("pin", cues["pins"]), ("develop", cues["develop"])):
        for e in entries:
            a = attacks[score_lib.nearest_attack(attacks, e["attack_t"], ATTACK_TOL)]
            ix = sorted(a[1], key=lambda i: (piano[i][2], i))
            require(len(e["groups"]) <= len(ix), f"{kind} at {e['attack_t']}: more groups than notes")
            for i, name in zip(ix, e["groups"]):
                require(name in g, f"{kind} at {e['attack_t']}: no group {name!r}")
                require(i in rel and i not in own, f"{kind} at {e['attack_t']}: note {i} taken or early")
                require(name not in own.values(), f"group {name!r} pinned twice")
                own[i] = name
                style[i] = "develop" if kind == "develop" else e.get("style")
    rest = [i for i in notes if i not in own]
    for i in rest:
        style[i] = None
    chords = [x for x in attacks if RIDERS[0] - ATTACK_TOL <= x[0] <= RIDERS[1] + ATTACK_TOL]
    require(len(chords) == 6, f"{len(chords)} high chords in {RIDERS}, want 6")
    in_chords = {i for x in chords for i in x[1]}

    def take(a):
        own.update(a)
        free.difference_update(a.values())

    # notes outside the six high chords: medium-or-larger groups only, big before small. The
    # run is one batch aimed over its own pitch range; the others go attack by attack.
    free = set(g) - set(own.values())
    run_lo, run_hi = cues["run"]
    run = [i for i in rest if run_lo <= piano[i][0] < run_hi]
    others = [i for i in rest if i not in in_chords and i not in run]
    batches = [(run, None)] if run else []
    for _, ix in attacks:
        b = [i for i in ix if i in others]
        if b:
            batches.append((b, rng[section_of(piano[b[0]][0], sec)]))
    # Top-level groups (no parent group: blocks, walls, trees) first; their children only for
    # the notes the top-level pool cannot serve.
    fallback = []
    for batch, prange in sorted(batches, key=lambda b: min(piano[i][0] for i in b[0])):
        if prange is None:
            prange = (min(piano[i][2] for i in batch), max(piano[i][2] for i in batch))
        for i in sorted((i for i in batch if piano[i][2] < LOW_PITCH), key=lambda i: (piano[i][0], i)):
            pool = [n for n in free if medium(n) and g[n]["parent"] is None]
            if not pool:
                pool = [n for n in free if medium(n)]
                fallback.append(i)
            require(pool, f"no medium-or-larger group left for piano note {i}")
            take({i: max(pool, key=lambda n: (g[n]["area"], n))})
        high = [i for i in batch if piano[i][2] >= LOW_PITCH]
        target = {i: score_lib.rel_height(piano[i][2], *prange) for i in high}
        for tier in (True, False):
            todo = [i for i in high if i not in own]
            if not todo:
                break
            pool = sorted(n for n in free if medium(n) and (g[n]["parent"] is None) == tier)
            a = score_lib.assign([(i, piano[i][0]) for i in todo], pool, lambda i, n: abs(target[i] - g[n]["h"]))
            if not tier:
                fallback.extend(sorted(a))
            take(a)
        require(all(i in own for i in high), f"too few medium-or-larger groups for piano notes {high}")
    # the six high chords: small groups, by height in the section's range
    hi_notes = [i for i in rest if i in in_chords]
    a = score_lib.assign([(i, piano[i][0]) for i in hi_notes], sorted(n for n in free if small(n)),
                         lambda i, n: abs(rel[i] - g[n]["h"]))
    require(len(a) == len(hi_notes), "too few small groups for the six high chords")
    take(a)

    # groups left over: with their parent group, else small ones on the six chords, else
    # with the nearest group placed outside the chords
    k = regions["w"] / regions["h"]
    ride, how = {}, {}
    dealt = []
    for n in sorted(free):
        if g[n]["parent"] is not None:
            ride[n], how[n] = ("group", g[n]["parent"]), "parent"
        elif small(n):
            dealt.append(n)
        else:
            how[n] = "near"
    dealt.sort(key=lambda n: (math.atan2(g[n]["c"][1] - 0.5, (g[n]["c"][0] - 0.5) * k), n))
    for j, n in enumerate(dealt):
        ix = chords[j % len(chords)][1]
        ride[n] = ("note", min(ix, key=lambda i: (abs(rel[i] - g[n]["h"]), piano[i][0], i)))
        how[n] = "chord"
    by_group = {n: i for i, n in own.items()}
    outside = sorted(n for n, i in by_group.items() if not HIGH_SPAN[0] <= piano[i][0] <= HIGH_SPAN[1])
    for n in sorted(x for x, h in how.items() if h == "near"):
        c = (g[n]["c"][0] * k, g[n]["c"][1])
        ride[n] = ("group", min(outside, key=lambda o: (math.dist(c, (g[o]["c"][0] * k, g[o]["c"][1])), o)))

    def final(n, seen=()):
        if n in by_group or ride[n][0] == "note":
            return n
        require(n not in seen, f"riding groups in a circle: {', '.join(seen)}")
        return final(ride[n][1], seen + (n,))

    ride = {n: ride[n] if ride[n][0] == "note" else ("group", final(n)) for n in ride}
    return own, style, ride, how, rng, fallback


def make_pieces(music, regions, cues):
    piano = music["piano"]
    leaves = {l["id"]: l for l in regions["leaves"]}
    g = group_info(regions)
    own, style, ride, how, rng, fallback = assign_pieces(music, regions, cues)
    k = regions["w"] / regions["h"]

    def event(i, centre, st):
        t, d = fit(piano[i][0], min(piano[i][1], END - piano[i][0]), END)
        st = st or ("develop" if piano[i][1] >= LONG_NOTE else "slam")
        return {"t": t, "d": d, "note": i, "style": st,
                "from": [r6(v) for v in score_lib.piece_from(i, centre, k)]}

    ev = {n: event(i, g[n]["c"], style[i]) for i, n in own.items()}
    for n, (kind, x) in ride.items():
        if kind == "note":
            ev[n] = event(x, g[n]["c"], None)
    for n, (kind, x) in ride.items():
        if kind == "group":
            ev[n] = ev[x]
    require(sorted(ev) == sorted(g), "a group has no event")
    out = []
    for n in sorted(ev):
        e = ev[n]
        for lid in g[n]["leaves"]:
            out.append({"leaf": lid, "size": leaves[lid]["size"], "t": e["t"], "d": e["d"],
                        "note": e["note"], "style": e["style"], "from": e["from"]})
    out.sort(key=lambda e: (e["t"], e["leaf"]))
    return out, own, ride, how, rng, fallback


# ---------------------------------------------------------------- the collage

def b_bars(music):
    """(two_bars_end, cover_by): two bars into B, and the last piano attack before two bars
    after that (by when every flat is covered by the collage)."""
    two = r6(music["sections"]["B"][0] + 2 * score_lib.BAR)
    return two, r6(max(a[0] for a in music["attacks"] if a[0] < two + 2 * score_lib.BAR))


def collage_rows(music, collage, regions, arrivals, pieces, glue):
    """Split the arrivals of B into the flats and the collage.

    -> flats [{leaf, t, note, until}] (the arrivals up to two bars into B), the collage rows
    [{leaf, block, t, note, off, tear}] (every leaf of the blocks, (t, leaf) order), the blocks
    [{name, first, stop}] (assets/collage.json's order), (two_bars_end, cover_by)."""
    piano = music["piano"]
    two, cover_by = b_bars(music)
    block_of = {i: b for b, blk in enumerate(collage["blocks"]) for i in blk["leaves"]}
    require(sorted(e["leaf"] for e in arrivals) == sorted(block_of),
            "the leaves arriving on the piano of B are not the leaves of the collage blocks "
            "(assets/collage.json): run tools/pick_collage.py and tools/make_collage.py again")
    later = {}                       # block -> its first arrival after the two bars
    for e in arrivals:
        if e["t"] > two:
            b = block_of[e["leaf"]]
            later[b] = min(later.get(b, e["t"]), e["t"])
    piece = {e["leaf"]: e for e in pieces}
    biggest = {}                     # cut-out (t, note) -> the size of its largest piece
    for e in pieces:
        biggest[e["t"], e["note"]] = max(biggest.get((e["t"], e["note"]), 0), e["size"])
    flats, rows = [], []
    for e in arrivals:
        b = block_of[e["leaf"]]
        t, note = e["t"], e["note"]
        if t <= two:
            t = min(later.get(b, cover_by), cover_by)
            flats.append(dict(e, until=t))
            note = min(i for i, p in enumerate(piano) if abs(p[0] - t) < 1e-9)
        p = piece[e["leaf"]]
        tear = biggest[p["t"], p["note"]] >= TEAR_MIN_SIZE and p["style"] in TEAR_STYLES and p["t"] < glue
        rows.append({"leaf": e["leaf"], "block": b, "t": t, "note": note, "off": p["t"], "tear": tear})
    rows.sort(key=lambda r: (r["t"], r["leaf"]))
    area = {l["id"]: l["area"] for l in regions["leaves"]}
    blocks = []
    for b, blk in enumerate(collage["blocks"]):
        widest = max(blk["leaves"], key=lambda i: (area[i], -i))
        blocks.append({"name": blk["name"], "first": min(r["t"] for r in rows if r["block"] == b),
                       "stop": min(glue, piece[widest]["t"])})
    return flats, rows, blocks, (two, cover_by)


def screen_blocks(col, collage, regions):
    """The score's collage blocks as score_lib.schedule_changes takes them."""
    area = {l["id"]: l["area"] for l in regions["leaves"]}
    return [{"leaves": [(r["t"], r["off"], area[r["leaf"]]) for r in col["leaves"] if r["block"] == b],
             "stop": row["stop"], "cuts": len(collage["blocks"][b]["cuts"]), "accent": collage["blocks"][b]["accent"]}
            for b, row in enumerate(col["blocks"])]


def changing_notes(music, cues, glue):
    """[(cello note, t)] of the notes that may change the collage's images: before the glue chord
    and outside the solo wires (the coda is after the glue)."""
    lo, hi = cues["solo_wires"]
    return [(i, c[0]) for i, c in enumerate(music["cello"]) if c[0] < glue and not lo <= c[0] < hi]


def collage_changes(notes, blocks):
    """{strength: {start, events}} for every strength of STRENGTHS."""
    out = {}
    for name, mean in STRENGTHS.items():
        start, events = score_lib.schedule_changes(notes, blocks, mean, COLLAGE_SEED, COLLAGE_LIMITS,
                                                   accent_min=ACCENT_MIN)
        out[name] = {"start": start, "events": [dict(e, t=r6(e["t"])) for e in events]}
    return out


def accent_since(changes, b, row):
    """When accent block b starts showing the cut it shows at its stop (its accent): its last
    change in this strength, or its first when it starts on it. row: its score collage block."""
    mine = [e for e in changes["events"] if e["block"] == b]
    return mine[-1]["t"] if mine else row["first"]


def check_collage(score, music, regions, collage, cues):
    """Design 10.4's collage check; stops (nothing written) when the score breaks it."""
    col, glue = score["collage"], score["glue"]
    cello, piano, attacks = music["cello"], music["piano"], music["attacks"]
    lim = col["limits"]
    lo, hi = cues["solo_wires"]
    require([b["name"] for b in col["blocks"]] == [b["name"] for b in collage["blocks"]],
            "the collage's blocks are not those of assets/collage.json")
    blocks = screen_blocks(col, collage, regions)
    # every flat is covered by the collage before the end of B, by cover_by
    for e in score["flats"]:
        require(e["until"] <= col["cover_by"] and e["until"] < music["sections"]["B"][1],
                f"the flat of leaf {e['leaf']} is covered by the collage only at {e['until']}")
    # every leaf's photo comes with its piece; after the glue chord only the coda's tree and two
    # white squares show the collage, and they become photos on the coda's notes
    piece = {e["leaf"]: e for e in score["pieces"]}
    for r in col["leaves"]:
        require(r["off"] == piece[r["leaf"]]["t"], f"leaf {r['leaf']}: the collage leaves at {r['off']}, its piece is at {piece[r['leaf']]['t']}")
    for g in LEFT_AFTER_GLUE:
        require(g in regions["groups"], f"no group {g!r} in assets/regions.json")
    chord = attacks[score_lib.nearest_attack(attacks, cues["glue_attack_t"], ATTACK_TOL)]
    last = max(piano[i][0] for i in chord[1])
    left = sorted(r["leaf"] for r in col["leaves"] if r["off"] > last)
    want = sorted(i for g in LEFT_AFTER_GLUE for i in regions["groups"][g])
    require(left == want, f"the collage is left after the glue chord on leaves {left}, want those of "
                          f"{', '.join(LEFT_AFTER_GLUE)} ({want})")
    times = [piano[i][0] for t in LEFT_ATTACKS for i in attacks[score_lib.nearest_attack(attacks, t, ATTACK_TOL)][1]]
    for r in col["leaves"]:
        require(r["off"] <= last or any(abs(r["off"] - x) <= 1e-6 for x in times),
                f"leaf {r['leaf']} becomes a photo at {r['off']}, not on the coda notes of {LEFT_ATTACKS}")
    for k, ch in col["changes"].items():
        ev = ch["events"]
        require([e["t"] for e in ev] == sorted(e["t"] for e in ev), f"{k}: the changes are not in time order")
        per, prev = {}, {}
        for e in ev:
            b, t = e["block"], e["t"]
            name = col["blocks"][b]["name"]
            require(t < glue and not lo <= t < hi and abs(t - cello[e["note"]][0]) <= 1e-6,
                    f"{k}: {name} changes at {t}, not on a cello note that may change images")
            require(col["blocks"][b]["first"] <= t < col["blocks"][b]["stop"],
                    f"{k}: {name} changes at {t}, outside its first {col['blocks'][b]['first']} - stop {col['blocks'][b]['stop']}")
            on = score_lib.blocks_on_screen(blocks, t)
            require(b in on, f"{k}: {name} changes at {t}, off screen")
            per[e["note"]] = per.get(e["note"], 0.0) + on[b]
            if b in prev:
                gap = lim["gap_few"] if len(on) < lim["many"] else lim["gap_many"]
                require(e["note"] - prev[b] >= gap, f"{k}: {name} changes on cello notes {prev[b]} and {e['note']} "
                                                    f"with {len(on)} blocks on screen (least gap {gap})")
            prev[b] = e["note"]
        for note, a in sorted(per.items()):
            require(a <= lim["area"] + 1e-9, f"{k}: {a:.4f} of the picture changes on cello note {note} (limit {lim['area']})")
        for b, blk in enumerate(collage["blocks"]):
            seq = [ch["start"][b]] + [e["to"] for e in ev if e["block"] == b]
            require(len(set(seq)) == len(seq) and all(0 <= x < len(blk["cuts"]) for x in seq),
                    f"{k}: {blk['name']} shows the cuts {seq} (one cut twice, or one it does not have)")
            require(blk["accent"] < 0 or seq[-1] == blk["accent"],
                    f"{k}: {blk['name']} shows cut {seq[-1]} when its photo comes, not its accent {blk['accent']}")
            if blk["accent"] >= 0:
                row = col["blocks"][b]
                since = accent_since(ch, b, row)
                require(row["stop"] - since >= ACCENT_MIN - 1e-6,
                        f"{k}: {blk['name']} shows its accent from {since} only {row['stop'] - since:.2f} s "
                        f"before its photo at {row['stop']} (at least {ACCENT_MIN})")
        # a picture-in-picture room shows its later leaves from its window's start (src/timeline.js
        # pipCollage) until the change to its accent comes down on the window (a room without one, or
        # without that change: until its photo has covered every leaf, so at least until its stop). A
        # leaf arriving after that would vanish when the window ends and come back at its own time.
        for p in score.get("pip", []):
            row = col["blocks"][p["block"]]
            acc = next((e["t"] for e in ev if e["block"] == p["block"] and e["to"] == p["accent"] and e["t"] >= p["t"]),
                       None) if p["accent"] >= 0 else None
            end, what = (acc, "its accent") if acc is not None else (row["stop"], "its photo")
            for r in col["leaves"]:
                if r["block"] == p["block"]:
                    require(r["t"] < end, f"{k}: {row['name']} is a window from {p['t']}, but its leaf {r['leaf']} arrives "
                                          f"at {r['t']}, not before {what} at {end}: it would vanish when the window ends")


# ---------------------------------------------------------------- the score

def compose(inp):
    """(score, the assignment behind it for the table)."""
    music, regions, strokes, cues = inp["music"], inp["regions"], inp["strokes"], inp["cues"]
    fp = region_map(inp)
    k = regions["h"] / regions["w"]
    camera = make_camera(music, cues)
    got, pools = assign_strokes(music, cues, camera, strokes, k)
    st, steps = make_strokes(music, strokes, got)
    arrivals, b_range = make_flats(music, regions)
    pieces, own, ride, how, rng, fallback = make_pieces(music, regions, cues)
    glue = r6(music["attacks"][score_lib.nearest_attack(music["attacks"], cues["glue_attack_t"], ATTACK_TOL)][0])
    flats, rows, blocks, (two, cover_by) = collage_rows(music, inp["collage"], regions, arrivals, pieces, glue)
    col = {"two_bars_end": two, "cover_by": cover_by, "limits": dict(COLLAGE_LIMITS), "blocks": blocks,
           "leaves": rows, "default": DEFAULT_STRENGTH}
    notes = changing_notes(music, cues, glue)
    col["changes"] = collage_changes(notes, screen_blocks(col, inp["collage"], regions))
    score = {"regions": fp, "glue": glue, "end": END, "camera": camera,
             "washes": make_washes(music, regions, cues, camera, inp["ids"]),
             "strokes": st, "flats": flats, "pieces": pieces, "collage": col,
             "shake": make_shake(cues, glue), "pip": make_pip(music, cues, col, inp["collage"])}
    check_collage(score, music, regions, inp["collage"], cues)
    info = {"got": got, "pools": pools, "steps": steps, "b_range": b_range, "own": own,
            "ride": ride, "how": how, "ranges": rng, "fallback": fallback, "arrivals": arrivals,
            "collage_notes": notes}
    return score, info


def build(inp=None):
    return compose(inp or load_inputs())[0]


def dumps(score):
    return json.dumps(score, separators=(",", ":"), ensure_ascii=False) + "\n"


# ---------------------------------------------------------------- the table for people

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pitch_name(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def collage_lines(score, inp, info):
    """The collage part of the table: changes per strength, per block, blocks out of cuts and the
    averages on the notes with DENSE or more blocks on screen."""
    col, manifest = score["collage"], inp["collage"]
    cello = inp["music"]["cello"]
    lim = col["limits"]
    blocks = screen_blocks(col, manifest, inp["regions"])
    flat = {e["leaf"] for e in score["flats"]}
    torn = sum(r["tear"] for r in col["leaves"])
    notes = info["collage_notes"]
    L = [f"collage: two bars end {col['two_bars_end']}, flats covered by {col['cover_by']}; {len(flat)} flats, "
         f"{len(col['leaves']) - len(flat)} leaves arrive as collage; {torn} of {len(col['leaves'])} torn off by their photo "
         f"(cut-out size >= {TEAR_MIN_SIZE}, {'/'.join(TEAR_STYLES)}, before the glue)",
         f"collage limits: area {lim['area']} a note, gap {lim['gap_few']} notes ({lim['gap_many']} from {lim['many']} "
         f"blocks on screen); {len(notes)} cello notes may change images; seed {COLLAGE_SEED}"]
    ch = col["changes"]
    L.append("collage changes (mean notes between a block's changes): "
             + ", ".join(f"{k} {STRENGTHS[k]} -> {len(ch[k]['events'])}" for k in ch) + f" (default {col['default']})")
    used = {k: {(b, c) for b, c in enumerate(ch[k]["start"])} | {(e["block"], e["to"]) for e in ch[k]["events"]} for k in ch}
    L.append("collage cuts shown (to bake): " + ", ".join(f"{k} {len(used[k])}" for k in ch)
             + f", all strengths {len(set().union(*used.values()))}")
    screen = {i: score_lib.blocks_on_screen(blocks, cello[i][0]) for i, _ in notes}
    dense = [i for i, _ in notes if len(screen[i]) >= DENSE]
    if dense:
        avg = []
        for k in ch:
            hit = [e for e in ch[k]["events"] if e["note"] in dense]
            avg.append(f"{k} {len(hit) / len(dense):.2f} blocks / {sum(screen[e['note']][e['block']] for e in hit) / len(dense):.3f} area")
        L.append(f"collage per note on the {len(dense)} cello notes with >= {DENSE} blocks on screen "
                 f"(mean {sum(len(screen[i]) for i in dense) / len(dense):.1f} on screen): " + ", ".join(avg))
    out = []
    for k in ch:
        for b, blk in enumerate(manifest["blocks"]):
            mine = [e for e in ch[k]["events"] if e["block"] == b]
            most = len([c for c in range(len(blk["cuts"])) if c != blk["accent"]]) - 1
            if mine and len(mine) == most:
                out.append(f"{k} {blk['name']} (last change {mine[-1]['t']:.2f}, stop {col['blocks'][b]['stop']:.2f})")
    L.append("collage blocks out of cuts: " + (", ".join(out) if out else "none"))
    L.append(f"collage accents (from when, s on screen before the block's photo; {'/'.join(ch)}; "
             f"at least {ACCENT_MIN} s, 'start' = the block starts on it):")
    for b, (row, blk) in enumerate(zip(col["blocks"], manifest["blocks"])):
        if blk["accent"] < 0:
            continue
        cells = []
        for k in ch:
            since = accent_since(ch[k], b, row)
            starts_on_it = not any(e["block"] == b for e in ch[k]["events"])
            cells.append(f"{k} {since:6.2f} ({row['stop'] - since:5.2f} s{', start' if starts_on_it else ''})")
        L.append(f"     {blk['name']:18s} photo {row['stop']:6.2f}: " + ", ".join(cells))
    L.append("collage blocks (cuts, accent; changes " + "/".join(ch) + "; collage first - stop; leaves):")
    for b, (row, blk) in enumerate(zip(col["blocks"], manifest["blocks"])):
        n = "/".join(str(sum(e["block"] == b for e in ch[k]["events"])) for k in ch)
        acc = f"accent {blk['accent']}" if blk["accent"] >= 0 else "no accent"
        L.append(f"  {b:2d} {blk['name']:18s} {len(blk['cuts'])} cuts, {acc:9s}; changes {n:9s}; "
                 f"{row['first']:6.2f} - {row['stop']:6.2f}; {len(blk['leaves'])} leaf{'' if len(blk['leaves']) == 1 else 's'}")
    return L


def table(score, inp, info):
    music, regions, strokes = inp["music"], inp["regions"], inp["strokes"]
    cello, piano = music["cello"], music["piano"]
    leaves = {l["id"]: l for l in regions["leaves"]}
    k = regions["h"] / regions["w"]
    camera = score["camera"]
    got, scope_info, steps = info["got"], info["pools"], info["steps"]
    (blo, bhi), own, rng = info["b_range"], info["own"], info["ranges"]
    ride, how = info["ride"], info["how"]
    g = group_info(regions)
    by_group = {n: i for i, n in own.items()}
    first = {}
    for e in score["pieces"]:
        first.setdefault(leaves[e["leaf"]]["group"], e)
    fams = descendants(strokes)
    mid = {sid: score_lib.midpoint(strokes[sid]["pts"], k) for sid in got.values()}

    L = ["fractal: the score (assets/score.json). Audio time in seconds.", ""]
    n_gen = [sum(e["gen"] == q for e in score["strokes"]) for q in range(3)]
    L.append(f"events: camera {len(camera)}, washes {len(score['washes'])}, strokes {len(score['strokes'])} "
             f"(gen 0/1/2 {n_gen[0]}/{n_gen[1]}/{n_gen[2]}), flats {len(score['flats'])}, "
             f"collage leaves {len(score['collage']['leaves'])}, "
             f"pieces {len(score['pieces'])} (groups {len(g)}); glue {score['glue']}, end {score['end']}")
    L.append("stroke pools: " + ", ".join(f"{n} {a} notes / {b} strokes" for n, a, b in scope_info))
    big = max(fams, key=lambda s: (len(fams[s]), -s))
    L.append(f"largest family: stroke {big} ({strokes[big]['kind']}), {len(fams[big])} descendants, "
             f"step {steps[big]:.4f} s (BAR/16 = {score_lib.CHILD_STEP:.4f})")
    chords = a_chords(music)
    cuts = [0.0] + [a[0] for a in chords[1:]] + [music["sections"]["A"][1]]
    corr = []
    for q in range(4):
        ix = [i for i in got if cuts[q] <= cello[i][0] < cuts[q + 1]]
        corr.append(f"A x{ZOOMS[q]} {score_lib.rank_corr([cello[i][2] for i in ix], [1 - mid[got[i]][1] for i in ix]):.3f}")
    arr = info["arrivals"]
    corr.append(f"B arrivals {score_lib.rank_corr([piano[e['note']][2] for e in arr], [height(leaves[e['leaf']]) for e in arr]):.3f}")
    climb = sorted((i for a in music["attacks"] if 34.34 <= a[0] <= 37.12 for i in a[1]),
                   key=lambda i: (piano[i][0], i))
    corr.append(f"climb {score_lib.rank_corr(list(range(len(climb))), [g[own[i]]['h'] for i in climb]):.3f}")
    L.append("rank correlations (pitch or time vs height): " + ", ".join(corr))
    n_med = sum(1 for n in g if g[n]["area"] >= A_MED)
    L.append(f"W_LEN {W_LEN}; A_MED {A_MED}: {n_med} groups medium or larger, {len(g) - n_med} smaller")
    rc = [x for x in music["attacks"] if RIDERS[0] - ATTACK_TOL <= x[0] <= RIDERS[1] + ATTACK_TOL]
    per = []
    for a in rc:
        at = [n for n, e in first.items() if e["note"] in a[1]]
        mine = sum(1 for n in at if n in by_group)
        per.append(f"{a[0]:.2f} {mine}/{len(at) - mine}")
    L.append("groups on the six high chords (own/riders): " + ", ".join(per))
    kinds = {h: sum(1 for x in how.values() if x == h) for h in ("parent", "chord", "near")}
    L.append(f"leftover groups: {len(how)} ({kinds['parent']} with their parent group, "
             f"{kinds['chord']} dealt to the high chords, {kinds['near']} with the nearest group)")
    near = [f"{n} -> {ride[n][1]} ({first[n]['t']:.2f})" for n in sorted(how) if how[n] == "near"]
    L.append("medium-or-larger orphans: " + (", ".join(near) if near else "none"))
    fb = [f"{pitch_name(piano[i][2])} {piano[i][0]:.2f} -> {own[i]} (child of {g[own[i]]['parent']})"
          for i in info["fallback"]]
    L.append("notes given a medium-or-larger child (top-level pool ran out): " + (", ".join(fb) if fb else "none"))
    L.append(f"height ranges: B piano {pitch_name(blo)}-{pitch_name(bhi)}, "
             + ", ".join(f"{s} piano {pitch_name(a)}-{pitch_name(b)}" for s, (a, b) in sorted(rng.items())))
    L.append("")
    L.extend(collage_lines(score, inp, info))
    L.append("")

    rows = []
    for e in camera:
        what = f"camera x{e['zoom']} at ({e['c'][0]:.3f}, {e['c'][1]:.3f})"
        if "hold" in e:
            what += f", punch-in: hold {e['hold']}, ease {e['ease']}"
        rows.append((e["t"], 0, "camera", "", what))
    for w in score["washes"]:
        rows.append((w["t"], 1, "piano", "chord", f"wash gain {w['gain']:.2f} d {w['d']:.2f} over {len(w['leaves'])} mass/part leaves"))
    for i, sid in sorted(got.items()):
        s = strokes[sid]
        x, y = mid[sid]
        extra = f", +{len(fams[sid])} children every {steps[sid]:.3f} s" if fams[sid] else ""
        rows.append((cello[i][0], 2, "cello", f"{pitch_name(cello[i][2])} v{cello[i][3]}",
                     f"stroke {sid} {s['kind']} len {s['len']:.3f} at ({x:.2f}, {y:.2f}) h {1 - y:.2f}"
                     f"{' LAST' if s.get('last') else ''}{extra}"))
    for e in score["flats"]:
        l = leaves[e["leaf"]]
        rows.append((e["t"], 3, "piano", pitch_name(piano[e["note"]][2]),
                     f"flat {l['name']} ({l['kind']} size {l['size']}) h {height(l):.2f}, collage from {e['until']:.2f}"))
    flat = {e["leaf"] for e in score["flats"]}
    names = [b["name"] for b in score["collage"]["blocks"]]
    for r in score["collage"]["leaves"]:
        l = leaves[r["leaf"]]
        what = (f"collage covers the flat {l['name']}" if r["leaf"] in flat else
                f"collage {l['name']} ({l['kind']} size {l['size']}) h {height(l):.2f}")
        rows.append((r["t"], 3, "piano", pitch_name(piano[r["note"]][2]),
                     f"{what} in {names[r['block']]}, photo at {r['off']:.2f}{' (torn off)' if r['tear'] else ''}"))
    seen = set()
    for e in score["pieces"]:
        name = leaves[e["leaf"]]["group"]
        if name in seen:
            continue
        seen.add(name)
        i = e["note"]
        tag = ""
        if name in how:
            tag = (" (dealt to the chord)" if ride[name][0] == "note" else
                   f" (rides with {ride[name][1]}: {how[name]})")
        rows.append((e["t"], 4, "piano", pitch_name(piano[i][2]),
                     f"piece {name} [{len(g[name]['leaves'])}] {e['style']} area {g[name]['area']:.4f} "
                     f"h {g[name]['h']:.2f}{tag}"))
    rows.sort(key=lambda r: (r[0], r[1], r[3], r[4]))
    heads = {"A": "A. lines", "B": "B. planes", "C": "C. objects", "coda": "coda"}
    cur = None
    for t, _, voice, note, what in rows:
        s = section_of(t, music["sections"]) if t >= music["sections"]["A"][0] else None
        if s != cur and s in heads:
            L.append("")
            L.append(f"---- {heads[s]} ({music['sections'][s][0]:.3f}-{music['sections'][s][1]:.3f})")
            cur = s
        L.append(f"{t:7.3f}  {voice:6s} {note:8s} {what}")
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--table", default=TABLE)
    args = ap.parse_args(argv)
    inp = load_inputs()
    score, info = compose(inp)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(score))
    text = table(score, inp, info)
    os.makedirs(os.path.dirname(os.path.abspath(args.table)), exist_ok=True)
    with open(args.table, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"{os.path.relpath(args.out, ROOT)}: " + text.split("\n")[2])
    print("\n".join(text.split("\n")[3:8]))
    print("\n".join(collage_lines(score, inp, info)[:6]))


if __name__ == "__main__":
    main()

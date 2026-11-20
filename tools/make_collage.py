"""The collage's cuts: data/collage.json and the reference originals -> assets/collage.json; the baked cuts.

    .venv\\Scripts\\python.exe tools\\make_collage.py               the list (assets/collage.json) and the sheets
    .venv\\Scripts\\python.exe tools\\make_collage.py --bake        the cuts the score uses -> assets/collage/
    .venv\\Scripts\\python.exe tools\\make_collage.py --bake --all  every cut of the list
    .venv\\Scripts\\python.exe tools\\make_collage.py --check       are the baked cuts the score uses there and current?

Every cut shows its source at the key image's scale (collage_lib.SCALE): a cut is the block's box in
source px. A block's first n cuts are its picked images from data/collage.json, in that order. Then
the other cuts: other places of the same images (collage_lib.other_cuts), one round at a time in the
order of the images, an image with no more room skipped in that round, CUTS_MAX cuts in all at most.
The accent image gets no other cuts: it is the block's last change and is seen only as the accent.
An other cut carries the colour shift of the picked cut it comes from, keeps out of the areas of
data/collage_sources.json and out of the letterbox bands of its source (edge rows or columns whose
mean is at most DARK). Choosing reads the ORIGINALS only (collage_lib.ref_path), so the list does not
depend on the upscales. The plain run also writes, to look at, local-only/temp/collage/:
cuts_<no>_<name>.jpg (every cut of a block from the original at thumbnail size, tilted and
colour-shifted, outside the block's silhouette paled; under it each image with its cuts outlined)
and log.txt.

Baking (collage_lib.bake_cut): the cut's area plus a margin, from the 2x upscale of its source
(local-only/assets/collage_src/, tools/upscale_refs.py), to (bw + 2m) x (bh + 2m) px at 4K, colour
shift applied, far from the block's leaves flat; lossless WebP assets/collage/b<row>_<k>.webp. The
cuts baked are those of assets/score.json's collage.changes (every strength: start and events[].to),
or the picked cuts while the score has no collage, or with --all all of them. assets/collage/baked.json
records each file's key (the sha1 of what it was made from, bake_key; the list carries every cut's key
as "key", and the page refuses a file whose recorded key is not its cut's), so a file whose cut changed
is baked again and a stale file is never taken for current; files no longer used are removed. A missing original or
upscale does not stop the others: they are listed at the end and the tool exits non-zero. Files are
written to a temporary name and renamed.
"""
import argparse
import hashlib
import json
import math
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import collage_lib  # noqa: E402

CUTS_MAX = 48            # cuts per block at most (starting value)
SEED = 20261117
DARK = 12                # letterbox: an edge row or column whose mean is at most this (the sheet's valid_y)
INSET = 4                # px kept clear of a letterbox band
BAKE_VERSION = 1         # part of a baked file's key: raise it when bake_cut changes what it makes

MANIFEST = "assets/collage.json"
OUT_DIR = "assets/collage"
BAKED = "assets/collage/baked.json"
WORK = str(paths.TEMP / "collage")

SOURCE_KEYS = {"note", "avoid_max", "keep_out_max", "images"}
AREA_KEYS = {"avoid", "within", "keep_out"}


def _load(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return json.load(f)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def _box(where, b):
    ok = (isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in b)
          and 0 <= b[0] < b[2] <= 1 and 0 <= b[1] < b[3] <= 1)
    if not ok:
        raise SystemExit("data/collage_sources.json: %s: %r is not a box [x0, y0, x1, y1] in 0..1" % (where, b))
    return b


def load_sources(root=ROOT):
    """data/collage_sources.json, checked -> {avoid_max, keep_out_max, images: {<folder>/<file>: {avoid, within, keep_out}}}."""
    conf = _load(root, "data/collage_sources.json")
    extra = sorted(set(conf) - SOURCE_KEYS)
    if extra:
        raise SystemExit("data/collage_sources.json: unknown key %s (allowed: %s)" % (", ".join(extra), ", ".join(sorted(SOURCE_KEYS))))
    images = {}
    for name, e in conf.get("images", {}).items():
        if collage_lib.ref_name(name) != name:
            raise SystemExit("data/collage_sources.json: %r is not a name <folder>/<file>" % name)
        extra = sorted(set(e) - AREA_KEYS)
        if extra:
            raise SystemExit("data/collage_sources.json: %s: unknown key %s (allowed: %s)" % (name, ", ".join(extra), ", ".join(sorted(AREA_KEYS))))
        images[name] = {
            "avoid": [_box(name, b) for b in e.get("avoid", [])],
            "within": None if e.get("within") is None else _box(name, e["within"]),
            "keep_out": [_box(name, b) for b in e.get("keep_out", [])],
        }
    return {"avoid_max": float(conf.get("avoid_max", collage_lib.AVOID_MAX)),
            "keep_out_max": float(conf.get("keep_out_max", collage_lib.KEEP_OUT_MAX)), "images": images}


def picture_box(rgb):
    """The part of a source that is picture, without letterbox bands at its edges -> [x0, y0, x1, y1] in 0..1."""
    g = rgb.mean(axis=2, dtype=np.float32)
    h, w = g.shape
    rows, cols = np.flatnonzero(g.mean(axis=1) > DARK), np.flatnonzero(g.mean(axis=0) > DARK)
    y0 = int(rows[0]) + INSET if rows[0] > 0 else 0
    y1 = int(rows[-1]) + 1 - INSET if rows[-1] < h - 1 else h
    x0 = int(cols[0]) + INSET if cols[0] > 0 else 0
    x1 = int(cols[-1]) + 1 - INSET if cols[-1] < w - 1 else w
    return [x0 / w, y0 / h, x1 / w, y1 / h]


def _meet(a, b):
    if a is None:
        return b
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


def _ids(root):
    with Image.open(os.path.join(root, "assets", "regions_id.png")) as im:
        return np.asarray(im).astype(np.int32)


def block_mask(ids, block):
    """The block's silhouette over its box as a GRID x GRID weight map (share of each cell inside)."""
    x0, y0, x1, y1 = block["bbox"]
    h, w = ids.shape
    sub = ids[int(y0 * h):math.ceil(y1 * h), int(x0 * w):math.ceil(x1 * w)]
    inside = np.isin(sub, block["leaves"]).astype(np.float32)
    g = collage_lib.GRID
    return cv2.resize(inside, (g, g), interpolation=cv2.INTER_AREA).astype(np.float64)


class _Pictures:
    """Decoded images by path (repository-relative), the last few kept."""

    def __init__(self, root, keep=6):
        self.root, self.keep, self.cache = root, keep, {}

    def get(self, rel):
        if rel in self.cache:
            self.cache[rel] = self.cache.pop(rel)
        else:
            if len(self.cache) >= self.keep:
                self.cache.pop(next(iter(self.cache)))
            with Image.open(os.path.join(self.root, rel)) as im:
                self.cache[rel] = np.asarray(im.convert("RGB"))
        return self.cache[rel]


def _delta(shift):
    d = collage_lib.shift_delta(shift)
    return None if d is None else [float(v) for v in d]


def cut_file(row, k):
    """The file of cut k of block row `row`, as the manifest names it (under assets/)."""
    return "collage/b%02d_%03d.webp" % (row, k)


# ---------------------------------------------------------------- the list

def build_manifest(root=ROOT):
    """-> the manifest (assets/collage.json). Reads the originals' pixels; writes nothing."""
    return _build(root)[0]


def _build(root):
    data = _load(root, "data/collage.json")
    regions = _load(root, "assets/regions.json")
    if data["regions"] != regions["fingerprint"]:
        raise SystemExit("data/collage.json was made from another region map (regions %s, assets/regions.json has %s); "
                         "run tools/pick_collage.py" % (data["regions"], regions["fingerprint"]))
    conf = load_sources(root)
    ids = _ids(root)
    pics = _Pictures(root)
    frames = {}
    out, log = [], []
    for row, b in enumerate(data["blocks"]):
        bw, bh, m = collage_lib.box_and_margin(b["bbox"])
        mask = block_mask(ids, b)
        n = len(b["images"])
        cuts = [{"file": cut_file(row, k), "tilt": im["tilt"], "src": im["image"], "rect": list(im["crop"]),
                 "shift": _delta(im["shift"])} for k, im in enumerate(b["images"])]
        more = []
        for j, im in enumerate(b["images"]):
            if j == b["accent"]:
                more.append([])
                continue
            name = collage_lib.ref_name(im["image"])
            rgb = pics.get(collage_lib.ref_path(name, root))
            if name not in frames:
                frames[name] = picture_box(rgb)
            e = conf["images"].get(name, {"avoid": [], "within": None, "keep_out": []})
            same = [k for k, other in enumerate(b["images"]) if collage_lib.ref_name(other["image"]) == name]
            taken = [c["rect"] for k in same if k < j for c in more[k]]
            more.append(collage_lib.other_cuts(
                rgb, im["crop"][2:], [b["images"][k]["crop"] for k in same], taken, CUTS_MAX - n,
                avoid=e["avoid"], within=_meet(e["within"], frames[name]), avoid_max=conf["avoid_max"],
                keep_out=e["keep_out"], keep_out_max=conf["keep_out_max"], shift=im["shift"], mask=mask,
                seed=SEED + 100 * b["no"] + j))
        r = 0
        while len(cuts) < CUTS_MAX and any(len(c) > r for c in more):
            for j, c in enumerate(more):
                if len(c) > r and len(cuts) < CUTS_MAX:
                    cuts.append({"file": cut_file(row, len(cuts)), "tilt": c[r]["tilt"], "src": cuts[j]["src"],
                                 "rect": c[r]["rect"], "shift": cuts[j]["shift"]})
            r += 1
        out.append({"name": b["name"], "leaves": list(b["leaves"]), "bbox": list(b["bbox"]), "box": [bw, bh],
                    "margin": m, "n": n, "accent": b["accent"], "cuts": cuts})
        log.append("%2d %-18s n %2d  other %2d  cuts %2d  per image %s" % (
            b["no"], b["name"], n, len(cuts) - n, len(cuts),
            " ".join(str(len(c)) if j != b["accent"] else "A" for j, c in enumerate(more))))
    letterbox = ["%s: picture %s" % (name, [round(v, 4) for v in box]) for name, box in sorted(frames.items())
                 if box != [0.0, 0.0, 1.0, 1.0]]
    manifest = {"regions": regions["fingerprint"], "scale": round(collage_lib.SCALE, 6), "look": data["look"],
                "blocks": out}
    # every cut's bake key (not one of its own inputs): the page refuses a baked file whose key in
    # baked.json is not this one (a file left from other picks under the same name)
    for row, b in enumerate(out):
        for k, c in enumerate(b["cuts"]):
            c["key"] = bake_key(manifest, row, k)
    return manifest, log + ["letterbox bands left out:"] + ["  " + s for s in letterbox]


def _one(v):
    return json.dumps(v, ensure_ascii=False)


def dumps(manifest):
    """The manifest as text: one cut per line."""
    m = manifest
    lines = ["{", ' "regions": %s,' % _one(m["regions"]), ' "scale": %s,' % _one(m["scale"]),
             ' "look": %s,' % _one(m["look"]), ' "blocks": [']
    for i, b in enumerate(m["blocks"]):
        head = _one({k: b[k] for k in ("name", "leaves", "bbox", "box", "margin", "n", "accent")})
        lines.append("  %s, \"cuts\": [" % head[:-1])
        lines += ["   %s%s" % (_one(c), "," if k < len(b["cuts"]) - 1 else "") for k, c in enumerate(b["cuts"])]
        lines.append("  ]}%s" % ("," if i < len(m["blocks"]) - 1 else ""))
    lines += [" ]", "}"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- baking

def used_cuts(manifest, score, everything=False):
    """-> sorted (row, k) of the cuts to bake: every cut (everything), the cuts of score.collage.changes
    (every strength: start and events[].to), or the picked cuts while the score has no collage."""
    blocks = manifest["blocks"]
    if everything:
        return [(r, k) for r, b in enumerate(blocks) for k in range(len(b["cuts"]))]
    changes = (score or {}).get("collage", {}).get("changes")
    if not changes:
        return [(r, k) for r, b in enumerate(blocks) for k in range(b["n"])]
    used = set()
    for ch in changes.values():
        used.update((r, k) for r, k in enumerate(ch["start"]))
        used.update((e["block"], e["to"]) for e in ch["events"])
    bad = sorted((r, k) for r, k in used if not (0 <= r < len(blocks) and 0 <= k < len(blocks[r]["cuts"])))
    if bad:
        raise SystemExit("assets/score.json names cuts the list does not have (block row, cut): %s; "
                         "run tools/make_score.py" % bad)
    return sorted(used)


def bake_key(manifest, row, k):
    """What a baked file is made from, as a sha1: [src, rect, shift, box, margin, leaves, regions, BAKE_VERSION].
    The list carries it as each cut's "key"; a cut's own "key" is not part of it."""
    b = manifest["blocks"][row]
    c = b["cuts"][k]
    what = [c["src"], c["rect"], c["shift"], b["box"], b["margin"], b["leaves"], manifest["regions"], BAKE_VERSION]
    return hashlib.sha1(json.dumps(what, separators=(",", ":")).encode("utf-8")).hexdigest()


def _score(root):
    path = os.path.join(root, "assets", "score.json")
    return _load(root, "assets/score.json") if os.path.exists(path) else None


def _load_baked(root):
    path = os.path.join(root, BAKED)
    return _load(root, BAKED) if os.path.exists(path) else {}


def _save_baked(root, baked):
    _write(os.path.join(root, BAKED), json.dumps(dict(sorted(baked.items())), indent=1) + "\n")


def _file_size(path):
    with Image.open(path) as im:
        return im.size


def bake(manifest, root=ROOT, score=None, everything=False, factor=2):
    """Bake the cuts to use (used_cuts) into <root>/assets/collage/. -> {"baked", "kept", "removed",
    "seconds"}. Raises SystemExit after the rest is done when an original or an upscale is missing."""
    out_dir = os.path.join(root, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)
    baked = _load_baked(root)
    want = {}
    for row, k in used_cuts(manifest, score, everything):
        want[os.path.basename(manifest["blocks"][row]["cuts"][k]["file"])] = (row, k, bake_key(manifest, row, k))
    todo, kept = [], []
    for name, (row, k, key) in sorted(want.items()):
        path = os.path.join(out_dir, name)
        b = manifest["blocks"][row]
        size = (b["box"][0] + 2 * b["margin"], b["box"][1] + 2 * b["margin"])
        if baked.get(name) == key and os.path.exists(path) and _file_size(path) == size:
            kept.append(name)
            continue
        todo.append((collage_lib.ref_name(b["cuts"][k]["src"]), name, row, k, key))
        # a file made from something else goes now, so it is never taken for this cut if baking fails
        if os.path.exists(path):
            os.remove(path)
        baked.pop(name, None)
    _save_baked(root, baked)
    missing, done, seconds = [], [], 0.0
    ids, insides, ups = None, {}, _Pictures(root, keep=2)
    for src, name, row, k, key in sorted(todo):                  # by source: each upscale is read once
        b = manifest["blocks"][row]
        c = b["cuts"][k]
        try:
            orig = collage_lib.ref_path(src, root)
        except FileNotFoundError as e:
            missing.append("%s: original missing (%s)" % (src, e))
            continue
        up_rel = collage_lib.upscaled_path(src)
        if not os.path.exists(os.path.join(root, up_rel)):
            missing.append("%s: upscale missing, expected at %s" % (src, up_rel))
            continue
        t0 = time.time()
        up = ups.get(up_rel)
        ow, oh = _file_size(os.path.join(root, orig))
        if up.shape[:2] != (oh * factor, ow * factor):
            missing.append("%s: %s is %dx%d, not %dx%d (%d x the original)" % (
                src, up_rel, up.shape[1], up.shape[0], ow * factor, oh * factor, factor))
            continue
        if row not in insides:
            if ids is None:
                ids = _ids(root)
            insides[row] = collage_lib.baked_inside(ids, b["leaves"], b["bbox"], b["box"], b["margin"])
        px = collage_lib.bake_cut(up, c["rect"], b["bbox"], b["box"], b["margin"], c["shift"], insides[row], factor)
        path = os.path.join(out_dir, name)
        Image.fromarray(px).save(path + ".tmp", format="WEBP", lossless=True, quality=100, method=6)
        os.replace(path + ".tmp", path)
        baked[name] = key
        _save_baked(root, baked)
        seconds += time.time() - t0
        done.append(name)
    removed = []
    for name in sorted(os.listdir(out_dir)):
        if name != os.path.basename(BAKED) and name not in want:
            os.remove(os.path.join(out_dir, name))
            removed.append(name)
    for name in [n for n in baked if n not in want]:
        del baked[name]
    _save_baked(root, baked)
    if missing:
        lines = sorted(set(missing))
        raise SystemExit("baked %d (%.1f s each), kept %d, removed %d; %d cuts could not be baked, their sources are "
                         "missing (%d):\n%s" % (len(done), seconds / max(len(done), 1), len(kept), len(removed),
                                               len(missing), len(lines), "\n".join(lines)))
    return {"baked": done, "kept": kept, "removed": removed, "seconds": seconds}


def check(manifest, root=ROOT, score=None):
    """-> problems: a cut to use (used_cuts) without its file, with a file of the wrong size, or with a
    file made from something else (its key in baked.json is not the cut's)."""
    baked = _load_baked(root)
    problems = []
    for row, k in used_cuts(manifest, score):
        b = manifest["blocks"][row]
        name = os.path.basename(b["cuts"][k]["file"])
        path = os.path.join(root, OUT_DIR, name)
        size = (b["box"][0] + 2 * b["margin"], b["box"][1] + 2 * b["margin"])
        if not os.path.exists(path):
            problems.append("%s (%s cut %d): missing" % (name, b["name"], k))
        elif _file_size(path) != size:
            problems.append("%s (%s cut %d): %dx%d, not %dx%d" % ((name, b["name"], k) + _file_size(path) + size))
        elif baked.get(name) != bake_key(manifest, row, k):
            problems.append("%s (%s cut %d): made from another cut (stale)" % (name, b["name"], k))
    return problems


# ---------------------------------------------------------------- cut sheets (to look at)

CELL = 300


def _font(size):
    return ImageFont.load_default(size=size)


def render_cut(rgb, rect, tilt, shift, tw, th):
    """A cut as the page shows it (before the print look), from the original at thumbnail size: turned
    by tilt about its centre (OpenCV sense, as the sheet), colour-shifted, at tw x th."""
    x, y, w, h = rect
    hh, ww = rgb.shape[:2]
    ex, ey = collage_lib.rotated_half(w, h, tilt)
    cx, cy = x + w / 2, y + h / 2
    X0, Y0 = max(int(math.floor(cx - ex - 2)), 0), max(int(math.floor(cy - ey - 2)), 0)
    X1, Y1 = min(int(math.ceil(cx + ex + 2)), ww), min(int(math.ceil(cy + ey + 2)), hh)
    z = tw / w
    small = cv2.resize(rgb[Y0:Y1, X0:X1], (max(1, round((X1 - X0) * z)), max(1, round((Y1 - Y0) * z))),
                       interpolation=cv2.INTER_AREA)
    zx, zy = small.shape[1] / (X1 - X0), small.shape[0] / (Y1 - Y0)
    scx, scy = (cx - X0) * zx, (cy - Y0) * zy
    mat = cv2.getRotationMatrix2D((scx, scy), tilt, 1.0)
    mat[0, 2] += tw / 2 - scx
    mat[1, 2] += th / 2 - scy
    f = cv2.warpAffine(small, mat, (tw, th), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
    return collage_lib.apply_shift(f, shift)


def _corners(rect, tilt):
    """The source area a cut shows: its rectangle turned by -tilt about the centre (image px)."""
    x, y, w, h = rect
    cx, cy = x + w / 2, y + h / 2
    t = math.radians(tilt)
    c, s = math.cos(t), math.sin(t)
    # getRotationMatrix2D maps a source offset d to (c dx + s dy, -s dx + c dy); a window corner maps back
    return [(cx + c * dx - s * dy, cy + s * dx + c * dy)
            for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]


def cut_sheet(manifest, row, pics, ids, conf, root):
    block = manifest["blocks"][row]
    x0, y0, x1, y1 = block["bbox"]
    aspect = (y1 - y0) * collage_lib.PICTURE_H / ((x1 - x0) * collage_lib.PICTURE_W)
    tw, th = (CELL, max(1, round(CELL * aspect))) if aspect <= 1 else (max(1, round(CELL / aspect)), CELL)
    h_ids, w_ids = ids.shape
    sub = ids[int(y0 * h_ids):math.ceil(y1 * h_ids), int(x0 * w_ids):math.ceil(x1 * w_ids)]
    alpha = cv2.resize(np.isin(sub, block["leaves"]).astype(np.float32), (tw, th), interpolation=cv2.INTER_AREA)[..., None]
    n, accent = block["n"], block["accent"]
    font = _font(15)
    cols, lab_h = 8, 20
    cw, ch = CELL + 10, CELL + lab_h + 10
    rows = math.ceil(len(block["cuts"]) / cols)
    order = {}
    cells = []
    for k, c in enumerate(block["cuts"]):
        name = collage_lib.ref_name(c["src"])
        rgb = pics.get(collage_lib.ref_path(name, root))
        f = render_cut(rgb, c["rect"], c["tilt"], c["shift"], tw, th).astype(np.float32)
        f = f * alpha + (0.4 * f + 0.6 * 255.0) * (1 - alpha)
        cell = Image.new("RGB", (cw, ch), (255, 255, 255))
        ox, oy = 5 + (CELL - tw) // 2, lab_h + 5 + (CELL - th) // 2
        cell.paste(Image.fromarray(np.clip(f, 0, 255).astype(np.uint8)), (ox, oy))
        d = ImageDraw.Draw(cell)
        if k < n:
            order[name] = (k, 0)
            tag, colour = ("%d picked%s" % (k, " ACCENT" if k == accent else "")), ((200, 0, 0) if k != accent else (230, 120, 0))
        else:
            order[name] = (order[name][0], order[name][1] + 1)
            tag, colour = "%d other r%d of %d" % (k, order[name][1], order[name][0]), (0, 90, 200)
        d.text((5, 2), "%s%s" % (tag, "  shift" if c["shift"] else ""), fill=colour, font=font)
        d.rectangle([ox - 1, oy - 1, ox + tw, oy + th], outline=colour, width=2 if k < n else 1)
        cells.append(cell)
    grid = Image.new("RGB", (cols * cw, rows * ch), (235, 235, 235))
    for k, cell in enumerate(cells):
        grid.paste(cell, ((k % cols) * cw, (k // cols) * ch))

    # where the cuts lie in each image: picked red (accent orange), others blue with their number
    wcols, ww = 4, cols * cw // 4
    where, wh = [], 0
    for j, pc in enumerate(block["cuts"][:n]):
        name = collage_lib.ref_name(pc["src"])
        rgb = pics.get(collage_lib.ref_path(name, root))
        sc = ww / rgb.shape[1]
        pic = Image.fromarray(cv2.resize(rgb, (ww, round(rgb.shape[0] * sc)), interpolation=cv2.INTER_AREA)).convert("RGBA")
        over = Image.new("RGBA", pic.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(over)
        e = conf.get(name)
        if e:
            for bx in e["avoid"]:
                od.rectangle([bx[0] * pic.width, bx[1] * pic.height, bx[2] * pic.width, bx[3] * pic.height],
                             fill=(0, 0, 0, 150), outline=(255, 60, 60, 255), width=1)
            for bx in e["keep_out"]:
                od.rectangle([bx[0] * pic.width, bx[1] * pic.height, bx[2] * pic.width, bx[3] * pic.height], fill=(255, 0, 255, 110))
            if e["within"]:
                bx = e["within"]
                od.rectangle([bx[0] * pic.width, bx[1] * pic.height, bx[2] * pic.width, bx[3] * pic.height], outline=(0, 200, 0, 255), width=3)
        pic = Image.alpha_composite(pic, over).convert("RGB")
        d = ImageDraw.Draw(pic)
        for k, c in enumerate(block["cuts"]):
            if collage_lib.ref_name(c["src"]) != name:
                continue
            pts = [(px * sc, py * sc) for px, py in _corners(c["rect"], c["tilt"])]
            if k < n:
                d.polygon(pts, outline=(230, 120, 0) if k == accent else (230, 0, 0), width=3)
            else:
                d.polygon(pts, outline=(0, 140, 255), width=1)
                d.text((pts[0][0] + 3, pts[0][1] + 1), str(k), fill=(0, 140, 255), font=_font(12))
        cell = Image.new("RGB", (ww, pic.height + lab_h), (255, 255, 255))
        cell.paste(pic, (0, lab_h))
        ImageDraw.Draw(cell).text((4, 2), "%d  %s" % (j, name[:70]), fill=(0, 0, 0), font=font)
        where.append(cell)
        wh = max(wh, cell.height)
    wrows = math.ceil(len(where) / wcols)
    sheet = Image.new("RGB", (grid.width, grid.height + 40 + wrows * wh), (235, 235, 235))
    sheet.paste(grid, (0, 40))
    ImageDraw.Draw(sheet).text((8, 8), "%d %s   n %d   cuts %d   box %dx%d   (outside the silhouette paled; red picked, orange accent, blue other)"
                               % (row + 1, block["name"], n, len(block["cuts"]), block["box"][0], block["box"][1]),
                               fill=(0, 0, 0), font=_font(22))
    for k, cell in enumerate(where):
        sheet.paste(cell, ((k % wcols) * ww, 40 + grid.height + (k // wcols) * wh))
    return sheet


def cut_sheets(manifest, root=ROOT, out_dir=WORK):
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        if name.startswith("cuts_") and name.endswith(".jpg"):
            os.remove(os.path.join(out_dir, name))
    ids, pics, conf = _ids(root), _Pictures(root), load_sources(root)["images"]
    for row, b in enumerate(manifest["blocks"]):
        cut_sheet(manifest, row, pics, ids, conf, root).save(
            os.path.join(out_dir, "cuts_%02d_%s.jpg" % (row + 1, b["name"])), quality=90)


# ---------------------------------------------------------------- main

def _committed(root):
    manifest = _load(root, MANIFEST)
    fp = _load(root, "assets/regions.json")["fingerprint"]
    if manifest["regions"] != fp:
        raise SystemExit("%s was made from another region map (regions %s, assets/regions.json has %s); "
                         "run tools/pick_collage.py, then tools/make_collage.py" % (MANIFEST, manifest["regions"], fp))
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bake", action="store_true", help="bake the cuts the score uses (or the picked cuts)")
    ap.add_argument("--all", action="store_true", help="with --bake: every cut of the list")
    ap.add_argument("--check", action="store_true", help="are the baked cuts the score uses there and current?")
    a = ap.parse_args(argv)
    if a.all and not a.bake:
        ap.error("--all goes with --bake (the plain run makes the list, --bake --all bakes every cut of it)")
    if a.bake and a.check:
        ap.error("--bake and --check are separate runs (--bake, then --check)")
    t0 = time.time()
    if a.check:
        manifest = _committed(ROOT)
        problems = check(manifest, ROOT, _score(ROOT))
        print("\n".join(problems) if problems else "PASS: %d cuts baked and current" % len(used_cuts(manifest, _score(ROOT))))
        sys.exit(1 if problems else 0)
    if a.bake:
        r = bake(_committed(ROOT), ROOT, _score(ROOT), everything=a.all)
        size = sum(os.path.getsize(os.path.join(ROOT, OUT_DIR, n)) for n in r["baked"] + r["kept"])
        print("baked %d (%.1f s each), kept %d, removed %d; %d files, %d bytes" % (
            len(r["baked"]), r["seconds"] / max(len(r["baked"]), 1), len(r["kept"]), len(r["removed"]),
            len(r["baked"]) + len(r["kept"]), size))
        return
    manifest, log = _build(ROOT)
    _write(os.path.join(ROOT, MANIFEST), dumps(manifest))
    cut_sheets(manifest, ROOT, WORK)
    cuts = [c for b in manifest["blocks"] for c in b["cuts"]]
    n = sum(b["n"] for b in manifest["blocks"])
    summary = ["cuts %d (picked %d, other %d), with a colour shift %d, from %d images" % (
        len(cuts), n, len(cuts) - n, sum(c["shift"] is not None for c in cuts),
        len({collage_lib.ref_name(c["src"]) for c in cuts}))]
    _write(os.path.join(WORK, "log.txt"), "\n".join(summary + log) + "\n")
    print("\n".join(summary + log))
    print("%.1f s" % (time.time() - t0))


if __name__ == "__main__":
    main()

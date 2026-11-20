"""Collage data: from the candidate sheet and the user's picks to data/collage.json; the other cuts
of the same images and the baked cuts (tools/make_collage.py); where the reference images live."""
import copy
import math
import os
import re
import warnings

import cv2
import numpy as np
from PIL import Image
from skimage.color import lab2rgb, rgb2lab

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PX4K = 2160 / 1648
PICTURE_W = 2944
PICTURE_H = 1648
SCALE = PX4K          # every cut is shown at the key image's scale: one source px is SCALE px at 4K
MIN_IMAGES = 8
TILT_LIMIT = 2.0      # degrees: the most a cut is turned (design 6.4); the baked margin allows for it

# Reference images. One is named <folder>/<file>; it lies under the first root that has it. Its 2x
# upscale (tools/upscale_refs.py) is <UPSCALED_ROOT>/<folder>/<file>. Paths are repository-relative.
REF_ROOTS = ("resources/midjourney_images", "local-only/resources/midjourney_images")
UPSCALED_ROOT = "local-only/assets/collage_src"

# Other cuts (starting values, design 12; see tools/make_collage.py for how they are used)
IOU_MAX = 0.35        # an other cut overlaps every cut of the same image in its block at most this much (IoU;
                      # the brief's 0.7 gave near copies, the picked view moved by a sixth of its width;
                      # at 0.35 two cuts of one size share at most about half of their area)
COLOUR_MAX = 12.0     # an other cut's mean colour is at most this far from the picked cut's (colour_distance;
                      # farther places of an image turn grey street, blue sky or black)
DETAIL_MIN = 0.4      # an other cut has at least this share of the picked cut's detail (Measure.detail):
                      # leaves out empty sky, blank paper and dark bands
TILT_MAX = 1.8        # degrees, the range the sheet's search drew its tilts from (within TILT_LIMIT)
AVOID_MAX = 0.12      # share of a cut that may lie in the avoid areas of its image
KEEP_OUT_MAX = 0.02   # share of a cut that may lie in the keep-out areas (the mixed-media eyes)
TRIES = 3000          # candidate rectangles drawn per call
MEASURE = 4           # colours are measured on the image reduced this many times (area average)
GRID = 16             # the block's silhouette as a GRID x GRID weight map for the mean colour


def ref_name(path):
    """'<root>/<folder>/<file>' (either root) or '<folder>/<file>' -> '<folder>/<file>'."""
    p = path.replace("\\", "/")
    for r in REF_ROOTS:
        if p.startswith(r + "/"):
            return p[len(r) + 1:]
    if p.count("/") != 1:
        raise ValueError("not a reference image name <folder>/<file> or a path under %s: %r" % (" or ".join(REF_ROOTS), path))
    return p


def ref_path(rel, root=ROOT):
    """The repository-relative path of a reference image (a name or a path under either root), from the
    first root that has it. FileNotFoundError naming both places when neither has it."""
    name = ref_name(rel)
    tried = [r + "/" + name for r in REF_ROOTS]
    for p in tried:
        if os.path.exists(os.path.join(root, p)):
            return p
    raise FileNotFoundError("reference image %s is in neither %s" % (name, " nor ".join(tried)))


def upscaled_path(rel):
    """The repository-relative path of the 2x upscale of a reference image (a name or a path)."""
    return UPSCALED_ROOT + "/" + ref_name(rel)


def box_and_margin(bbox):
    """A block's box at 4K (px, rounded up) and the margin around it for tilt and offset:
    -> (bw, bh, m), m = ceil(0.5 * hypot(bw, bh) * sin(TILT_LIMIT)) + 8. The products are rounded to
    1e-6 before ceil so float noise (1257.0000000001) does not add a pixel."""
    bw = math.ceil(round((bbox[2] - bbox[0]) * PICTURE_W * PX4K, 6))
    bh = math.ceil(round((bbox[3] - bbox[1]) * PICTURE_H * PX4K, 6))
    m = math.ceil(round(0.5 * math.hypot(bw, bh) * math.sin(math.radians(TILT_LIMIT)), 6)) + 8
    return bw, bh, m


class PickError(ValueError):
    pass


def scale_at_4k(bbox, crop):
    """Source pixels shown per 4K pixel: bbox width in 4K px over the crop width."""
    return (bbox[2] - bbox[0]) * PICTURE_W * PX4K / crop[2]


def sheet_images(block):
    """One sheet block -> its candidates as image dicts, in sheet order.
    This is the only place that knows the sheet's shape."""
    return [{
        "letter": c["letter"],
        "image": c["image"],
        "crop": list(c["crop"]),
        "tilt": c["rotation_deg"],
        "shift": c.get("colour_shift"),
        "accent": bool(c.get("accent")),
        "shows": c.get("shows", ""),
    } for c in block["candidates"]]


# data/collage_picks.json: the sheet it picks from, the table its images' old names are read through
# (names, optional), the fingerprint of the region map that sheet was made for (its blocks' leaves, bbox and
# crops belong to that map), a note, the picks per block
PICKS_KEYS = {"sheet", "names", "regions", "message", "blocks"}
SPEC_KEYS = {"block", "drop", "order", "only"}


def _picks_object(picks):
    if not isinstance(picks, dict):
        raise PickError("the picks file (data/collage_picks.json) must be an object {\"sheet\", \"regions\", "
                        "\"blocks\": [...]}, not %s" % type(picks).__name__)
    extra = sorted(set(picks) - PICKS_KEYS)
    if extra:
        raise PickError("unknown key in the picks file: %s (allowed: %s)"
                        % (", ".join(extra), ", ".join(sorted(PICKS_KEYS))))
    if not isinstance(picks.get("blocks", []), list):
        raise PickError("the picks file's \"blocks\" must be a list of picks, not %r" % (picks["blocks"],))


def picks_sheet(picks):
    """The candidate sheet a picks file names (repository-relative). PickError when the file is not an
    object of the known keys or names no sheet."""
    _picks_object(picks)
    sheet = picks.get("sheet")
    if not isinstance(sheet, str) or not sheet:
        raise PickError("the picks file (data/collage_picks.json) names no candidate sheet (\"sheet\": %r)" % (sheet,))
    return sheet


# The reference images got plain names on 2026-11-20 (a one-off tool of the private repository renamed them);
# a sheet made before names them by their old names. The table of the two (docs/2026-11-20-reference-image-names.md,
# private like the sheets) has a row per image: "| `<folder>/<new>` | `<folder>/<old>` | ...".
_NAME_ROW = re.compile(r"^\| `([^`]+)` \| `([^`]+)` \|")


def picks_names(picks):
    """The name table a picks file names ("names", repository-relative), or None when it names none.
    PickError when it is there but not a path."""
    _picks_object(picks)
    if "names" not in picks:
        return None
    names = picks["names"]
    if not isinstance(names, str) or not names:
        raise PickError("the picks file's \"names\" must be the path of the name table, not %r" % (names,))
    return names


def read_name_table(text):
    """The name table's text -> {<folder>/<old>: <folder>/<new>}. PickError when it has no row, or an old or a
    new name twice."""
    table, seen = {}, set()
    for line in text.splitlines():
        m = _NAME_ROW.match(line)
        if not m:
            continue
        new, old = m.groups()
        if old in table or new in seen:
            raise PickError("the name table has %s twice" % (old if old in table else new))
        table[old] = new
        seen.add(new)
    if not table:
        raise PickError("the name table has no row \"| `<folder>/<new>` | `<folder>/<old>` | ...\"")
    return table


def renamed_sheet(sheet, table, where):
    """A copy of the candidate sheet with each candidate's image under its new name (table: read_name_table,
    from the file `where`); the root before the name stays. PickError naming an image the table has not."""
    out = copy.deepcopy(sheet)
    for b in out["blocks"]:
        for c in b["candidates"]:
            name = ref_name(c["image"])
            if name not in table:
                raise PickError("candidate %s %s: %s is not in the name table %s" % (b["name"], c.get("letter"), name, where))
            c["image"] = c["image"][:len(c["image"]) - len(name)] + table[name]
    return out


def check_sheet_map(sheet, picks, regions):
    """Does the candidate sheet belong to this region map (assets/regions.json)? The picks file names the
    map the sheet was made for (its "regions", a fingerprint): it must be regions.json's, every leaf of a
    block must be on the map, and every block's bbox must be the box of its leaves on it (the crops are
    sized to that box). PickError naming what differs: a sheet made for another map gives fragments in
    stale boxes, and the map's ids alone cannot tell, so a new sheet is needed, not a new run."""
    fp = regions["fingerprint"]
    have = picks.get("regions")
    if not isinstance(have, str):
        raise PickError("the picks file (data/collage_picks.json) has no \"regions\": the fingerprint of the region "
                        "map its sheet %s was made for (assets/regions.json has %s)" % (picks.get("sheet"), fp))
    if have != fp:
        raise PickError("the candidate sheet %s was made for region map %s (\"regions\" in "
                        "data/collage_picks.json); assets/regions.json has %s. Make a new sheet for this map "
                        "and set \"regions\" to its fingerprint" % (picks.get("sheet"), have, fp))
    boxes = {l["id"]: l["bbox"] for l in regions["leaves"]}
    for b in sheet["blocks"]:
        gone = [i for i in b["leaves"] if i not in boxes]
        if gone:
            raise PickError("sheet block %s names leaves %s, which assets/regions.json (map %s) does not have; "
                            "make a new sheet for this map" % (b["name"], gone, fp))
        bb = [boxes[i] for i in b["leaves"]]
        union = [min(x[0] for x in bb), min(x[1] for x in bb), max(x[2] for x in bb), max(x[3] for x in bb)]
        if list(b["bbox"]) != union:
            raise PickError("sheet block %s has bbox %s, but its leaves span %s on assets/regions.json (map %s); "
                            "make a new sheet for this map" % (b["name"], list(b["bbox"]), union, fp))


def _find_block(sheet, key):
    if isinstance(key, bool) or not isinstance(key, (int, str)):
        raise PickError("block must be a number or a name, not %r" % (key,))
    for b in sheet["blocks"]:
        if b["no"] == key or b["name"] == key:
            return b
    raise PickError("no such block in the sheet: %r" % (key,))


def _letters(name, field, value, have):
    if not isinstance(value, list):
        raise PickError("%s: %s must be a list of letters" % (name, field))
    seen = set()
    for ch in value:
        if not isinstance(ch, str):
            raise PickError("%s: %s must hold letters, got %r" % (name, field, ch))
        if ch not in have:
            raise PickError("%s: %s names a letter the block does not have: %r" % (name, field, ch))
        if ch in seen:
            raise PickError("%s: %s lists %r twice" % (name, field, ch))
        seen.add(ch)
    return value


def _choose(name, images, spec):
    by = {im["letter"]: im for im in images}
    drop = _letters(name, "drop", spec.get("drop", []), by)
    order = _letters(name, "order", spec.get("order", []), by)
    if "only" in spec:
        if "drop" in spec or "order" in spec:
            raise PickError("%s: only cannot be combined with drop or order" % name)
        only = _letters(name, "only", spec["only"], by)
        return [by[c] for c in only]
    both = [c for c in order if c in drop]
    if both:
        raise PickError("%s: letter in both drop and order: %r" % (name, both[0]))
    rest = [im for im in images if im["letter"] not in drop and im["letter"] not in order]
    return [by[c] for c in order] + rest


def apply_picks(sheet, picks):
    """-> (blocks, notes). Blocks follow the sheet's order; a block's number
    for later tasks is its line here."""
    _picks_object(picks)
    specs = {}
    for spec in picks.get("blocks", []):
        if not isinstance(spec, dict) or "block" not in spec:
            raise PickError("a pick has no \"block\" key: %r" % (spec,))
        b = _find_block(sheet, spec["block"])
        extra = sorted(set(spec) - SPEC_KEYS)
        if extra:
            raise PickError("%s: unknown key %s (allowed: %s)"
                            % (b["name"], ", ".join(extra), ", ".join(sorted(SPEC_KEYS))))
        if b["no"] in specs:
            raise PickError("block %s is named twice" % b["name"])
        specs[b["no"]] = spec
    blocks, notes = [], []
    for b in sheet["blocks"]:
        name = b["name"]
        images = sheet_images(b)
        chosen = _choose(name, images, specs.get(b["no"], {}))
        if not chosen:
            raise PickError("%s: no images left" % name)
        accent = next((i for i, im in enumerate(chosen) if im["accent"]), -1)
        if b.get("accent") and accent < 0:
            notes.append("%s: 강조 이미지가 빠졌다 (accent image is out)" % name)
        if len(chosen) < MIN_IMAGES:
            notes.append("%s: %d images (fewer than %d)" % (name, len(chosen), MIN_IMAGES))
        blocks.append({
            "no": b["no"], "name": name, "place": b["place"],
            "leaves": list(b["leaves"]), "bbox": list(b["bbox"]),
            "accent": accent,
            "images": [{k: im[k] for k in ("letter", "image", "crop", "tilt", "shift", "shows")}
                       for im in chosen],
        })
    return blocks, notes


# ---------------------------------------------------------------- colour shift

def shift_delta(shift):
    """The CIELAB offset of a colour shift: None, the sheet's dict ({"op": "lab_offset",
    "delta_lab": [dL, da, db], ...}) or a bare [dL, da, db] -> None or a float array of three."""
    if shift is None:
        return None
    if isinstance(shift, dict):
        if shift.get("op") != "lab_offset":
            raise ValueError("colour shift: op %r is not supported (only lab_offset)" % (shift.get("op"),))
        shift = shift.get("delta_lab")
    d = np.asarray(shift, np.float64)
    if d.shape != (3,) or not np.all(np.isfinite(d)):
        raise ValueError("colour shift: expected three finite numbers [dL, da, db], got %r" % (shift,))
    return d


def shift_float(rgb, delta):
    """float sRGB 0..1 (..., 3) -> float sRGB 0..1: CIELAB (skimage, D65) moved by delta, L* kept in
    0..100, back to sRGB and clipped. The sheet's v2_lib.apply_shift for lab_offset."""
    lab = rgb2lab(np.clip(rgb, 0.0, 1.0))
    lab = lab + delta
    lab[..., 0] = np.clip(lab[..., 0], 0.0, 100.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")   # lab2rgb warns when it clips negative Z (out of gamut)
        out = lab2rgb(lab)
    return np.clip(out, 0.0, 1.0)


def apply_shift(rgb, shift):
    """uint8 sRGB (..., 3) -> uint8: the colour shift of a cut (see shift_delta), rounded to the
    nearest value. None returns the input unchanged (a copy)."""
    delta = shift_delta(shift)
    if delta is None:
        return np.array(rgb, np.uint8, copy=True)
    out = shift_float(np.asarray(rgb, np.float64) / 255.0, delta)
    return np.clip(np.rint(out * 255.0), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- other cuts of the same image

def _rects(a):
    return np.asarray(a, np.float64).reshape(-1, 4)


def iou_many(rects, others):
    """(N, 4) x (M, 4) rectangles [x, y, w, h] -> (N, M) intersection over union."""
    a, b = _rects(rects)[:, None, :], _rects(others)[None, :, :]
    iw = np.clip(np.minimum(a[..., 0] + a[..., 2], b[..., 0] + b[..., 2]) - np.maximum(a[..., 0], b[..., 0]), 0, None)
    ih = np.clip(np.minimum(a[..., 1] + a[..., 3], b[..., 1] + b[..., 3]) - np.maximum(a[..., 1], b[..., 1]), 0, None)
    inter = iw * ih
    return inter / (a[..., 2] * a[..., 3] + b[..., 2] * b[..., 3] - inter)


def box_share(rects, boxes, w, h):
    """Share of each rectangle (px) that lies in the boxes ((x0, y0, x1, y1) in 0..1 of a w x h
    image), summed over the boxes as the sheet did -> (N,)."""
    r = _rects(rects)
    tot = np.zeros(len(r))
    for x0, y0, x1, y1 in boxes:
        iw = np.clip(np.minimum(r[:, 0] + r[:, 2], x1 * w) - np.maximum(r[:, 0], x0 * w), 0, None)
        ih = np.clip(np.minimum(r[:, 1] + r[:, 3], y1 * h) - np.maximum(r[:, 1], y0 * h), 0, None)
        tot += iw * ih
    return tot / (r[:, 2] * r[:, 3])


def rotated_half(w, h, tilt):
    """Half width and half height of the bounding box of a w x h rectangle turned by tilt degrees."""
    t = np.radians(tilt)
    c, s = np.abs(np.cos(t)), np.abs(np.sin(t))
    return (w * c + h * s) / 2, (w * s + h * c) / 2


class Measure:
    """Mean colour (CIELAB) and detail of rectangles of one picture, weighted by a block's silhouette.
    Colour: the picture reduced MEASURE times (area average), then colour-shifted. Detail: the mean
    absolute Laplacian of the grey picture at full size (the sheet's sharpness), reduced the same way;
    low on blur, out-of-focus areas, sky and flat walls."""

    def __init__(self, image, shift=None, mask=None):
        h, w = image.shape[:2]
        self.f = MEASURE
        size = (max(1, round(w / self.f)), max(1, round(h / self.f)))
        small = cv2.resize(image, size, interpolation=cv2.INTER_AREA).astype(np.float64) / 255.0
        self.fx, self.fy = w / small.shape[1], h / small.shape[0]
        delta = shift_delta(shift)
        if delta is not None:
            small = shift_float(small, delta)
        grey = cv2.cvtColor(np.ascontiguousarray(image), cv2.COLOR_RGB2GRAY).astype(np.float32)
        detail = cv2.resize(np.abs(cv2.Laplacian(grey, cv2.CV_32F, ksize=3)), size, interpolation=cv2.INTER_AREA)
        chans = np.concatenate([rgb2lab(small), detail[..., None].astype(np.float64)], axis=2)
        ii = np.zeros((chans.shape[0] + 1, chans.shape[1] + 1, chans.shape[2]))
        ii[1:, 1:] = chans.cumsum(0).cumsum(1)
        self.ii = ii
        self.weights = np.ones((1, 1)) if mask is None else np.asarray(mask, np.float64)

    def stats(self, rects):
        """(N, 4) rectangles in picture px -> (N, 4): weighted mean L*, a*, b* and detail (the mean
        absolute Laplacian, 0..255 grey levels)."""
        r = _rects(rects)
        gy, gx = self.weights.shape
        sh, sw = self.ii.shape[0] - 1, self.ii.shape[1] - 1
        xs = (r[:, 0:1] + r[:, 2:3] * (np.arange(gx + 1) / gx)) / self.fx
        ys = (r[:, 1:2] + r[:, 3:4] * (np.arange(gy + 1) / gy)) / self.fy
        xi = np.clip(np.rint(xs).astype(np.int64), 0, sw)
        yi = np.clip(np.rint(ys).astype(np.int64), 0, sh)
        s = self.ii[yi[:, :, None], xi[:, None, :]]                      # (N, gy+1, gx+1, 4)
        cell = s[:, 1:, 1:] - s[:, :-1, 1:] - s[:, 1:, :-1] + s[:, :-1, :-1]
        cnt = np.diff(yi, axis=1)[:, :, None] * np.diff(xi, axis=1)[:, None, :]
        mean = cell / np.maximum(cnt, 1)[..., None]
        wt = self.weights[None] * (cnt > 0)
        return (mean * wt[..., None]).sum((1, 2)) / np.maximum(wt.sum((1, 2)), 1e-12)[:, None]


def colour_distance(lab, target):
    """The sheet's colour cost: CIELAB distance with the lightness difference counted half."""
    d = np.asarray(lab) - np.asarray(target)
    return np.sqrt(0.5 * d[..., 0] ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)


def other_cuts(image, size, picked, taken, count, *, avoid=(), within=None, avoid_max=AVOID_MAX, seed,
               keep_out=(), keep_out_max=KEEP_OUT_MAX, shift=None, mask=None, iou_max=IOU_MAX,
               colour_max=COLOUR_MAX, detail_min=DETAIL_MIN, tilt_max=TILT_MAX, tries=TRIES):
    """Up to `count` cuts of `image` (uint8 H x W x 3) at places other than the picked cuts.

    size: (w, h) of every cut in image px (the block's box at the key image's scale). picked: the
    block's picked cuts of this image, [x, y, w, h] in image px; their mean colour and detail are the
    reference. taken: other cuts of this image the block already has (kept apart, not a reference).
    avoid, keep_out, within: boxes (x0, y0, x1, y1) in 0..1 of the image; a cut covers at most
    avoid_max of its area with `avoid` and keep_out_max with `keep_out`, and lies inside `within`
    (when given) together with its tilt. shift: the cuts' colour shift (None, a dict or [dL, da, db]),
    applied before colours are compared. mask: the block's silhouette over its box (a small weight
    map) for the mean colour and detail.

    Candidates are drawn with numpy's generator from `seed` (place, tilt within +-tilt_max). Those
    within colour_max of the reference colour and with at least detail_min of its detail are taken
    nearest colour first while their IoU with every picked, taken and already chosen cut stays at most
    iou_max. Fewer than `count` (or none) when there is no more room; not an error.
    -> [{"rect": [x, y, w, h], "tilt": t}], the place rounded to 0.1 px, the tilt to 0.01 degree."""
    h_img, w_img = image.shape[:2]
    ax0, ay0, ax1, ay1 = 0.0, 0.0, float(w_img), float(h_img)
    if within is not None:
        ax0, ay0 = max(ax0, within[0] * w_img), max(ay0, within[1] * h_img)
        ax1, ay1 = min(ax1, within[2] * w_img), min(ay1, within[3] * h_img)
    aw, ah = ax1 - ax0, ay1 - ay0
    w, h = float(size[0]), float(size[1])
    if count <= 0 or w + 2.0 > aw or h + 2.0 > ah:
        return []

    rng = np.random.default_rng(seed)
    tilt = np.round(rng.uniform(-tilt_max, tilt_max, tries), 2)
    u, v = rng.uniform(0.0, 1.0, tries), rng.uniform(0.0, 1.0, tries)
    ex, ey = rotated_half(w, h, tilt)
    flat = (2 * ex + 2.0 > aw) | (2 * ey + 2.0 > ah)       # no room to turn it: lay it straight
    tilt = np.where(flat, 0.0, tilt)
    ex, ey = rotated_half(w, h, tilt)
    ex, ey = ex + 1.0, ey + 1.0
    cx = ax0 + ex + u * np.maximum(aw - 2 * ex, 0.0)
    cy = ay0 + ey + v * np.maximum(ah - 2 * ey, 0.0)
    x, y = np.round(cx - w / 2, 1), np.round(cy - h / 2, 1)
    rects = np.stack([x, y, np.full(tries, w), np.full(tries, h)], axis=1)
    cxr, cyr = x + w / 2, y + h / 2
    ok = ((cxr - ex + 1.0 >= ax0 - 1e-9) & (cxr + ex - 1.0 <= ax1 + 1e-9)
          & (cyr - ey + 1.0 >= ay0 - 1e-9) & (cyr + ey - 1.0 <= ay1 + 1e-9)
          & (x >= 0) & (y >= 0) & (x + w <= w_img) & (y + h <= h_img))
    if avoid:
        ok &= box_share(rects, avoid, w_img, h_img) <= avoid_max
    if keep_out:
        ok &= box_share(rects, keep_out, w_img, h_img) <= keep_out_max

    def apart(rs, others):
        return iou_many(rs, others) <= iou_max

    kept = list(picked) + list(taken)
    if kept:
        ok &= apart(rects, kept).all(axis=1)
    idx = np.flatnonzero(ok)
    if len(idx) and len(picked):
        m = Measure(image, shift, mask)
        ref = m.stats(picked).mean(axis=0)
        s = m.stats(rects[idx])
        dist = colour_distance(s[:, :3], ref[:3])
        good = (dist <= colour_max) & (s[:, 3] >= detail_min * ref[3])
        order = np.argsort(dist, kind="stable")
        idx = idx[order[good[order]]]
    if not len(idx):
        return []

    out = []
    alive = np.ones(len(idx), bool)
    for k in range(len(idx)):
        if not alive[k]:
            continue
        i = idx[k]
        out.append({"rect": [float(v) for v in rects[i]], "tilt": float(tilt[i]) + 0.0})
        if len(out) >= count:
            break
        alive &= apart(rects[idx], rects[i:i + 1])[:, 0]
    return out


# ---------------------------------------------------------------- a baked cut

BAKE_PAD = 8   # source px read beyond the region on each side (the reach of the resampling filter)


def bake_region(up, rect, bbox, box, margin, factor=2):
    """The pixels of a baked cut before its colour shift. `up` is the source enlarged `factor` times.
    The cut's rect lands on the block's box at the key image's scale (scale_at_4k(bbox, rect) 4K px per
    source px), the box's corner at (margin, margin); the margin shows the picture around the rect.
    Resampled with Lanczos (PIL, antialiased) from a float box; past the source's edge the picture is
    mirrored. -> uint8 (bh + 2m, bw + 2m, 3)."""
    bw, bh = box
    out_w, out_h = bw + 2 * margin, bh + 2 * margin
    s = scale_at_4k(bbox, rect) / factor              # 4K px per px of `up`
    x0, y0 = (rect[0] * factor) - margin / s, (rect[1] * factor) - margin / s
    x1, y1 = x0 + out_w / s, y0 + out_h / s
    ix0, iy0 = math.floor(x0) - BAKE_PAD, math.floor(y0) - BAKE_PAD
    ix1, iy1 = math.ceil(x1) + BAKE_PAD, math.ceil(y1) + BAKE_PAD
    hh, ww = up.shape[:2]
    sub = up[max(iy0, 0):min(iy1, hh), max(ix0, 0):min(ix1, ww)]
    pad = (max(0, -iy0), max(0, iy1 - hh), max(0, -ix0), max(0, ix1 - ww))
    if any(pad):
        sub = cv2.copyMakeBorder(sub, *pad, cv2.BORDER_REFLECT_101)
    pic = Image.fromarray(np.ascontiguousarray(sub))
    return np.asarray(pic.resize((out_w, out_h), Image.LANCZOS, box=(x0 - ix0, y0 - iy0, x1 - ix0, y1 - iy0)))


def baked_inside(ids, leaves, bbox, box, margin):
    """Which pixels of a baked cut lie on the block's leaves: the region map (picture px) taken to the
    baked file's grid (4K px, the box's corner at (margin, margin)) -> bool (bh + 2m, bw + 2m)."""
    bw, bh = box
    mask = np.isin(ids, leaves).astype(np.float32)
    px0, py0 = bbox[0] * PICTURE_W, bbox[1] * PICTURE_H
    # output pixel centre u + 0.5 is picture coordinate px0 + (u + 0.5 - m) / PX4K; pixel i's centre is i + 0.5
    inv = np.array([[1 / PX4K, 0.0, px0 + (0.5 - margin) / PX4K - 0.5],
                    [0.0, 1 / PX4K, py0 + (0.5 - margin) / PX4K - 0.5]])
    a = cv2.warpAffine(mask, inv, (bw + 2 * margin, bh + 2 * margin), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return a >= 0.5


def bake_cut(up, rect, bbox, box, margin, shift, inside, factor=2):
    """A baked cut: bake_region, the colour shift applied, and every pixel farther than `margin` from
    the block's leaves (`inside`, see baked_inside) set to the mean colour of the pixels on the leaves
    (the page never draws there; flat colour keeps the file small). -> uint8 (bh + 2m, bw + 2m, 3)."""
    px = apply_shift(bake_region(up, rect, bbox, box, margin, factor), shift)
    on = inside if inside.any() else np.ones(inside.shape, bool)
    mean = np.rint(px[on].mean(axis=0)).astype(np.uint8)
    far = cv2.distanceTransform((~inside).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) > margin
    px[far] = mean
    return px

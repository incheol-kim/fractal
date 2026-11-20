"""Wire mask and the wire-free plate.

    .venv\\Scripts\\python.exe tools\\make_plate.py

Finds the thin power lines of assets/key_hires.png (5888x3296) inside the zones listed under
"wires" in data/strokes_hand.json, and paints them out:

- Thin-line response (lines narrower than LINE_PX): black = black-hat of the luminance on
  pixels not much redder than around them (red top-hat below NOT_RED; a dark wire over the
  warm clouds is still black), red = top-hat of the redness R - (G + B) / 2 on pixels whose
  redness is above RED_MIN.
- Each zone is a set of leaves of assets/regions_id.png (by kind, name or group; all when
  none is given) inside an optional box, minus "not_groups" / "not_leaves" and the
  "exclude" boxes. Per zone and colour, the pixels above the zone's threshold are traced
  into polylines (strokes_lib.trace_wires), pieces in line are joined across small gaps
  (strokes_lib.join_pieces) and cut where they bend sharply, and a polyline counts as a wire
  if it is at least "min_len" hi-res pixels long, nearly straight, and its chord is within
  "max_angle" degrees of horizontal. Wires in line are then bridged across longer gaps.
- The wire mask is the pixels above LOW x the threshold within NEAR_PX of a wire polyline,
  widened by FRINGE_PX (the wire's soft edge and the upscaler's light fringe around it).
- The plate is key_hires.png with the mask, widened by GROW_PX, repainted from the pixels
  around it (fill_smooth); every pixel outside the widened mask is the original's, which is
  asserted.

Writes local-only/temp/wire_mask.png (8-bit, 255 = black wire, 128 = red wire, 0 elsewhere, at
hi-res; tools/make_strokes.py reads it), local-only/temp/wire_mask_preview.png (the mask drawn
over the reduced picture) and assets/key_plate.png.

Also writes assets/wire_mask.png for the renderer: every pixel the plate repainted (the mask
widened by GROW_PX), labelled with the colour of the nearest wire pixel, as RGB at hi-res (R 255:
a black wire's, G 255: a red wire's, 0 elsewhere). The black wires are drawn first (section C)
and reveal the key only on their own pixels, so they do not show the red wires that run beside
them before those are drawn (the coda).
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import strokes_lib  # noqa: E402

KEY = os.path.join(ROOT, "assets", "key_hires.png")
REGIONS = os.path.join(ROOT, "assets", "regions.json")
REGIONS_ID = os.path.join(ROOT, "assets", "regions_id.png")
HAND = os.path.join(ROOT, "data", "strokes_hand.json")
OUT_MASK = str(paths.TEMP / "wire_mask.png")
OUT_PREVIEW = str(paths.TEMP / "wire_mask_preview.png")
OUT_PLATE = os.path.join(ROOT, "assets", "key_plate.png")
OUT_WIRES = os.path.join(ROOT, "assets", "wire_mask.png")

LINE_PX = 19          # structuring element of the black-hat / top-hat (lines narrower than this)
# a wire is traced where its response is above MIN_RESPONSE (a zone may set "min_black" /
# "min_red"), and the mask takes its pixels down to LOW x that
MIN_RESPONSE = {"black": 22.0, "red": 35.0}
LOW = 0.35
RED_MIN = 25.0        # red wire pixels are red: redness R - (G + B) / 2 above this
NOT_RED = 40.0        # black wire pixels are not much redder than around them (red top-hat)
CROSS_TURN = 25.0     # through a crossing, a traced line goes on if it turns less than this
JOIN_GAP = 50         # pieces in line are joined across gaps up to this (px)
JOIN_TURN = 12.0
BEND_DEG = 15.0       # traced paths are cut where they bend more than this ...
BEND_TOL = 2.0        # ... after simplifying them by this much (px)
BRIDGE_GAP = 150      # wires in line are bridged across gaps up to this (px) ...
BRIDGE_TURN = 5.0     # ... when they point at each other within this
STRAIGHT = 0.9        # chord / length of a wire polyline at least this
NEAR_PX = 4           # mask = candidate pixels this close to a wire polyline ...
FRINGE_PX = 2         # ... widened by this (the wire's soft edge and light fringe)
GROW_PX = 2           # the plate repaints the mask widened by this
FILL_SIGMAS = (2, 4, 8, 16, 32)
MASK_VALUE = {"black": 255, "red": 128}
PREVIEW_SCALE = 3


def require(ok, msg):
    """A check that guards an output: raised explicitly, so that it holds under python -O."""
    if not ok:
        raise SystemExit(f"check failed: {msg}")


def responses(rgb):
    """Thin-line strength per colour (0 where the pixel has the wrong colour)."""
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    se = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (LINE_PX, LINE_PX))
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    redness = r - (g + b) / 2
    dark = cv2.morphologyEx(lum, cv2.MORPH_BLACKHAT, se)
    red = cv2.morphologyEx(redness, cv2.MORPH_TOPHAT, se)
    return {"black": np.where(red < NOT_RED, dark, 0),
            "red": np.where(redness > RED_MIN, red, 0)}


def zone_mask(zone, labels, leaves, excludes):
    h, w = labels.shape
    by_name = {lf["name"]: lf["id"] for lf in leaves}
    ids = [lf["id"] for lf in leaves if lf["kind"] in zone.get("kinds", [])]
    ids += [by_name[n] for n in zone.get("leaves", [])]
    ids += [lf["id"] for lf in leaves if lf["group"] in zone.get("groups", [])]
    m = np.isin(labels, ids) if ids else np.ones((h, w), bool)
    out = [by_name[n] for n in zone.get("not_leaves", [])]
    out += [lf["id"] for lf in leaves if lf["group"] in zone.get("not_groups", [])]
    if out:
        m &= ~np.isin(labels, out)
    if "box" in zone:
        x0, y0, x1, y1 = zone["box"]
        keep = np.zeros_like(m)
        keep[int(round(y0 * h)):int(round(y1 * h)), int(round(x0 * w)):int(round(x1 * w))] = True
        m &= keep
    for x0, y0, x1, y1 in excludes:
        m[int(round(y0 * h)):int(round(y1 * h)), int(round(x0 * w)):int(round(x1 * w))] = False
    return m


def is_wire(line, zone):
    p = np.asarray(line)
    length = strokes_lib.polyline_length(p)
    d = p[-1] - p[0]
    chord = float(np.hypot(*d))
    angle = np.degrees(np.arctan2(abs(d[1]), abs(d[0])))
    return length >= zone["min_len"] and chord >= STRAIGHT * length and angle <= zone["max_angle"]


def find_wires(rgb, labels, hand, leaves):
    """Returns {colour: bool mask} and {colour: [polylines]} (hi-res pixels)."""
    h, w = rgb.shape[:2]
    resp = responses(rgb)
    masks = {c: np.zeros((h, w), bool) for c in MASK_VALUE}
    lines = {c: [] for c in MASK_VALUE}
    for zone in hand["zones"]:
        zm = zone_mask(zone, labels, leaves, hand.get("exclude", []))
        for colour in zone["colors"]:
            thr = zone.get("min_" + colour, MIN_RESPONSE[colour])
            pieces = strokes_lib.trace_wires((resp[colour] > thr) & zm, spur=12, max_turn=CROSS_TURN)
            joined = strokes_lib.join_pieces(pieces, JOIN_GAP, JOIN_TURN)
            # a wire bends gently; a path that turns sharply went from one line to another
            parts = [q for ln in joined
                     for q in strokes_lib.split_at_corners(ln, BEND_DEG, tol=BEND_TOL)]
            wires = [ln for ln in parts if is_wire(ln, zone)]
            # wires broken where the response fades: look for them across the gap too
            wires = strokes_lib.join_pieces(wires, BRIDGE_GAP, BRIDGE_TURN)
            near = np.zeros((h, w), np.uint8)
            for ln in wires:
                # polyline points have pixel centres at +0.5, OpenCV draws them at +0
                cv2.polylines(near, [np.round(np.asarray(ln) - 0.5).astype(np.int32)], False, 1,
                              2 * NEAR_PX + 1)
            masks[colour] |= (resp[colour] > LOW * thr) & zm & (near > 0)
            lines[colour] += wires
            print(f"  {zone['name']:>12} {colour:>5}: {len(pieces)} pieces -> {len(wires)} wires")
    # a wire's footprint includes its soft edge and the upscaler's light fringe around it
    fringe = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * FRINGE_PX + 1, 2 * FRINGE_PX + 1))
    for colour in masks:
        masks[colour] = cv2.dilate(masks[colour].astype(np.uint8), fringe) > 0
    masks["black"] &= ~masks["red"]
    return masks, lines


def fill_smooth(rgb, paint):
    """Repaint the pixels where paint is set from the pixels around them: normalised Gaussian
    averages of the known pixels, with growing radius, each step filling what it reaches.
    (OpenCV's Telea and Navier-Stokes inpainting drag the wires' coloured fringes into the
    fill; this does not.)"""
    f = rgb.astype(np.float32)
    known = (paint == 0).astype(np.float32)
    todo = paint > 0
    for sigma in FILL_SIGMAS:
        num = cv2.GaussianBlur(f * known[..., None], (0, 0), sigma)
        den = cv2.GaussianBlur(known, (0, 0), sigma)
        reach = todo & (den > 0.02)
        f[reach] = num[reach] / den[reach][:, None]
        known[reach] = 1.0
        todo &= ~reach
    if todo.any():
        raise RuntimeError(f"{int(todo.sum())} masked pixels too far from any known pixel")
    return np.clip(np.round(f), 0, 255).astype(np.uint8)


def preview(rgb, masks):
    s = PREVIEW_SCALE
    small = cv2.resize(rgb, (rgb.shape[1] // s, rgb.shape[0] // s), interpolation=cv2.INTER_AREA)
    small = (small.astype(np.float32) * 0.55 + 90).astype(np.uint8)
    for colour, col in (("black", (0, 70, 255)), ("red", (255, 0, 200))):
        m = cv2.resize(masks[colour].astype(np.uint8), (small.shape[1], small.shape[0]),
                       interpolation=cv2.INTER_AREA) > 0
        small[m] = col
    return small


def main():
    Image.MAX_IMAGE_PIXELS = None
    rgb = np.asarray(Image.open(KEY).convert("RGB"))
    h, w = rgb.shape[:2]
    with open(REGIONS, encoding="utf-8") as f:
        leaves = json.load(f)["leaves"]
    with open(HAND, encoding="utf-8") as f:
        hand = json.load(f)["wires"]
    small = np.asarray(Image.open(REGIONS_ID)).astype(np.int32)
    labels = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)

    print("wires:")
    masks, lines = find_wires(rgb, labels, hand, leaves)
    out = np.zeros((h, w), np.uint8)
    for colour, v in MASK_VALUE.items():
        out[masks[colour]] = v
    os.makedirs(os.path.dirname(OUT_MASK), exist_ok=True)
    Image.fromarray(out).save(OUT_MASK)
    Image.fromarray(preview(rgb, masks)).save(OUT_PREVIEW)

    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * GROW_PX + 1, 2 * GROW_PX + 1))
    paint = cv2.dilate((out > 0).astype(np.uint8), grow)
    filled = fill_smooth(rgb, paint)
    plate = rgb.copy()
    plate[paint > 0] = filled[paint > 0]
    require(np.array_equal(plate[paint == 0], rgb[paint == 0]), "plate differs outside the mask")
    Image.fromarray(plate).save(OUT_PLATE)
    differ = int(np.any(plate != rgb, axis=2).sum())
    print(f"mask: black {int(masks['black'].sum())} px, red {int(masks['red'].sum())} px, "
          f"widened {int(paint.sum())} px; plate differs from the key in {differ} px")

    # the repainted pixels, each with the colour of the nearest wire pixel (for the renderer)
    _, (iy, ix) = ndimage.distance_transform_edt(out == 0, return_indices=True)
    nearest = out[iy, ix]
    del iy, ix
    wires = np.zeros((h, w, 3), np.uint8)
    for ch, colour in enumerate(("black", "red")):
        wires[..., ch] = np.where((paint > 0) & (nearest == MASK_VALUE[colour]), 255, 0)
    require(np.array_equal(wires[..., :2].max(axis=2) > 0, paint > 0), "every repainted pixel has one wire colour")
    require(not np.any((wires[..., 0] > 0) & (wires[..., 1] > 0)), "no pixel has both colours")
    Image.fromarray(wires).save(OUT_WIRES)
    print(f"wire pixels for the renderer: black {int((wires[..., 0] > 0).sum())}, "
          f"red {int((wires[..., 1] > 0).sum())}")
    print(f"-> {os.path.relpath(OUT_PLATE, ROOT)}, {os.path.relpath(OUT_WIRES, ROOT)}, "
          f"{os.path.relpath(OUT_MASK, ROOT)}, {os.path.relpath(OUT_PREVIEW, ROOT)}")


if __name__ == "__main__":
    main()

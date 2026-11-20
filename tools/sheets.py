"""Render the four look-test sheets (3840x2160) into a folder under docs/review/.

    python tools/sheets.py gate1-v2

lines.png, flat.png, lines_flat.png, pieces.png. Run after make_flat.py. A folder
that already holds sheets is refused, so a bundle that was shown stays as it was.
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import flat_lib  # noqa: E402

ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
OUT = None                           # set by main() from the command line
W, H = 3840, 2160
S = W / 2944.0                       # source pixel -> sheet pixel
OY = (H - 1648 * S) / 2.0            # vertical letterbox offset
SS = 2                               # line supersampling
PENCIL = {0: (52, 47, 42), 1: (98, 92, 84), 2: (146, 139, 128)}
WIRE_BLACK = (30, 28, 26)
WIRE_RED = (205, 62, 38)
WIRE_W = 1.8                         # drawn wire width at 2944 scale (stroke w is the photo band)
TONE_STEPS = 4
TONE_MAX = 0.75                      # lightest tint of an ink (1 would be bare paper)


def load():
    with open(os.path.join(ASSETS, "palette.json"), encoding="utf-8") as f:
        pal = json.load(f)
    with open(os.path.join(ASSETS, "regions.json"), encoding="utf-8") as f:
        reg = json.load(f)
    with open(os.path.join(ASSETS, "strokes.json"), encoding="utf-8") as f:
        strokes = json.load(f)["strokes"]
    ids = np.array(Image.open(os.path.join(ASSETS, "regions_id.png"))).astype(np.int64)
    return pal, reg, strokes, ids


def paper_canvas(pal, scale=1):
    p = flat_lib.hex_to_rgb(pal["paper"])
    return np.empty((H * scale, W * scale, 3), np.uint8) * 0 + np.array(p, np.uint8)


def flat_plane(pal, reg, ids):
    paper = np.array(flat_lib.hex_to_rgb(pal["paper"]), float)
    inks = [np.array(flat_lib.hex_to_rgb(i["hex"]), float) for i in pal["inks"]]
    n = max(l["id"] for l in reg["leaves"])
    lut = np.tile(paper, (n + 1, 1))
    for l in reg["leaves"]:
        if l["kind"] in ("mass", "part"):
            t = round(l["tone"] * TONE_MAX * TONE_STEPS) / TONE_STEPS
            lut[l["id"]] = inks[l["ink"]] * (1 - t) + paper * t
    small = lut[ids].astype(np.float32)
    big = np.tile(paper.astype(np.float32), (H, W, 1))
    h2 = int(round(1648 * S))
    y0 = int(round(OY))
    big[y0:y0 + h2] = cv2.resize(small, (W, h2), interpolation=cv2.INTER_CUBIC)
    return np.clip(big, 0, 255).astype(np.uint8)


def draw_strokes(base, strokes, kinds, width_gain=1.0):
    """Anti-aliased strokes over base (uint8 HxWx3); drawn lightest first."""
    big = cv2.resize(base, (W * SS, H * SS), interpolation=cv2.INTER_LINEAR)
    order = sorted((s for s in strokes if s["kind"] in kinds), key=lambda s: -s["gen"])
    for s in order:
        k = s["kind"]
        if k == "wire_black":
            col = WIRE_BLACK
        elif k == "wire_red":
            col = WIRE_RED
        else:
            col = PENCIL[s["gen"]]
        pts = np.array(s["pts"], float)
        px = pts[:, 0] * 2944 * S * SS
        py = (pts[:, 1] * 1648 * S + OY) * SS
        sh = 4
        poly = np.round(np.stack([px, py], 1) * (1 << sh)).astype(np.int32)
        w = WIRE_W if k in ("wire_black", "wire_red") else s["w"]
        th = max(1, int(round(w * S * SS * width_gain)))
        cv2.polylines(big, [poly.reshape(-1, 1, 2)], False, tuple(int(c) for c in col), th, cv2.LINE_AA, sh)
    return cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA)


def pieces_sheet(reg, ids, hires, margin=0.045, spread=0.22):
    """Exploded view: each leaf cut from the photo, white border, soft shadow."""
    ground = np.array([150, 152, 154], np.float32)
    cx, cy = 0.5, 0.5
    leaves = sorted(reg["leaves"], key=lambda l: -l["area"])
    # position each piece centre pushed away from the picture centre
    pos = {}
    for l in leaves:
        pos[l["id"]] = (cx + (l["c"][0] - cx) * (1 + spread), cy + (l["c"][1] - cy) * (1 + spread))
    # extents of the exploded layout, to fit inside the frame with a margin
    x0 = min(pos[l["id"]][0] - (l["c"][0] - l["bbox"][0]) for l in leaves)
    x1 = max(pos[l["id"]][0] + (l["bbox"][2] - l["c"][0]) for l in leaves)
    y0 = min(pos[l["id"]][1] - (l["c"][1] - l["bbox"][1]) for l in leaves)
    y1 = max(pos[l["id"]][1] + (l["bbox"][3] - l["c"][1]) for l in leaves)
    avail_w, avail_h = W * (1 - 2 * margin), H * (1 - 2 * margin)
    k = min(avail_w / ((x1 - x0) * 2944), avail_h / ((y1 - y0) * 1648))   # sheet px per source px
    ox = W / 2 - k * 2944 * (x0 + x1) / 2
    oy = H / 2 - k * 1648 * (y0 + y1) / 2
    canvas = np.tile(ground, (H, W, 1))
    hs = hires.shape[1] / 2944.0
    bw = 6                                       # white border, sheet px
    for l in leaves:
        bx0, by0, bx1, by1 = l["bbox"]
        sx0, sy0 = int(bx0 * 2944) - 1, int(by0 * 1648) - 1
        sx1, sy1 = int(np.ceil(bx1 * 2944)) + 1, int(np.ceil(by1 * 1648)) + 1
        sx0, sy0 = max(sx0, 0), max(sy0, 0)
        sx1, sy1 = min(sx1, 2944), min(sy1, 1648)
        m = (ids[sy0:sy1, sx0:sx1] == l["id"]).astype(np.float32)
        tw = max(int(round((sx1 - sx0) * k)), 1)
        th = max(int(round((sy1 - sy0) * k)), 1)
        pad = bw * 3
        mt = cv2.resize(cv2.GaussianBlur(m, (0, 0), 0.6), (tw, th), interpolation=cv2.INTER_LINEAR)
        mt = np.clip((mt - 0.5) * 3.0 + 0.5, 0, 1)
        photo = hires[int(sy0 * hs):int(sy1 * hs), int(sx0 * hs):int(sx1 * hs)]
        pt = cv2.resize(photo, (tw, th), interpolation=cv2.INTER_AREA).astype(np.float32)
        mt = np.pad(mt, pad)
        pt = np.pad(pt, ((pad, pad), (pad, pad), (0, 0)))
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * bw + 1, 2 * bw + 1))
        grown = cv2.GaussianBlur(cv2.dilate((mt > 0.5).astype(np.float32), ker), (0, 0), 0.8)
        grown = np.maximum(grown, mt)
        shadow = cv2.GaussianBlur(np.roll(grown, (7, 5), axis=(0, 1)), (0, 0), 6) * 0.45
        # canvas placement: sheet position of the source bbox corner, plus the explosion offset
        px, py = pos[l["id"]]
        dx = (px - l["c"][0]) * 2944 * k
        dy = (py - l["c"][1]) * 1648 * k
        X0 = int(round(ox + sx0 * k + dx)) - pad
        Y0 = int(round(oy + sy0 * k + dy)) - pad
        ph, pw = mt.shape
        cx0, cy0 = max(X0, 0), max(Y0, 0)
        cx1, cy1 = min(X0 + pw, W), min(Y0 + ph, H)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        sl = (slice(cy0 - Y0, cy1 - Y0), slice(cx0 - X0, cx1 - X0))
        reg_c = canvas[cy0:cy1, cx0:cx1]
        reg_c *= (1 - shadow[sl])[..., None]
        reg_c[:] = reg_c * (1 - grown[sl])[..., None] + 255.0 * grown[sl][..., None]
        reg_c[:] = reg_c * (1 - mt[sl])[..., None] + pt[sl] * mt[sl][..., None]
    return np.clip(canvas, 0, 255).astype(np.uint8)


def save(arr, name):
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(arr).save(os.path.join(OUT, name), optimize=True)


def main():
    global OUT
    if len(sys.argv) != 2:
        sys.exit("usage: python tools/sheets.py <folder under docs/review, e.g. gate1-v2>\n"
                 "A bundle that has been shown is not overwritten: give a new folder name.")
    OUT = os.path.join(ROOT, "docs", "review", sys.argv[1])
    if os.path.exists(os.path.join(OUT, "flat.png")):
        sys.exit(f"{OUT} already holds sheets; give a new folder name.")
    pal, reg, strokes, ids = load()
    pencil = ("edge", "detail", "mark", "wire_black", "wire_red")
    paper = paper_canvas(pal)
    flat = flat_plane(pal, reg, ids)
    save(draw_strokes(paper, strokes, pencil), "lines.png")
    save(flat, "flat.png")
    save(draw_strokes(flat, strokes, ("edge", "detail", "mark")), "lines_flat.png")
    hires = np.array(Image.open(os.path.join(ASSETS, "key_hires.png")).convert("RGB"))
    save(pieces_sheet(reg, ids, hires), "pieces.png")


if __name__ == "__main__":
    main()

"""Validate the region map and draw the overlay to look at.

    .venv\\Scripts\\python.exe tools\\check_regions.py

Asserts: the "fingerprint" of assets/regions.json is the one of assets/regions_id.png
(regions_lib.fingerprint); every pixel has a leaf and the ids in assets/regions_id.png are
exactly the leaves of assets/regions.json; 200-400 leaves; every required group exists; at
least 128 flat-able leaves (kind mass or part, size >= 1); at least 87 groups; each leaf's
polygon area is within 2% of its pixel area. Prints a summary, writes the full table to local-only/temp/regions_table.txt and
draws local-only/temp/regions_overlay.png (whole image at 1/2) and regions_overlay_<r><c>.png
(3x2 crops at 1:1): fills by kind (mass warm, part green/cyan, object magenta/violet,
back grey-blue, sky untinted), neighbours in different shades, white boundaries, ids on the
leaves and names on the larger ones.
"""
import colorsys
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import regions_lib  # noqa: E402
import segment  # noqa: E402

ID_PNG = os.path.join(ROOT, "assets", "regions_id.png")
JSON = os.path.join(ROOT, "assets", "regions.json")
WORK = str(paths.TEMP)

REQUIRED_GROUPS = [
    "sky", "cloud_main", "city_left", "city_right", "pole_left", "tank_big", "tank_mid", "tank_small",
    "wing_left", "red_block_left", "keys_strip_left", "blue_block", "blue_room", "keys_blue_wall",
    "red_block_top", "red_room", "white_square_a", "white_square_b", "yellow_block", "cello_right",
    "cello_mid", "base_houses",
    "white_box", "glass_room", "grand_piano", "room_plant", "room_figure",
    "coral_tree_1", "coral_tree_2", "coral_tree_3", "coral_tree_4", "coral_tree_5",
]
MIN_LEAVES, MAX_LEAVES = 200, 400
MIN_FLAT = 128
MIN_GROUPS = 87
AREA_TOL = 0.02

# (hue range, saturation, value) per kind; shades are spread over the hue range
KIND_STYLE = {
    "sky": None,
    "back": ((0.55, 0.65), 0.25, 0.75),
    "mass": ((0.0, 0.14), 0.85, 1.0),
    "part": ((0.25, 0.50), 0.80, 0.95),
    "object": ((0.75, 0.92), 0.90, 1.0),
}
SHADES = 6


def ring_area(ring, w, h):
    p = np.asarray(ring, float) * [w, h]
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def check(data, labels):
    """Run the assertions; returns the lines of the report (raises AssertionError on a failure)."""
    h, w = labels.shape
    leaves = data["leaves"]
    n = len(leaves)
    lines = []
    fp = regions_lib.fingerprint(labels)
    assert data.get("fingerprint") == fp, (
        f"regions.json has fingerprint {data.get('fingerprint')}, regions_id.png is {fp}: "
        "run tools/make_regions.py, then tools/make_flat.py")
    lines.append(f"fingerprint: {fp}, the same in regions.json and regions_id.png  ok")
    assert (w, h) == (data["w"], data["h"]) == (2944, 1648), f"size {w}x{h}"
    assert int((labels == 0).sum()) == 0, "unassigned pixels in regions_id.png"
    assert [lf["id"] for lf in leaves] == list(range(1, n + 1)), "leaf ids are not 1..N in order"
    assert int(labels.max()) == n, f"label map has ids up to {labels.max()}, json has {n} leaves"
    px = np.bincount(labels.ravel(), minlength=n + 1)
    assert all(px[1:] > 0), "a leaf of the json has no pixel"
    assert MIN_LEAVES <= n <= MAX_LEAVES, f"{n} leaves, want {MIN_LEAVES}-{MAX_LEAVES}"
    lines.append(f"leaves: {n} (want {MIN_LEAVES}-{MAX_LEAVES})  ok")

    missing = [g for g in REQUIRED_GROUPS if g not in data["groups"]]
    assert not missing, f"missing groups: {missing}"
    lines.append(f"required groups: all {len(REQUIRED_GROUPS)} present  ok")

    flat = [lf for lf in leaves if lf["kind"] in ("mass", "part") and lf["size"] >= 1]
    assert len(flat) >= MIN_FLAT, f"{len(flat)} flat-able leaves, want >= {MIN_FLAT}"
    lines.append(f"flat-able leaves (mass/part, size >= 1): {len(flat)} (want >= {MIN_FLAT})  ok")

    assert len(data["groups"]) >= MIN_GROUPS, f"{len(data['groups'])} groups, want >= {MIN_GROUPS}"
    lines.append(f"groups: {len(data['groups'])} (want >= {MIN_GROUPS})  ok")

    errs = []
    for lf in leaves:
        a = sum(ring_area(r, w, h) for r in lf["polys"])
        errs.append((abs(a - px[lf["id"]]) / px[lf["id"]], lf["id"], lf["name"], a, int(px[lf["id"]])))
    errs.sort(reverse=True)
    bad = [e for e in errs if e[0] > AREA_TOL]
    assert not bad, "polygon area off by more than 2%: " + ", ".join(
        f"{e[2]}({e[1]}) {e[3]:.0f} vs {e[4]} px" for e in bad[:10])
    lines.append(f"polygon area vs pixels: worst {errs[0][0] * 100:.3f}% ({errs[0][2]}), all within 2%  ok")
    total = sum(ring_area(r, w, h) for lf in leaves for r in lf["polys"])
    lines.append(f"sum of all polygon areas {total:.1f} px, image {w * h} px")
    return lines


def summary(data):
    leaves = data["leaves"]
    lines = ["", "kind     leaves  flat-able(size>=1)  area%"]
    for k in ("sky", "back", "mass", "part", "object"):
        ls = [lf for lf in leaves if lf["kind"] == k]
        fl = sum(1 for lf in ls if k in ("mass", "part") and lf["size"] >= 1)
        lines.append(f"{k:8s} {len(ls):6d}  {fl:18d}  {100 * sum(lf['area'] for lf in ls):6.2f}")
    sizes = np.bincount([lf["size"] for lf in leaves], minlength=5)
    lines.append("size 0..4: " + " ".join(str(int(s)) for s in sizes))
    multi = {g: v for g, v in data["groups"].items() if len(v) > 1}
    lines.append(f"groups with more than one leaf: " + ", ".join(f"{g}({len(v)})" for g, v in sorted(multi.items())))
    return lines


def table(data):
    rows = [f"{'id':>4} {'name':28s} {'kind':6s} {'group':22s} {'parent':>6} size {'area%':>7} {'cx':>6} {'cy':>6} rings verts"]
    for lf in data["leaves"]:
        rows.append(f"{lf['id']:4d} {lf['name']:28s} {lf['kind']:6s} {lf['group']:22s} {lf['parent']:6d} "
                    f"{lf['size']:4d} {100 * lf['area']:7.3f} {lf['c'][0]:6.3f} {lf['c'][1]:6.3f} "
                    f"{len(lf['polys']):5d} {sum(len(r) for r in lf['polys']):5d}")
    return rows


# ------------------------------------------------------------------ overlay

def neighbours(labels, n):
    a = labels.astype(np.int64)
    pairs = []
    for x, y in ((a[:, :-1], a[:, 1:]), (a[:-1], a[1:])):
        d = x != y
        pairs.append(np.stack([x[d], y[d]], 1))
    p = np.unique(np.sort(np.concatenate(pairs), axis=1), axis=0)
    nb = [set() for _ in range(n + 1)]
    for i, j in p:
        nb[i].add(j)
        nb[j].add(i)
    return nb


def colours(data, labels):
    """id -> RGB or None; neighbours of the same kind get different shades."""
    n = len(data["leaves"])
    nb = neighbours(labels, n)
    shade = {}
    col = [None] * (n + 1)
    for lf in sorted(data["leaves"], key=lambda lf: -lf["area"]):
        style = KIND_STYLE[lf["kind"]]
        if style is None:
            continue
        used = {shade[j] for j in nb[lf["id"]] if j in shade and data["leaves"][j - 1]["kind"] == lf["kind"]}
        s = next((k for k in range(SHADES) if k not in used), lf["id"] % SHADES)
        shade[lf["id"]] = s
        (h0, h1), sat, val = style
        hue = h0 + (h1 - h0) * s / (SHADES - 1)
        r, g, b = colorsys.hsv_to_rgb(hue % 1.0, sat, val * (0.75 + 0.25 * (s % 2)))
        col[lf["id"]] = (int(r * 255), int(g * 255), int(b * 255))
    return col


def label_points(labels, n):
    """id -> (x, y) deep inside the leaf's largest piece."""
    pts = [None] * (n + 1)
    for i, sl in enumerate(ndimage.find_objects(labels.astype(np.int32), max_label=n), 1):
        if sl is None:
            continue
        m = labels[sl] == i
        cl, k = ndimage.label(m)
        if k > 1:
            m = cl == (np.argmax(np.bincount(cl.ravel())[1:]) + 1)
        d = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
        y, x = np.unravel_index(np.argmax(d), d.shape)
        pts[i] = (x + sl[1].start, y + sl[0].start, float(d[y, x]))
    return pts


def draw(key, labels, data, col, pts, view, scale, path, min_px_id, min_px_name, font_px):
    vx0, vy0, vx1, vy1 = view
    lab = labels[vy0:vy1, vx0:vx1]
    img = key[vy0:vy1, vx0:vx1].astype(np.float32)
    lut = np.zeros((len(col), 3), np.float32)
    has = np.zeros(len(col), bool)
    for i, c in enumerate(col):
        if c is not None:
            lut[i] = c
            has[i] = True
    tint = has[lab]
    img[tint] = img[tint] * 0.5 + lut[lab][tint] * 0.5
    edge = np.zeros(lab.shape, bool)
    edge[:, 1:] |= lab[:, 1:] != lab[:, :-1]
    edge[1:, :] |= lab[1:, :] != lab[:-1, :]
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    if scale != 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
        e = Image.fromarray(edge.astype(np.uint8) * 255).resize(im.size, Image.BILINEAR)
        edge = np.asarray(e) > 60
    arr = np.asarray(im).copy()
    arr[edge] = (255, 255, 255)
    im = Image.fromarray(arr)
    dr = ImageDraw.Draw(im)
    font = segment._font(font_px)
    for lf in data["leaves"]:
        p = pts[lf["id"]]
        if p is None or lf["area"] * labels.size < min_px_id:
            continue
        x, y, _ = p
        if not (vx0 <= x < vx1 and vy0 <= y < vy1):
            continue
        text = f"{lf['id']} {lf['name']}" if lf["area"] * labels.size >= min_px_name else str(lf["id"])
        dr.text(((x - vx0) * scale, (y - vy0) * scale), text, font=font, anchor="mm",
                fill=(255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0))
    im.save(path)


def overlay(key, labels, data):
    n = len(data["leaves"])
    col = colours(data, labels)
    pts = label_points(labels, n)
    h, w = labels.shape
    os.makedirs(WORK, exist_ok=True)
    for f in os.listdir(WORK):
        if f.startswith("regions_overlay") and f.endswith(".png"):
            os.remove(os.path.join(WORK, f))
    draw(key, labels, data, col, pts, (0, 0, w, h), 0.5, os.path.join(WORK, "regions_overlay.png"),
         0.004 * h * w, 0.012 * h * w, 13)
    tw, th = w // 3, h // 2
    for r in range(2):
        for c in range(3):
            view = (c * tw, r * th, w if c == 2 else (c + 1) * tw, h if r == 1 else (r + 1) * th)
            draw(key, labels, data, col, pts, view, 1.0,
                 os.path.join(WORK, f"regions_overlay_{r}{c}.png"), 250, 3000, 12)


def main():
    with open(JSON, encoding="utf-8") as f:
        data = json.load(f)
    labels = np.asarray(Image.open(ID_PNG)).astype(np.int64)
    key = np.asarray(Image.open(segment.KEY).convert("RGB"))
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(WORK, "regions_table.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(table(data) + summary(data)) + "\n")
    overlay(key, labels, data)
    lines = check(data, labels)
    print("\n".join(lines + summary(data)))
    print("table: local-only/temp/regions_table.txt, overlay: local-only/temp/regions_overlay*.png")


if __name__ == "__main__":
    main()

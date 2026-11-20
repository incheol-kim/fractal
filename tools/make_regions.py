"""Build the region map from the curated spec and the SAM masks.

    .venv\\Scripts\\python.exe tools\\make_regions.py [--masks data/masks.npz]

Reads data/regions_spec.json and the masks file data/masks.npz (kept in the repository;
tools/segment.py built it from its automatic pass and data/regions_prompts.json; the spec refers
to its mask numbers). Each spec leaf's
mask is the union of its "masks" minus the union of its "minus" (mask numbers); if it has
"points" (0..1), only the connected parts of that mask containing a point are kept. Then:
partition in spec order (a later leaf covers an earlier one) -> fill unassigned pixels from
the nearest leaf -> release specks (bits of a leaf thinner than 3 px, and its detached pieces
under SPECK_PX other than its largest) and fill again -> split every "mass" leaf of at least
split.min_leaf_area into tone pieces (they inherit name + "_t<k>", kind, parent and group),
release specks once more -> polygons.

Writes assets/regions_id.png (16-bit grey, 2944x1648, leaf id per pixel) and assets/regions.json:
    { "fingerprint", "w", "h", "leaves": [{ "id", "name", "kind", "parent", "group",
      "bbox": [x0, y0, x1, y1], "area", "c": [cx, cy], "size": 0..4,
      "polys": [[[x, y], ...], ...] }], "groups": {...} }
"fingerprint" is regions_lib.fingerprint of the map written to regions_id.png; what is made
from the map carries it as "regions" and the page checks that they agree (src/consistency.js).
Coordinates are 0..1 (y down); "area" is the fraction of the image; "parent" is the parent
leaf's id, 0 when the leaf has none. tools/make_flat.py adds "ink" and "tone" afterwards, so
re-run it after this script, then the tools after it (tools/README.md).
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import regions_lib  # noqa: E402
import segment  # noqa: E402

SPEC = os.path.join(ROOT, "data", "regions_spec.json")
OUT_ID = os.path.join(ROOT, "assets", "regions_id.png")
OUT_JSON = os.path.join(ROOT, "assets", "regions.json")
KINDS = ("sky", "back", "mass", "part", "object")
# polygon tolerance in pixels: at 1.0 Douglas-Peucker keeps the outer tips of SAM's slightly
# ragged edges and small leaves (windows) come out 2-7% too large; at 0.5 every leaf is
# within 0.6% of its pixel area, for about 30k vertices in all
TOL_PX = 0.5
SPECK_PX = 200


def size_class(area):
    for limit, s in ((0.05, 4), (0.01, 3), (0.002, 2), (0.0003, 1)):
        if area >= limit:
            return s
    return 0


def leaf_mask(spec_leaf, bbox, crops, shape):
    h, w = shape
    m = np.zeros(shape, bool)
    for i in spec_leaf.get("masks", []):
        x0, y0, x1, y1 = bbox[i]
        m[y0:y1, x0:x1] |= crops[i]
    for i in spec_leaf.get("minus", []):
        x0, y0, x1, y1 = bbox[i]
        m[y0:y1, x0:x1] &= ~crops[i]
    pts = spec_leaf.get("points", [])
    if pts:
        lab, _ = ndimage.label(m)
        ids = {int(lab[min(int(y * h), h - 1), min(int(x * w), w - 1)]) for x, y in pts}
        ids.discard(0)
        m = np.isin(lab, sorted(ids))
    return m


def load_spec(path=SPEC):
    with open(path, encoding="utf-8") as f:
        spec = json.load(f)
    names = [lf["name"] for lf in spec["leaves"]]
    dup = {n for n in names if names.count(n) > 1}
    if dup:
        raise SystemExit(f"duplicate leaf names: {sorted(dup)}")
    for lf in spec["leaves"]:
        if lf["kind"] not in KINDS:
            raise SystemExit(f"{lf['name']}: unknown kind {lf['kind']}")
        if lf.get("parent") is not None and lf["parent"] not in names:
            raise SystemExit(f"{lf['name']}: unknown parent {lf['parent']}")
    return spec


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--masks", default=segment.MASKS, help="masks file (default data/masks.npz)")
    args = ap.parse_args()
    spec = load_spec()
    bbox, crops, meta = segment.load_masks(args.masks)
    shape = meta["shape"]
    h, w = shape
    key = np.asarray(Image.open(segment.KEY).convert("RGB"))

    leaves = spec["leaves"]
    masks = [leaf_mask(lf, bbox, crops, shape) for lf in leaves]
    labels = regions_lib.partition(masks, shape)
    counts = np.bincount(labels.ravel(), minlength=len(leaves) + 1)
    empty = [leaves[i]["name"] for i in range(len(leaves)) if counts[i + 1] == 0]
    if empty:
        raise SystemExit(f"leaves with no pixel left (covered or empty masks): {empty}")
    print(f"{len(leaves)} spec leaves, {int(counts[0])} px unassigned before filling")
    labels = regions_lib.fill_unassigned(labels)
    labels = regions_lib.fill_unassigned(regions_lib.drop_specks(labels, SPECK_PX))

    info = [{"name": lf["name"], "kind": lf["kind"], "parent": lf.get("parent"),
             "group": lf.get("group") or lf["name"]} for lf in leaves]
    split = spec.get("split", {})
    min_leaf = split.get("min_leaf_area", 0.012) * h * w
    max_tones = split.get("max_tones", 4)
    for i, lf in enumerate(list(info)):
        if lf["kind"] != "mass" or (labels == i + 1).sum() < min_leaf:
            continue
        before = int(labels.max())
        labels = regions_lib.split_by_tone(labels, key, i + 1, max_tones=max_tones)
        for k in range(2, int(labels.max()) - before + 2):
            info.append(dict(lf, name=f"{lf['name']}_t{k}"))
        if labels.max() > before:
            print(f"  {lf['name']}: split into {int(labels.max()) - before + 1} tone pieces")
    labels = regions_lib.fill_unassigned(regions_lib.drop_specks(labels, SPECK_PX))

    ids = {lf["name"]: i + 1 for i, lf in enumerate(info)}
    n = len(info)
    areas = np.bincount(labels.ravel(), minlength=n + 1)
    objs = ndimage.find_objects(labels.astype(np.int32), max_label=n)
    yy, xx = np.mgrid[0:h, 0:w]
    sum_x = np.bincount(labels.ravel(), weights=xx.ravel(), minlength=n + 1)
    sum_y = np.bincount(labels.ravel(), weights=yy.ravel(), minlength=n + 1)

    out = []
    for i, lf in enumerate(info):
        lid = i + 1
        sy, sx = objs[i]
        area = float(areas[lid]) / (h * w)
        polys = regions_lib.to_polys(labels, lid, tol_px=TOL_PX)
        out.append({
            "id": lid, "name": lf["name"], "kind": lf["kind"],
            "parent": ids[lf["parent"]] if lf["parent"] else 0,
            "group": lf["group"],
            "bbox": [round(sx.start / w, 6), round(sy.start / h, 6), round(sx.stop / w, 6), round(sy.stop / h, 6)],
            "area": round(area, 8),
            "c": [round(sum_x[lid] / areas[lid] / w, 6), round(sum_y[lid] / areas[lid] / h, 6)],
            "size": size_class(area),
            "polys": [[[round(x, 6), round(y, 6)] for x, y in ring] for ring in polys],
        })
    groups = {}
    for lf in out:
        groups.setdefault(lf["group"], []).append(lf["id"])

    os.makedirs(os.path.dirname(OUT_ID), exist_ok=True)
    ids16 = labels.astype(np.uint16)
    Image.fromarray(ids16).save(OUT_ID)
    fp = regions_lib.fingerprint(ids16)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"fingerprint": fp, "w": w, "h": h, "leaves": out, "groups": groups}, f,
                  separators=(",", ":"))
    print(f"{n} leaves, {len(groups)} groups -> {os.path.relpath(OUT_ID, ROOT)}, {os.path.relpath(OUT_JSON, ROOT)}"
          f" (fingerprint {fp})")


if __name__ == "__main__":
    main()

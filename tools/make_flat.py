"""Give every leaf of assets/regions.json an ink and a tone.

Reads assets/palette.json (the inks) and data/flat_hand.json (inks given by hand).
Adds "ink" (index into the palette's inks) and "tone" (0 = pure ink, 1 = paper)
to EVERY leaf. Deterministic and idempotent. Re-running tools/make_regions.py drops
these two fields, so this script MUST be run again after make_regions.py.
Every other field is kept as it is, the region map's "fingerprint" too; it stops if that
fingerprint is missing or is not the one of assets/regions_id.png (the leaf colours are
read through the map).
"""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import flat_lib  # noqa: E402
import regions_lib  # noqa: E402

ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")


def leaf_colours(ids, img, n):
    """Mean RGB of every leaf id (1..n) as an (n+1, 3) array."""
    flat = ids.ravel()
    out = np.zeros((n + 1, 3))
    cnt = np.maximum(np.bincount(flat, minlength=n + 1)[: n + 1], 1)
    for c in range(3):
        out[:, c] = np.bincount(flat, weights=img[..., c].ravel(), minlength=n + 1)[: n + 1] / cnt
    return out


def main():
    with open(os.path.join(ASSETS, "palette.json"), encoding="utf-8") as f:
        pal = json.load(f)
    paper = flat_lib.hex_to_rgb(pal["paper"])
    inks = [flat_lib.hex_to_rgb(i["hex"]) for i in pal["inks"]]
    names = [i["name"] for i in pal["inks"]]
    with open(os.path.join(ROOT, "data", "flat_hand.json"), encoding="utf-8") as f:
        hand = json.load(f)
    auto = flat_lib.auto_inks(hand, names)
    auto_rgb = [inks[k] for k in auto]

    ids = np.array(Image.open(os.path.join(ASSETS, "regions_id.png"))).astype(np.int64)
    h, w = ids.shape
    img = np.array(Image.open(os.path.join(ASSETS, "key_hires.png")).convert("RGB").resize((w, h), Image.BOX), dtype=np.float64)

    path = os.path.join(ASSETS, "regions.json")
    with open(path, encoding="utf-8") as f:
        reg = json.load(f)
    fp = regions_lib.fingerprint(ids)
    if reg.get("fingerprint") != fp:
        sys.exit(f"assets/regions.json has fingerprint {reg.get('fingerprint')}, assets/regions_id.png "
                 f"is {fp}: they were not made together; run tools/make_regions.py, then this script")
    cols = leaf_colours(ids, img, max(l["id"] for l in reg["leaves"]))
    missing = sorted(set(hand.get("ink_by_leaf", {})) - {l["name"] for l in reg["leaves"]})
    if missing:
        sys.exit(f"data/flat_hand.json names leaves that do not exist: {', '.join(missing)}")
    for leaf in reg["leaves"]:
        rgb = cols[leaf["id"]]
        k = flat_lib.forced_ink(leaf["name"], hand, names)
        if k is None:
            k = auto[flat_lib.choose_ink(rgb, auto_rgb)]
        leaf["ink"] = k
        leaf["tone"] = round(flat_lib.tone(rgb, inks[k], paper), 4)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(reg, f, separators=(",", ":"))
    counts = np.bincount([l["ink"] for l in reg["leaves"]], minlength=len(inks))
    for i, c in zip(pal["inks"], counts):
        print(f'{i["name"]:10s} {i["hex"]} {c}')


if __name__ == "__main__":
    main()

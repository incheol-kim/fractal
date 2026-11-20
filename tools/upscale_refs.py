"""Upscale the reference images 2x with the key image's upscaler, for the baked collage cuts.

    .venv\\Scripts\\python.exe tools\\upscale_refs.py [--only data/collage.json]

The reference images are every PNG under the two roots of collage_lib.REF_ROOTS (resources/ first,
then local-only/resources/), the key image excluded. Each one, named <folder>/<file>, is upscaled
with tools/upscale.py's model (HAT-L 2x, DEFAULT_MODEL) to collage_lib.upscaled_path(name)
(local-only/assets/collage_src/<folder>/<file>, not in git). An image whose upscale exists is
skipped, so the tool can be stopped and started again. --only <file> upscales only the images that
file uses (data/collage.json: blocks[].images[].image; assets/collage.json: blocks[].cuts[].src).
Each result is shrunk back and compared with the original (imgcheck.fidelity); a line goes to
local-only/assets/collage_src/upscale_log.txt:

    <k>/<n>\\t<folder>/<file>\\t5888x3296\\tmean <m>\\tp99_tile <p>\\t<seconds> s

and a result over plan 1's limits (mean 2.5, p99_tile 8.0) is not kept: the line ends in
"OVER LIMIT" and the tool stops. The file is written to <file>.tmp.png and renamed. Needs the GPU
and local-only/models/ (see tools/upscale.py); about 7.6 minutes an image on this machine.
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import collage_lib  # noqa: E402
import imgcheck  # noqa: E402
import segment  # noqa: E402  (segment.KEY: the key image)

FIDELITY_MEAN = 2.5      # plan 1's limits for an upscale
FIDELITY_P99 = 8.0
LOG = collage_lib.UPSCALED_ROOT + "/upscale_log.txt"


def key_name():
    """The key image's name <folder>/<file> (segment.KEY)."""
    return collage_lib.ref_name(os.path.relpath(segment.KEY, ROOT).replace("\\", "/"))


def references(root=ROOT):
    """-> {<folder>/<file>: repository-relative path} of every reference PNG but the key image (first root wins)."""
    key = key_name()
    found = {}
    for r in collage_lib.REF_ROOTS:
        for p in sorted(glob.glob(os.path.join(root, r, "*", "*.png"))):
            name = os.path.relpath(p, os.path.join(root, r)).replace("\\", "/")
            if name != key:
                found.setdefault(name, r + "/" + name)
    return found


def used_names(path):
    """The reference names a data/collage.json or assets/collage.json uses."""
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    names = set()
    for b in d["blocks"]:
        names.update(collage_lib.ref_name(im["image"]) for im in b.get("images", []))
        names.update(collage_lib.ref_name(c["src"]) for c in b.get("cuts", []))
    return names


def _hat_upscaler():
    import upscale   # torch and spandrel are loaded only when an image needs them
    desc = upscale.load_model(upscale.DEFAULT_MODEL)
    return lambda rgb: upscale.upscale(rgb, desc)


def run(root=ROOT, only=None, upscaler=None, out=print):
    """Upscale what is missing. only: the path of a collage JSON whose images are the ones to do.
    upscaler: rgb uint8 (H, W, 3) -> (2H, 2W, 3); the HAT-L model when None (loaded at the first image
    that needs it). -> the log lines written."""
    refs = references(root)
    order = sorted(refs)
    if only is not None:
        want = used_names(only)
        missing = sorted(want - set(refs))
        if missing:
            raise SystemExit("used by %s but in neither root: %s" % (only, ", ".join(missing)))
        order = sorted(want)
    out("%d images" % len(order))
    lines = []
    for k, name in enumerate(order):
        dst = os.path.join(root, collage_lib.upscaled_path(name))
        if os.path.exists(dst):
            continue
        if upscaler is None:
            upscaler = _hat_upscaler()
        t0 = time.time()
        with Image.open(os.path.join(root, refs[name])) as im:
            orig = np.asarray(im.convert("RGB"))
        hires = upscaler(orig)
        h, w = orig.shape[:2]
        if hires.shape != (2 * h, 2 * w, 3) or hires.dtype != np.uint8:
            raise SystemExit("%s: the upscaler returned %s %s, not %dx%d uint8" % (name, hires.shape, hires.dtype, 2 * w, 2 * h))
        r = imgcheck.fidelity(orig, hires)
        over = r["mean"] > FIDELITY_MEAN or r["p99_tile"] > FIDELITY_P99
        if not over:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            Image.fromarray(hires).save(dst + ".tmp.png", compress_level=6)
            os.replace(dst + ".tmp.png", dst)
        line = "%d/%d\t%s\t%dx%d\tmean %.4f\tp99_tile %.4f\t%.0f s%s" % (
            k + 1, len(order), name, 2 * w, 2 * h, r["mean"], r["p99_tile"], time.time() - t0, "\tOVER LIMIT" if over else "")
        os.makedirs(os.path.join(root, collage_lib.UPSCALED_ROOT), exist_ok=True)
        with open(os.path.join(root, LOG), "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
        lines.append(line)
        out(line)
        if over:
            raise SystemExit("%s: the upscale changes the picture (limits: mean %.1f, p99_tile %.1f); not kept, stopped"
                             % (name, FIDELITY_MEAN, FIDELITY_P99))
    out("done")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="a collage JSON (data/collage.json): upscale only the images it uses")
    a = ap.parse_args()
    run(ROOT, only=None if a.only is None else os.path.join(ROOT, a.only),
        out=lambda s: print(s, flush=True))


if __name__ == "__main__":
    main()

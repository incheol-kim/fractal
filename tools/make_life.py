"""The life map: where the finished picture flows (clouds), trembles (leaves) and breathes (lamps in the rooms).

    .venv\\Scripts\\python.exe tools\\make_life.py

data/life.json names, per channel, the region groups (and single leaves) that move and a feather in key
image px (2944 wide). A channel's value is 0 at the edge of its area, rises with the distance from that edge
(the edge of the picture and the `keep_still` rectangles, boxes [x0, y0, x1, y1] in 0..1, are outside too)
and is 1 from `feather` px inwards, so a displacement made from it does not break at a leaf boundary. With
`rim` (px) it stays 0 for the first rim px inside the edge and rises over the feather from there: the region
map's boundary runs through the antialiased edge of what borders the area, and those pixels stay still.

A channel may also hold still the thin dark things of the wire-free plate (assets/key_plate.png) inside its
area, `keep_thin`: {"size", "darker", "grow"}. The region map counts antennas, rods, pipes and the stretches
of wire the plate kept as sky; moved with the sky they bend and break. Where the plate's luminance (0..255,
at the picture's size) is more than `darker` below its grey closing with a size x size px window (a black
top-hat: dark things narrower than the window; broad shading is left alone), inside the channel's leaves,
grown by `grow` px, the pixel counts as outside as a keep_still box does, so the channel feathers to zero
round each of them as it does at the edge of its area. A change of the plate means running this again.

Writes assets/life.png (R flow, G tremble, B breath; round(w * 255)), assets/life.json (the region map's
fingerprint as "regions", each channel's leaves, feather and area share, and with keep_thin its values and
the share of the area held still, "held") and, to look at, local-only/temp/life_preview.png (the darkened key
image with the three channels laid over it and the held pixels in orange).
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import regions_lib  # noqa: E402

CHANNELS = ("flow", "tremble", "breath")
PREVIEW_COLOURS = ((0, 200, 255), (60, 255, 60), (255, 70, 200))   # flow, tremble, breath
PREVIEW_HELD = (255, 140, 0)   # the pixels keep_thin holds still
PREVIEW_DIM = 0.35
KEYS = {"groups", "leaves", "feather", "rim", "keep_still", "keep_thin"}
THIN_KEYS = ("size", "darker", "grow")
LUMA = (0.299, 0.587, 0.114)   # Rec. 601, as the page's shaders


def _load(root, rel):
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        raise SystemExit("make_life: %s is missing" % rel)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def weights(ids, leaves, feather, keep_still=(), hold=None, rim=0):
    """-> float32 (h, w): at the pixels of `leaves`, (the distance to the nearest pixel outside them - rim) /
    feather, clipped to 0..1 (outside the picture, inside a keep_still box [x0, y0, x1, y1] in 0..1 and where
    `hold` (bool (h, w)) is true count as outside), so the first `rim` px inside stay still. 0 elsewhere."""
    h, w = ids.shape
    inside = np.isin(ids, list(leaves))
    for x0, y0, x1, y1 in keep_still:
        inside[int(round(y0 * h)):int(round(y1 * h)), int(round(x0 * w)):int(round(x1 * w))] = False
    if hold is not None:
        inside &= ~hold
    d = ndimage.distance_transform_edt(np.pad(inside, 1))[1:-1, 1:-1]
    return np.where(inside, np.clip((d - rim) / feather, 0.0, 1.0), 0.0).astype(np.float32)


def disk(r):
    """A round structuring element of radius r px (2r + 1 across)."""
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def thin_dark(lum, inside, size, darker, grow):
    """-> bool (h, w): the thin dark things of `lum` (float, 0..255) inside `inside`: where lum is more than
    `darker` below its grey closing with a size x size window (a black top-hat), grown by `grow` px."""
    held = (ndimage.black_tophat(lum, size=size) > darker) & inside
    if grow > 0 and held.any():
        held = ndimage.binary_dilation(held, structure=disk(grow))
    return held


def plate_luminance(root, w, h):
    """The wire-free plate (assets/key_plate.png) box-averaged to w x h, its luminance (float32, 0..255)."""
    path = os.path.join(root, "assets", "key_plate.png")
    if not os.path.exists(path):
        raise SystemExit("make_life: assets/key_plate.png is missing; run tools/make_plate.py")
    with Image.open(path) as im:
        rgb = np.asarray(im.convert("RGB").resize((w, h), Image.BOX), np.float32)
    return rgb @ np.asarray(LUMA, np.float32)


def _thin_spec(name, thin):
    """keep_thin's three numbers, checked. Stops on anything else."""
    if not isinstance(thin, dict) or set(thin) != set(THIN_KEYS):
        raise SystemExit("data/life.json: %s: keep_thin must be {%s}" % (name, ", ".join('"%s"' % k for k in THIN_KEYS)))
    size, darker, grow = (thin[k] for k in THIN_KEYS)
    if not (isinstance(size, int) and size >= 3 and isinstance(grow, int) and grow >= 0 and isinstance(darker, (int, float)) and darker >= 0):
        raise SystemExit("data/life.json: %s: keep_thin wants a whole size >= 3, a whole grow >= 0 and darker >= 0" % name)
    return size, darker, grow


def _leaves_of(regions, name, spec):
    """The sorted leaf ids of a channel: its groups' leaves and its named leaves. Stops on an unknown name."""
    extra = set(spec) - KEYS
    if extra:
        raise SystemExit("data/life.json: %s: unknown key %s (allowed: %s)" % (name, ", ".join(sorted(extra)), ", ".join(sorted(KEYS))))
    ids = set()
    for g in spec.get("groups", []):
        if g not in regions["groups"]:
            raise SystemExit("data/life.json: %s: no group %r in assets/regions.json" % (name, g))
        ids |= set(regions["groups"][g])
    by_name = {}
    for leaf in regions["leaves"]:
        by_name.setdefault(leaf["name"], []).append(leaf["id"])
    for n in spec.get("leaves", []):
        if n not in by_name:
            raise SystemExit("data/life.json: %s: no leaf %r in assets/regions.json" % (name, n))
        ids |= set(by_name[n])
    return sorted(ids)


def _ids(root):
    return np.asarray(Image.open(os.path.join(root, "assets", "regions_id.png")))


def build(root=ROOT, spec=None):
    """-> (rgb uint8 (h, w, 3), meta, held bool (h, w): the pixels the channels' keep_thin hold still).
    `spec` replaces data/life.json (for tests)."""
    spec = _load(root, "data/life.json") if spec is None else spec
    regions = _load(root, "assets/regions.json")
    ids = _ids(root)
    if regions_lib.fingerprint(ids) != regions["fingerprint"]:
        raise SystemExit("make_life: assets/regions_id.png does not match the fingerprint of assets/regions.json; run tools/make_regions.py")
    h, w = ids.shape
    rgb = np.zeros((h, w, 3), np.uint8)
    held = np.zeros((h, w), bool)
    lum = None
    channels = {}
    for c, name in enumerate(CHANNELS):
        s = spec[name]
        leaves = _leaves_of(regions, name, s)
        inside = np.isin(ids, leaves)
        hold = None
        if "keep_thin" in s:
            size, darker, grow = _thin_spec(name, s["keep_thin"])
            if lum is None:
                lum = plate_luminance(root, w, h)
            hold = thin_dark(lum, inside, size, darker, grow)
            held |= hold
        rim = s.get("rim", 0)
        if not (isinstance(rim, int) and rim >= 0):
            raise SystemExit("data/life.json: %s: rim must be a whole number of px >= 0" % name)
        wt = weights(ids, set(leaves), s["feather"], s.get("keep_still", ()), hold, rim)
        rgb[..., c] = np.round(wt * 255).astype(np.uint8)
        ch = {"leaves": leaves, "feather": s["feather"], "area": round(float(inside.mean()), 6)}
        if "rim" in s:
            ch["rim"] = rim
        if hold is not None:
            ch["keep_thin"] = {k: s["keep_thin"][k] for k in THIN_KEYS}
            ch["held"] = round(float((hold & inside).sum() / max(int(inside.sum()), 1)), 6)
        channels[name] = ch
    meta = {"regions": regions["fingerprint"], "file": "life.png", "w": w, "h": h, "channels": channels}
    return rgb, meta, held


def dumps(meta):
    lines = ["{", ' "regions": %s,' % json.dumps(meta["regions"]), ' "file": %s,' % json.dumps(meta["file"]),
             ' "w": %d,' % meta["w"], ' "h": %d,' % meta["h"], ' "channels": {']
    names = list(meta["channels"])
    for i, name in enumerate(names):
        lines.append("  %s: %s%s" % (json.dumps(name), json.dumps(meta["channels"][name], separators=(", ", ": ")),
                                     "," if i < len(names) - 1 else ""))
    lines += [" }", "}"]
    return "\n".join(lines) + "\n"


def preview(rgb, held=None, root=ROOT):
    """The darkened key image with each channel laid over it in its colour and the held pixels in orange
    (to look at)."""
    h, w = rgb.shape[:2]
    key = Image.open(os.path.join(root, "assets", "key_hires.png")).convert("RGB").resize((w, h), Image.LANCZOS)
    out = np.asarray(key, np.float32) * PREVIEW_DIM
    for c, col in enumerate(PREVIEW_COLOURS):
        a = (rgb[..., c].astype(np.float32) / 255.0)[..., None]
        out = out * (1 - 0.6 * a) + np.asarray(col, np.float32) * 0.6 * a
    if held is not None:
        out[held] = out[held] * 0.2 + np.asarray(PREVIEW_HELD, np.float32) * 0.8
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8))


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


def main():
    rgb, meta, held = build()
    Image.fromarray(rgb).save(os.path.join(ROOT, "assets", "life.png"), optimize=True)
    _write(os.path.join(ROOT, "assets", "life.json"), dumps(meta).encode("utf-8"))
    os.makedirs(paths.TEMP, exist_ok=True)
    preview(rgb, held).save(os.path.join(paths.TEMP, "life_preview.png"))
    for name, ch in meta["channels"].items():
        line = "%-8s %3d leaves  feather %2d px  area %.2f%%" % (name, len(ch["leaves"]), ch["feather"], ch["area"] * 100)
        if "held" in ch:
            line += "  held still %.2f%% of it (keep_thin %s)" % (ch["held"] * 100, json.dumps(ch["keep_thin"]))
        print(line)


if __name__ == "__main__":
    main()

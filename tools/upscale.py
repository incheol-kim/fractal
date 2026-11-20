"""Upscale the key image 2x with a local super-resolution model, then check fidelity.

    .venv\\Scripts\\python.exe tools\\upscale.py --src <key image> --out assets/key_hires.png [--model <name>]

Chosen model (2026-11-16): hat-l-x2 = HAT-L, classical SR x2, ImageNet-pretrained
    weights  HAT-L_SRx2_ImageNet-pretrain.pth
             sha256 2818c7ca8d72ec4cc5f31c93203d55252a662dd35cda34ce1a69661f97dcd38f
    source   https://drive.google.com/file/d/16xtMezHvckdWEuSiOxcO-dgOlsI0rEUg
             (the authors' model zoo, linked from https://github.com/XPixelGroup/HAT)
    result   assets/key_hires.png 5888x3296, fidelity mean 0.3550, p99_tile 1.1025
             (0-255 scale; worst tile 1.73 at 1536,384, a fine mesh railing)
    Compared against DAT x2 (mean 0.3883, p99_tile 1.1145), DRCT-L x4 (0.3863,
    1.1318) and the Real-ESRGAN x2plus baseline (3.0473, 7.9513); the three
    transformers look alike, Real-ESRGAN smooths brushwork and re-draws texture.
    Run with torch 2.15.0+cu134, spandrel 0.4.2, tile 512 / overlap 128.

The model runs on the GPU in full fp32 (no TF32), in overlapping tiles that are
cross-faded so no seam shows. A 4x model's result is reduced to 2x with Lanczos.
Afterwards the result is shrunk back (area average) and compared with the
original; the numbers go to local-only/temp/upscale.txt and the 12 most different
tiles to local-only/temp/upscale_worst.png.

Weights live in local-only/models/ (not in git). Download them from the URLs
in MODELS. .pth checkpoints are only ever opened with torch.load(weights_only=True).
"""
import argparse
import hashlib
import math
import os
import sys

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from spandrel import ImageModelDescriptor, ModelLoader, canonicalize_state_dict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

import imgcheck  # noqa: E402

MODEL_DIR = str(paths.MODELS)
WORK = str(paths.TEMP)

# name -> (weights file, official source)
MODELS = {
    "hat-l-x2": (
        "HAT-L_SRx2_ImageNet-pretrain.pth",
        "https://drive.google.com/file/d/16xtMezHvckdWEuSiOxcO-dgOlsI0rEUg "
        "(model zoo linked from https://github.com/XPixelGroup/HAT)",
    ),
    "dat-x2": (
        "DAT_x2.pth",
        "https://drive.google.com/file/d/1AYfLMnIqSlOJyOGabaRI48TEJh440fsN "
        "(model zoo linked from https://github.com/zhengchen1999/DAT)",
    ),
    "drct-l-x4": (
        "DRCT-L_X4.pth",
        "https://drive.google.com/file/d/1bVxvA6QFbne2se0CQJ-jyHFy94UOi3h5 "
        "(model zoo linked from https://github.com/ming053l/DRCT)",
    ),
    "realesrgan-x2plus": (
        "RealESRGAN_x2plus.pth",
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    ),
}
DEFAULT_MODEL = "hat-l-x2"

TILE = 512      # input pixels per tile side
OVERLAP = 128   # minimum overlap between neighbouring tiles, input pixels


def load_model(name):
    path = os.path.join(MODEL_DIR, MODELS[name][0])
    if not os.path.exists(path):
        raise SystemExit(f"missing weights {path}\ndownload from: {MODELS[name][1]}")
    # the official checkpoints are pickles: open them weights-only (tensors and plain containers)
    raw = torch.load(path, map_location="cpu", weights_only=True)
    desc = ModelLoader().load_from_state_dict(canonicalize_state_dict(raw))
    assert isinstance(desc, ImageModelDescriptor)
    return desc.cuda().eval().float()


def tile_starts(length, tile, overlap):
    """Evenly spaced tile starts covering [0, length) with at least `overlap` shared."""
    if length <= tile:
        return [0]
    n = math.ceil((length - overlap) / (tile - overlap))
    return [round(i * (length - tile) / (n - 1)) for i in range(n)]


def ramp(n, fade_lo, fade_hi, fade):
    """1-D blend weight: raised-cosine fade-in/out of `fade` samples on inner sides."""
    w = np.ones(n, np.float32)
    k = 0.5 - 0.5 * np.cos(np.pi * (np.arange(fade) + 0.5) / fade)
    if fade_lo:
        w[:fade] = np.minimum(w[:fade], k)
    if fade_hi:
        w[n - fade:] = np.minimum(w[n - fade:], k[::-1])
    return w


def run_tiles(img, desc, tile=TILE, overlap=OVERLAP):
    """Run the model over uint8 (H, W, 3) in cross-faded tiles -> float32 (sH, sW, 3) in 0..1."""
    torch.backends.fp32_precision = "ieee"
    h, w = img.shape[:2]
    s = desc.scale
    src = torch.from_numpy(img.copy()).permute(2, 0, 1)[None].float().div(255).cuda()
    out = np.zeros((h * s, w * s, 3), np.float32)
    acc = np.zeros((h * s, w * s, 1), np.float32)
    ys, xs = tile_starts(h, tile, overlap), tile_starts(w, tile, overlap)
    fade = overlap * s
    for y0 in ys:
        y1 = min(y0 + tile, h)
        wy = ramp((y1 - y0) * s, y0 > 0, y1 < h, fade)
        for x0 in xs:
            x1 = min(x0 + tile, w)
            wx = ramp((x1 - x0) * s, x0 > 0, x1 < w, fade)
            res = desc(src[:, :, y0:y1, x0:x1])[0].permute(1, 2, 0).cpu().numpy()
            wt = (wy[:, None] * wx[None, :])[:, :, None]
            out[y0 * s:y1 * s, x0 * s:x1 * s] += res * wt
            acc[y0 * s:y1 * s, x0 * s:x1 * s] += wt
    return out / acc


def resize_lanczos(img, h, w):
    """Lanczos resize of a float (H, W, 3) image, channel by channel in float."""
    chans = [np.asarray(Image.fromarray(np.ascontiguousarray(img[:, :, c], np.float32))
                        .resize((w, h), Image.LANCZOS)) for c in range(3)]
    return np.stack(chans, axis=2)


def upscale(img, desc):
    """uint8 (H, W, 3) -> uint8 (2H, 2W, 3)."""
    h, w = img.shape[:2]
    res = run_tiles(img, desc)
    if desc.scale != 2:
        res = resize_lanczos(res, 2 * h, 2 * w)
    return np.clip(np.rint(res * 255.0), 0, 255).astype(np.uint8)


def label(im, text, size=28):
    """Image with a white caption strip on top."""
    font = ImageFont.load_default(size=size)
    pad = (size + 6) * (text.count("\n") + 1) + 6
    canvas = Image.new("RGB", (im.width, im.height + pad), "white")
    canvas.paste(im, (0, pad))
    ImageDraw.Draw(canvas).text((6, 4), text, fill="black", font=font)
    return canvas


def grid(cells, cols, gap=12):
    """Lay out equally sized PIL images in rows of `cols`."""
    cw, ch = cells[0].size
    rows = math.ceil(len(cells) / cols)
    sheet = Image.new("RGB", (cols * cw + (cols - 1) * gap, rows * ch + (rows - 1) * gap), (128, 128, 128))
    for i, c in enumerate(cells):
        sheet.paste(c, ((i % cols) * (cw + gap), (i // cols) * (ch + gap)))
    return sheet


def worst_sheet(orig, hires, worst, ctx=32, zoom=2):
    """Original (bicubic 2x) and result side by side for each worst tile, with context."""
    h, w = orig.shape[:2]
    t = imgcheck.TILE
    cells = []
    for x, y, m in worst:
        x0, y0 = min(max(x - ctx, 0), w - t - 2 * ctx), min(max(y - ctx, 0), h - t - 2 * ctx)
        n = t + 2 * ctx
        o = Image.fromarray(orig[y0:y0 + n, x0:x0 + n]).resize((2 * n, 2 * n), Image.BICUBIC)
        r = Image.fromarray(hires[2 * y0:2 * (y0 + n), 2 * x0:2 * (x0 + n)])
        box = [2 * (x - x0), 2 * (y - y0), 2 * (x - x0 + t) - 1, 2 * (y - y0 + t) - 1]
        for im, name in ((o, f"original (bicubic 2x)  tile {x},{y}"), (r, f"result  mean {m:.2f}")):
            ImageDraw.Draw(im).rectangle(box, outline=(255, 0, 255))
            big = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
            cells.append(label(big, name))
    return grid(cells, 6)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(MODELS))
    a = ap.parse_args()

    orig = np.asarray(Image.open(a.src).convert("RGB"))
    desc = load_model(a.model)
    hires = upscale(orig, desc)
    Image.fromarray(hires).save(a.out, compress_level=9)

    r = imgcheck.fidelity(orig, hires)
    os.makedirs(WORK, exist_ok=True)
    worst_sheet(orig, hires, r["worst"]).save(os.path.join(WORK, "upscale_worst.png"))
    weights = os.path.join(MODEL_DIR, MODELS[a.model][0])
    lines = [
        f"model: {a.model} ({desc.architecture.name}, x{desc.scale})",
        f"weights: {MODELS[a.model][0]} sha256 {sha256(weights)}",
        f"source: {MODELS[a.model][1]}",
        f"tile {TILE}, overlap {OVERLAP} (input px), fp32",
        f"src: {a.src} {orig.shape[1]}x{orig.shape[0]}",
        f"out: {a.out} {hires.shape[1]}x{hires.shape[0]} {os.path.getsize(a.out)} bytes",
        f"mean: {r['mean']:.4f}",
        f"p99_tile: {r['p99_tile']:.4f}",
        "worst (x, y, mean):",
    ] + [f"  {x} {y} {m:.4f}" for x, y, m in r["worst"]]
    with open(os.path.join(WORK, "upscale.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

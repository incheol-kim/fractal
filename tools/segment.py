"""Masks of the key image with SAM 2.1: automatic masks, plus extra masks from prompts.

    .venv\\Scripts\\python.exe tools\\segment.py                       rebuild data/masks.npz: automatic masks,
                                                                 then every prompt of data/regions_prompts.json
    .venv\\Scripts\\python.exe tools\\segment.py --points "x,y;x,y" [--neg "x,y"] [--box x0,y0,x1,y1] [--pick N]
    .venv\\Scripts\\python.exe tools\\segment.py --rect x0,y0,x1,y1     a plain rectangle mask (no model)
    .venv\\Scripts\\python.exe tools\\segment.py --batch prompts.json  several prompt masks in one run
    .venv\\Scripts\\python.exe tools\\segment.py --sheets               only redraw the sheets
    .venv\\Scripts\\python.exe tools\\segment.py --show 3,17,240        panels for existing masks
    --masks PATH (any mode): use this masks file instead of data/masks.npz

The masks file, data/masks.npz, is hand-data input kept in the repository: data/regions_spec.json
refers to its mask numbers, and a rebuild on another GPU, driver or torch version may number the
masks differently. A rebuild writes over it, so git shows any change before it is used.

Coordinates are 0..1 of the key image (x across, y down). data/regions_prompts.json holds the
hand-placed prompts in mask order ({"auto_masks": N, "prompts": [{"mask": number, ...prompt}]}),
so that one run without options reproduces the mask numbers data/regions_spec.json refers to.
A prompt given with --points / --box / --rect / --batch is appended both to the masks file and to
data/regions_prompts.json, and its number is printed. A batch file is a list of
{"points": [[x, y], ...], "neg": [...], "box": [x0, y0, x1, y1], "pick": N, "note": str}
(any of points / box) or {"rect": [x0, y0, x1, y1], "note": str}. With one point SAM returns
three nested masks; --pick chooses one of them (0 = smallest), otherwise the best-scoring one
is taken. A rect is a plain rectangle, used as a base behind clutter that later masks cover.

Automatic masks: SAM is prompted with a 32x32 point grid on the whole image, on 2x2 and on
3x3 overlapping tiles (the tiles see small things at about native resolution). Masks are kept
when SAM's predicted IoU >= 0.80 and stability >= 0.90; a tile drops masks cut by its inner
edges; duplicates (box IoU > 0.7) keep the one from the finest tile. Islands and holes under
64 px are cleaned. Masks are numbered by area, largest first (0-based).

Sheets: local-only/temp/masks_sheet_L.png (masks >= 1% of the image, whole image at 1/2),
masks_sheet_M_<q>.png (0.15-1%, four quadrants at 1:1), masks_sheet_S_<r><c>.png (< 0.15%,
3x2 grid at 1.5x), masks_sheet_P_<n>.png (one panel per mask: the masks just made from
prompts, or those listed with --show).

Model (2026-11-16): SAM 2.1 Hiera-L, transformers Sam2Model (transformers 5.23.0), weights
    model.safetensors  sha256 dc407dce21301fd94abb395c5099b4f2c455fdc8a8f261ac3d0ea6d4cd197230
    from Meta's Hugging Face repository https://huggingface.co/facebook/sam2.1-hiera-large
    (with config.json, preprocessor_config.json, processor_config.json), kept in
    local-only/models/sam2.1-hiera-large/. safetensors only, no pickle. Runs in fp32 on CUDA.
"""
import argparse
import colorsys
import hashlib
import json
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import paths  # noqa: E402

WORK = str(paths.TEMP)
MASKS = os.path.join(ROOT, "data", "masks.npz")  # committed: the spec refers to its mask numbers
PROMPTS = os.path.join(ROOT, "data", "regions_prompts.json")
KEY = os.path.join(ROOT, "resources", "midjourney_images", "city folding", "city-folding-05.png")
MODEL_DIR = str(paths.MODELS / "sam2.1-hiera-large")
MODEL_URL = "https://huggingface.co/facebook/sam2.1-hiera-large/resolve/main/"
MODEL_FILES = ["config.json", "preprocessor_config.json", "processor_config.json", "model.safetensors"]
MODEL_SHA256 = "dc407dce21301fd94abb395c5099b4f2c455fdc8a8f261ac3d0ea6d4cd197230"

GRID = 32             # prompt points per tile side
PRED_IOU = 0.80
STABILITY = 0.90
BOX_NMS = 0.7
EDGE_PX = 12          # a tile drops masks whose box comes this close to an inner tile edge
MIN_PX = 64           # islands / holes smaller than this are cleaned
BATCH = 64

SMALL, LARGE = 0.0015, 0.01


# ------------------------------------------------------------------ mask file

def load_masks(path=MASKS):
    """-> (bbox (N, 4) x0 y0 x1 y1 in pixels, end exclusive; crops: list of bool arrays;
    meta: score (N, 2) predicted IoU and stability, source (N,) tile index or -1 for a prompt
    mask, prompts {number: prompt}, shape (h, w))."""
    with np.load(path, allow_pickle=False) as z:
        n = int(z["count"])
        bbox = z["bbox"].astype(np.int64)
        crops = [z[f"m{i:05d}"] for i in range(n)]
        meta = {"score": z["score"], "source": z["source"],
                "prompts": json.loads(bytes(z["prompts"]).decode("utf-8")),
                "shape": tuple(int(v) for v in z["shape"])}
    return bbox, crops, meta


def save_masks(bbox, crops, score, source, prompts, shape, path=MASKS):
    arrays = {f"m{i:05d}": c for i, c in enumerate(crops)}
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    np.savez_compressed(
        path, count=np.int64(len(crops)), bbox=np.asarray(bbox, np.int32).reshape(-1, 4),
        score=np.asarray(score, np.float32).reshape(-1, 2), source=np.asarray(source, np.int16),
        prompts=np.frombuffer(json.dumps(prompts).encode("utf-8"), np.uint8),
        shape=np.asarray(shape, np.int64), **arrays)


def load_prompts(path=PROMPTS):
    """-> (number of automatic masks they follow, list of prompts with their "mask" numbers)."""
    if not os.path.exists(path):
        return None, []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data["auto_masks"], data["prompts"]


def save_prompts(auto_masks, prompts, path=PROMPTS):
    with open(path, "w", encoding="utf-8") as f:
        f.write('{\n  "auto_masks": %d,\n  "prompts": [\n' % auto_masks)
        f.write(",\n".join("    " + json.dumps(p, separators=(", ", ": ")) for p in prompts))
        f.write("\n  ]\n}\n")


def to_crop(m):
    ys, xs = np.nonzero(m)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    return [int(x0), int(y0), int(x1), int(y1)], m[y0:y1, x0:x1].copy()


def clean(m, min_px=MIN_PX):
    """Remove islands and fill holes smaller than min_px (the largest island always stays)."""
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        keep = sizes >= min_px
        keep[np.argmax(sizes)] = True
        m = keep[lab]
    holes, n = ndimage.label(~m)
    if n:
        sizes = np.bincount(holes.ravel())
        border = np.unique(np.concatenate([holes[0], holes[-1], holes[:, 0], holes[:, -1]]))
        small = sizes < min_px
        small[0] = False
        small[border] = False
        m = m | small[holes]
    return m


# ------------------------------------------------------------------ model

def ensure_model():
    os.makedirs(MODEL_DIR, exist_ok=True)
    for f in MODEL_FILES:
        p = os.path.join(MODEL_DIR, f)
        if not os.path.exists(p):
            print("downloading", MODEL_URL + f)
            req = urllib.request.Request(MODEL_URL + f, headers={"User-Agent": "python-urllib"})
            with urllib.request.urlopen(req) as r, open(p + ".part", "wb") as out:
                while chunk := r.read(1 << 22):
                    out.write(chunk)
            os.replace(p + ".part", p)
    h = hashlib.sha256()
    with open(os.path.join(MODEL_DIR, "model.safetensors"), "rb") as f:
        while chunk := f.read(1 << 24):
            h.update(chunk)
    if h.hexdigest() != MODEL_SHA256:
        raise SystemExit(f"model.safetensors sha256 mismatch: {h.hexdigest()}")


class Sam:
    def __init__(self):
        import torch
        from transformers import Sam2Model, Sam2Processor
        ensure_model()
        if not torch.cuda.is_available():
            raise SystemExit("CUDA is not available")
        self.torch = torch
        self.dev = torch.device("cuda")
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        self.model = Sam2Model.from_pretrained(MODEL_DIR, dtype=torch.float32,
                                               use_safetensors=True).to(self.dev).eval()
        self.proc = Sam2Processor.from_pretrained(MODEL_DIR)

    def embed(self, img):
        """img: (h, w, 3) uint8 -> embeddings of the image resized to 1024x1024."""
        pv = self.proc(images=Image.fromarray(img), return_tensors="pt")["pixel_values"]
        with self.torch.no_grad():
            return self.model.get_image_embeddings(pv.to(self.dev))

    def decode(self, emb, size, points=None, labels=None, boxes=None, multimask=True):
        """Prompts in tile pixels. points (B, P, 2), labels (B, P), boxes (B, 4).
        -> low-res logits (B, M, 256, 256) on the GPU and predicted IoU (B, M)."""
        torch = self.torch
        h, w = size
        sx, sy = 1024.0 / w, 1024.0 / h
        kw = {}
        if points is not None:
            p = torch.as_tensor(np.asarray(points, np.float32) * [sx, sy], device=self.dev)
            kw["input_points"] = p[None]
            kw["input_labels"] = torch.as_tensor(np.asarray(labels), device=self.dev, dtype=torch.int64)[None]
        if boxes is not None:
            b = torch.as_tensor(np.asarray(boxes, np.float32) * [sx, sy, sx, sy], device=self.dev)
            kw["input_boxes"] = b[None]
        with torch.no_grad():
            out = self.model(image_embeddings=emb, multimask_output=multimask, **kw)
        return out.pred_masks[0], out.iou_scores[0]

    def upsample(self, logits, size):
        import torch.nn.functional as F
        return F.interpolate(logits[:, None].float(), size, mode="bilinear", align_corners=False)[:, 0] > 0


def tiles(w, h):
    """(level, x0, y0, x1, y1): the whole image, then 2x2 and 3x3 tiles overlapping by ~20%."""
    out = [(0, 0, 0, w, h)]
    for level, n in ((1, 2), (2, 3)):
        tw, th = int(round(w / n * 1.2)), int(round(h / n * 1.2))
        for j in range(n):
            for i in range(n):
                x0 = int(round(i * (w - tw) / (n - 1)))
                y0 = int(round(j * (h - th) / (n - 1)))
                out.append((level, x0, y0, x0 + tw, y0 + th))
    return out


def auto_masks(sam, key):
    import torch
    from torchvision.ops import nms
    H, W = key.shape[:2]
    found = []   # (tile, level, iou, stability, bbox in image pixels, crop)
    for t, (level, x0, y0, x1, y1) in enumerate(tiles(W, H)):
        tw, th = x1 - x0, y1 - y0
        emb = sam.embed(key[y0:y1, x0:x1])
        g = (np.arange(GRID) + 0.5) / GRID
        pts = np.stack(np.meshgrid(g * tw, g * th), -1).reshape(-1, 1, 2)
        keep_logits, keep_iou, keep_stab = [], [], []
        for b in range(0, len(pts), BATCH):
            p = pts[b:b + BATCH]
            logits, iou = sam.decode(emb, (th, tw), p, np.ones(p.shape[:2], np.int64))
            logits, iou = logits.reshape(-1, *logits.shape[-2:]), iou.reshape(-1)
            stab = (logits > 1).sum((1, 2)).float() / (logits > -1).sum((1, 2)).clamp(min=1).float()
            ok = (iou >= PRED_IOU) & (stab >= STABILITY)
            keep_logits.append(logits[ok].half().cpu())
            keep_iou.append(iou[ok].cpu())
            keep_stab.append(stab[ok].cpu())
        logits = torch.cat(keep_logits)
        iou = torch.cat(keep_iou)
        stab = torch.cat(keep_stab)
        # full-size masks (cropped to their boxes at once), NMS inside the tile
        boxes, crops = [], []
        for b in range(0, len(logits), 16):
            m = sam.upsample(logits[b:b + 16].to(sam.dev), (th, tw))
            for mm in m:
                ys = torch.nonzero(mm.any(1)).flatten()
                xs = torch.nonzero(mm.any(0)).flatten()
                if len(ys) == 0:
                    boxes.append([0, 0, 0, 0])
                    crops.append(None)
                else:
                    bb = [int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1]
                    boxes.append(bb)
                    crops.append(mm[bb[1]:bb[3], bb[0]:bb[2]].cpu().numpy())
        if not boxes:
            continue
        boxes_t = torch.tensor(boxes, dtype=torch.float32)
        keep = nms(boxes_t, iou.float(), BOX_NMS).tolist()
        n_tile = 0
        for k in keep:
            bx0, by0, bx1, by1 = boxes[k]
            if crops[k] is None:
                continue
            if level > 0:
                inner = ((bx0 <= EDGE_PX and x0 > 0) or (by0 <= EDGE_PX and y0 > 0)
                         or (bx1 >= tw - EDGE_PX and x1 < W) or (by1 >= th - EDGE_PX and y1 < H))
                if inner:
                    continue
            crop = crops[k]
            found.append((t, level, float(iou[k]), float(stab[k]),
                          [bx0 + x0, by0 + y0, bx1 + x0, by1 + y0], crop))
            n_tile += 1
        print(f"tile {t:2d} level {level} [{x0},{y0},{x1},{y1}]: {len(logits)} candidates, {n_tile} kept")
        torch.cuda.empty_cache()

    # duplicates across tiles: prefer the finer tile, then the better score
    boxes_t = torch.tensor([f[4] for f in found], dtype=torch.float32)
    pref = torch.tensor([f[1] + 0.5 * f[2] for f in found], dtype=torch.float32)
    keep = nms(boxes_t, pref, BOX_NMS).tolist()
    out = []
    for k in keep:
        t, level, iou, stab, bb, crop = found[k]
        m = clean(crop)
        if m.sum() < MIN_PX:
            continue
        sub_bb, sub = to_crop(m)
        bb = [bb[0] + sub_bb[0], bb[1] + sub_bb[1], bb[0] + sub_bb[2], bb[1] + sub_bb[3]]
        out.append((bb, sub, iou, stab, t))
    out.sort(key=lambda o: -int(o[1].sum()))
    print(f"{len(found)} tile masks -> {len(out)} after cross-tile NMS and cleaning")
    return out


def prompt_mask(sam, key, prompt):
    """One mask from a prompt {points, neg, box, pick} or {rect} in 0..1 coordinates."""
    H, W = key.shape[:2]
    if prompt.get("rect"):
        x0, y0, x1, y1 = np.round(np.asarray(prompt["rect"], float) * [W, H, W, H]).astype(int)
        m = np.zeros((H, W), bool)
        m[max(y0, 0):min(y1, H), max(x0, 0):min(x1, W)] = True
        bb, crop = to_crop(m)
        return bb, crop, 1.0, (x0, y0, x1, y1)
    pos = np.asarray(prompt.get("points", []), float).reshape(-1, 2) * [W, H]
    neg = np.asarray(prompt.get("neg", []), float).reshape(-1, 2) * [W, H]
    box = np.asarray(prompt["box"], float) * [W, H, W, H] if prompt.get("box") else None
    pts = np.concatenate([pos, neg]) if len(pos) + len(neg) else None
    # window: the prompt's extent plus a margin, at least 320 px, so SAM sees it near native size
    ext = np.concatenate([a for a in (pos, neg, None if box is None else box.reshape(2, 2)) if a is not None])
    lo, hi = ext.min(0), ext.max(0)
    size = np.maximum((hi - lo) * 1.6, 320)
    c = (lo + hi) / 2
    x0, y0 = np.maximum(np.round(c - size / 2), 0).astype(int)
    x1, y1 = np.minimum(np.round(c + size / 2), [W, H]).astype(int)
    emb = sam.embed(key[y0:y1, x0:x1])
    off = np.array([x0, y0])
    multimask = box is None and len(pos) + len(neg) == 1
    logits, iou = sam.decode(
        emb, (y1 - y0, x1 - x0),
        points=None if pts is None else (pts - off)[None],
        labels=None if pts is None else np.array([[1] * len(pos) + [0] * len(neg)]),
        boxes=None if box is None else (box - [x0, y0, x0, y0])[None],
        multimask=multimask)
    logits, iou = logits[0], iou[0]
    masks = sam.upsample(logits, (y1 - y0, x1 - x0)).cpu().numpy()
    if "pick" in prompt and prompt["pick"] is not None and multimask:
        order = np.argsort([m.sum() for m in masks])
        k = int(order[int(prompt["pick"])])
    else:
        k = int(np.argmax(iou.cpu().numpy()))
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = clean(masks[k])
    if not m.any():
        raise SystemExit(f"empty mask for prompt {prompt}")
    bb, crop = to_crop(m)
    return bb, crop, float(iou[k]), (x0, y0, x1, y1)


# ------------------------------------------------------------------ sheets

def _font(size):
    for f in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


def colour(i):
    h = (i * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(h, 0.85, 1.0)
    return int(r * 255), int(g * 255), int(b * 255)


def pole(m):
    """A point well inside the mask (maximum of the distance to its edge)."""
    d = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
    y, x = np.unravel_index(np.argmax(d), d.shape)
    return x, y


def draw_sheet(key, items, view, scale, path, font_px=14):
    """items: (number, bbox, crop); view: x0, y0, x1, y1 in image pixels."""
    vx0, vy0, vx1, vy1 = view
    base = key[vy0:vy1, vx0:vx1].astype(np.float32) * 0.55
    over = base.copy()
    edge_layer = np.zeros(base.shape[:2], bool)
    edge_rgb = np.zeros_like(base)
    for num, bb, crop in items:
        x0, y0, x1, y1 = bb
        cx0, cy0, cx1, cy1 = max(x0, vx0), max(y0, vy0), min(x1, vx1), min(y1, vy1)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        sub = crop[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        col = np.array(colour(num), np.float32)
        tgt = over[cy0 - vy0:cy1 - vy0, cx0 - vx0:cx1 - vx0]
        tgt[sub] = tgt[sub] * 0.6 + col * 0.4
        edge = sub & ~ndimage.binary_erosion(sub, border_value=0)
        e_t = edge_layer[cy0 - vy0:cy1 - vy0, cx0 - vx0:cx1 - vx0]
        e_t |= edge
        edge_rgb[cy0 - vy0:cy1 - vy0, cx0 - vx0:cx1 - vx0][edge] = col
    over[edge_layer] = edge_rgb[edge_layer]
    im = Image.fromarray(np.clip(over, 0, 255).astype(np.uint8))
    if scale != 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)),
                       Image.NEAREST if scale > 1 else Image.LANCZOS)
    dr = ImageDraw.Draw(im)
    font = _font(font_px)
    for num, bb, crop in items:
        px, py = pole(crop)
        px, py = px + bb[0], py + bb[1]
        if not (vx0 <= px < vx1 and vy0 <= py < vy1):
            continue
        dr.text(((px - vx0) * scale, (py - vy0) * scale), str(num), font=font, fill=colour(num),
                anchor="mm", stroke_width=3, stroke_fill=(0, 0, 0))
    im.save(path)


def make_sheets(key, bbox, crops):
    H, W = key.shape[:2]
    area = np.array([c.sum() for c in crops]) / (H * W)
    centre = np.array([((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for b in bbox])
    items = [(i, bbox[i], crops[i]) for i in range(len(crops))]
    os.makedirs(WORK, exist_ok=True)
    for f in os.listdir(WORK):
        if f.startswith("masks_sheet_") and f.endswith(".png"):
            os.remove(os.path.join(WORK, f))
    draw_sheet(key, [it for it in items if area[it[0]] >= LARGE], (0, 0, W, H), 0.5,
               os.path.join(WORK, "masks_sheet_L.png"), 18)
    hw, hh = W // 2, H // 2
    for q, (qx, qy) in enumerate(((0, 0), (hw, 0), (0, hh), (hw, hh))):
        view = (qx, qy, qx + hw, qy + hh)
        sel = [it for it in items if SMALL <= area[it[0]] < LARGE
               and qx <= centre[it[0]][0] < qx + hw and qy <= centre[it[0]][1] < qy + hh]
        draw_sheet(key, sel, view, 1.0, os.path.join(WORK, f"masks_sheet_M_{q}.png"), 16)
    tw, th = W // 3, H // 2
    for r in range(2):
        for c in range(3):
            view = (c * tw, r * th, (c + 1) * tw if c < 2 else W, (r + 1) * th if r < 1 else H)
            sel = [it for it in items if area[it[0]] < SMALL
                   and view[0] <= centre[it[0]][0] < view[2] and view[1] <= centre[it[0]][1] < view[3]]
            draw_sheet(key, sel, view, 1.5, os.path.join(WORK, f"masks_sheet_S_{r}{c}.png"), 15)


def draw_prompt_sheet(key, items, notes=None):
    """Each prompt mask in its own panel (a window around it, up to 2x), 12 panels per
    sheet: masks_sheet_P_0.png, _1, ..."""
    H, W = key.shape[:2]
    os.makedirs(WORK, exist_ok=True)
    for f in os.listdir(WORK):
        if f.startswith("masks_sheet_P") and f.endswith(".png"):
            os.remove(os.path.join(WORK, f))
    font = _font(15)
    panels = []
    for num, bb, crop in items:
        x0, y0, x1, y1 = bb
        m = max(x1 - x0, y1 - y0) * 0.4 + 20
        view = (int(max(x0 - m, 0)), int(max(y0 - m, 0)), int(min(x1 + m, W)), int(min(y1 + m, H)))
        tmp = os.path.join(WORK, "_panel.png")
        s = min(2.0, 460 / max(view[2] - view[0], view[3] - view[1]))
        draw_sheet(key, [(num, bb, crop)], view, s, tmp, 18)
        p = Image.open(tmp).copy()
        os.remove(tmp)
        ImageDraw.Draw(p).text((4, 4), f"{num} {(notes or {}).get(num, '')}", font=font,
                               fill=(255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0))
        panels.append(p)
    cols, per = 4, 12
    for page in range(0, len(panels), per):
        chunk = panels[page:page + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * 470, rows * 470), (30, 30, 30))
        for k, p in enumerate(chunk):
            sheet.paste(p, ((k % cols) * 470, (k // cols) * 470))
        sheet.save(os.path.join(WORK, f"masks_sheet_P_{page // per}.png"))


# ------------------------------------------------------------------ main

def parse_xy(s):
    return [[float(v) for v in p.split(",")] for p in s.split(";") if p.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--points", help='positive points "x,y;x,y" (0..1)')
    ap.add_argument("--neg", help='negative points "x,y;x,y" (0..1)')
    ap.add_argument("--box", help="box x0,y0,x1,y1 (0..1)")
    ap.add_argument("--rect", help="rectangle x0,y0,x1,y1 (0..1), no model")
    ap.add_argument("--pick", type=int, help="with one point: 0 = smallest of SAM's three masks .. 2 = largest")
    ap.add_argument("--note", default="", help="what the prompt is meant to cut (stored with it)")
    ap.add_argument("--batch", help="JSON list of prompts")
    ap.add_argument("--sheets", action="store_true", help="only redraw the sheets")
    ap.add_argument("--show", help='panels for existing masks "3,17,240"')
    ap.add_argument("--masks", default=MASKS, help="masks file (default data/masks.npz)")
    args = ap.parse_args()

    key = np.asarray(Image.open(KEY).convert("RGB"))
    H, W = key.shape[:2]
    os.makedirs(WORK, exist_ok=True)

    prompts = []
    if args.batch:
        with open(args.batch, encoding="utf-8") as f:
            prompts = json.load(f)
    elif args.rect:
        prompts = [{"note": args.note, "rect": [float(v) for v in args.rect.split(",")]}]
    elif args.points or args.box:
        p = {"note": args.note}
        if args.points:
            p["points"] = parse_xy(args.points)
        if args.neg:
            p["neg"] = parse_xy(args.neg)
        if args.box:
            p["box"] = [float(v) for v in args.box.split(",")]
        if args.pick is not None:
            p["pick"] = args.pick
        prompts = [p]

    if args.show:
        bbox, crops, meta = load_masks(args.masks)
        ids = [int(v) for v in args.show.split(",")]
        notes = {i: meta["prompts"].get(str(i), {}).get("note", "") for i in ids}
        draw_prompt_sheet(key, [(i, bbox[i], crops[i]) for i in ids], notes)
        print("panels in masks_sheet_P_*.png")
        return

    if args.sheets:
        bbox, crops, meta = load_masks(args.masks)
        make_sheets(key, bbox, crops)
        print(f"sheets redrawn for {len(crops)} masks")
        return

    if prompts:
        # append to an existing masks file, and record the prompts in data/regions_prompts.json
        bbox, crops, meta = load_masks(args.masks)
        bbox, score, source = list(map(list, bbox)), list(map(list, meta["score"])), list(meta["source"])
        auto, recorded = load_prompts()
        n_auto = sum(1 for s in source if s >= 0)
        if (auto is not None and auto != n_auto) or len(crops) != n_auto + len(recorded):
            raise SystemExit(f"{os.path.relpath(args.masks, ROOT)} ({len(crops)} masks, {n_auto} automatic) "
                             f"is out of step with data/regions_prompts.json ({len(recorded)} prompts); "
                             "rebuild it with segment.py without options first")
        sam = Sam() if any(not p.get("rect") for p in prompts) else None
        new = []
        for p in prompts:
            bb, crop, iou, win = prompt_mask(sam, key, p)
            i = len(crops)
            bbox.append(bb)
            crops.append(crop)
            score.append([iou, 0.0])
            source.append(-1)
            meta["prompts"][str(i)] = p
            recorded.append({"mask": i, **p})
            new.append(i)
            print(f"mask {i}: {int(crop.sum())} px, bbox {bb}, iou {iou:.3f}  {p.get('note', '')}")
        save_masks(bbox, crops, score, source, meta["prompts"], (H, W), path=args.masks)
        save_prompts(n_auto, recorded)
        draw_prompt_sheet(key, [(i, bbox[i], crops[i]) for i in new],
                          {i: meta["prompts"][str(i)].get("note", "") for i in new})
        print(f"{len(crops)} masks in {os.path.relpath(args.masks, ROOT)}, {len(recorded)} prompts in "
              f"{os.path.relpath(PROMPTS, ROOT)}; panels in masks_sheet_P_*.png")
        return

    # build from scratch: automatic masks, then the recorded prompts in order
    sam = Sam()
    out = auto_masks(sam, key)
    bbox, crops = [o[0] for o in out], [o[1] for o in out]
    score, source = [[o[2], o[3]] for o in out], [o[4] for o in out]
    auto, recorded = load_prompts()
    if recorded and auto != len(crops):
        raise SystemExit(f"the automatic pass gave {len(crops)} masks, data/regions_prompts.json "
                         f"expects {auto}: its mask numbers would not match the spec")
    stored = {}
    for p in recorded:
        bb, crop, iou, win = prompt_mask(sam, key, p)
        i = len(crops)
        if p["mask"] != i:
            raise SystemExit(f"data/regions_prompts.json: the prompt for mask {p['mask']} would become mask {i}")
        bbox.append(bb)
        crops.append(crop)
        score.append([iou, 0.0])
        source.append(-1)
        stored[str(i)] = {k: v for k, v in p.items() if k != "mask"}
    print(f"{len(recorded)} prompt masks from {os.path.relpath(PROMPTS, ROOT)}")
    save_masks(bbox, crops, score, source, stored, (H, W), path=args.masks)
    bbox, crops, meta = load_masks(args.masks)
    make_sheets(key, bbox, crops)
    print(f"{len(crops)} masks in {os.path.relpath(args.masks, ROOT)}")


if __name__ == "__main__":
    main()

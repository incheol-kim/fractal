"""Fidelity check for an upscaled image: shrink it back and compare with the original."""
import numpy as np
from scipy import sparse

TILE = 64
WORST = 12


def _area_matrix(n_out, n_in):
    """Sparse (n_out, n_in) matrix that area-averages n_in samples into n_out bins."""
    scale = n_in / n_out
    rows, cols, vals = [], [], []
    for i in range(n_out):
        a, b = i * scale, (i + 1) * scale
        for j in range(int(np.floor(a)), int(np.ceil(b))):
            w = min(b, j + 1) - max(a, j)
            if w > 1e-12:
                rows.append(i)
                cols.append(j)
                vals.append(w / scale)
    return sparse.csr_matrix((vals, (rows, cols)), shape=(n_out, n_in))


def area_resize(img, h, w):
    """Area-average an (H, W, C) image down to (h, w, C), returned as float64."""
    my = _area_matrix(h, img.shape[0])
    mx = _area_matrix(w, img.shape[1]).T.tocsr()
    src = img.astype(np.float64)
    return np.stack([(my @ src[:, :, c]) @ mx for c in range(src.shape[2])], axis=2)


def fidelity(orig, hires):
    """Compare `hires` (any size) with `orig` (H, W, 3) on the 0-255 scale.

    Returns mean absolute difference, the 99th percentile of 64x64 tile means
    and the 12 worst tiles as (x, y, mean) with x, y the tile's top-left corner
    in original pixels, worst first.
    """
    h, w = orig.shape[:2]
    small = area_resize(hires, h, w)
    diff = np.abs(small - orig.astype(np.float64)).mean(axis=2)

    tiles = []
    for y in range(0, h, TILE):
        for x in range(0, w, TILE):
            tiles.append((x, y, float(diff[y:y + TILE, x:x + TILE].mean())))
    means = np.array([m for _, _, m in tiles])
    worst = sorted(tiles, key=lambda t: -t[2])[:WORST]
    return {
        "mean": float(diff.mean()),
        "p99_tile": float(np.percentile(means, 99)),
        "worst": worst,
    }

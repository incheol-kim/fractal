"""Two stills of the page compared: are they the same picture?

  .venv/Scripts/python.exe tools/cmp_png.py <a.png> <b.png> [--over 3] [--share 0.0005] [--mean X] [--fit]

Two draws of the same frame are not byte for byte equal (4x MSAA edge pixels vary between draws
on this GPU), so "the same" means: few pixels differ by more than a little. A pixel is over when
its largest channel difference (RGB, 0..255) is above --over. PASS (exit 0) when the share of
pixels over is at most --share; with --mean X, PASS when the mean absolute difference over every
pixel and channel is at most X instead. Otherwise FAIL (exit 1). Prints one line:

  over 3: N px (share S), max D, mean M  PASS (share <= 0.0005)

The two must be the same size (exit 2 otherwise) unless --fit, which area-averages a to b's size
first (a 4K still against a 1080p one). No colour conversion: the files' values as they are.
"""
import argparse
import sys

import numpy as np
from PIL import Image

from imgcheck import area_resize

OVER = 3
SHARE = 0.0005


def load(path):
    """A PNG -> (H, W, 3) uint8 RGB."""
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"))


def fit(a, shape):
    """a area-averaged to shape (h, w), as float64."""
    return area_resize(a, shape[0], shape[1])


def compare(a, b, over=OVER):
    """Two (H, W, C) pictures of one size -> dict(n_over, share, max, mean).

    n_over: pixels whose largest channel difference is above `over`; share: n_over over all
    pixels; max: the largest channel difference; mean: the mean absolute difference over every
    pixel and channel (0..255).
    """
    if a.shape != b.shape:
        raise ValueError(f"sizes differ: {a.shape} and {b.shape}")
    d = np.abs(a.astype(np.float64) - b.astype(np.float64))
    m = d.max(axis=2)
    n_over = int(np.count_nonzero(m > over))
    return dict(n_over=n_over, share=n_over / m.size, max=float(m.max()), mean=float(d.mean()))


def _num(x):
    return str(int(x)) if float(x).is_integer() else f"{x:.2f}"


def main(argv=None):
    p = argparse.ArgumentParser(description="Compare two stills (see the module docstring).")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--over", type=float, default=OVER, help="a pixel is over when a channel differs by more (0..255)")
    p.add_argument("--share", type=float, default=SHARE, help="PASS when at most this share of pixels is over")
    p.add_argument("--mean", type=float, default=None, help="PASS when the mean absolute difference is at most this instead")
    p.add_argument("--fit", action="store_true", help="area-average a to b's size first")
    args = p.parse_args(argv)

    a = load(args.a)
    b = load(args.b)
    if a.shape != b.shape:
        if not args.fit:
            print(f"sizes differ: {args.a} is {a.shape[1]}x{a.shape[0]}, {args.b} is {b.shape[1]}x{b.shape[0]} (--fit area-averages a to b's size)", file=sys.stderr)
            return 2
        a = fit(a, b.shape[:2])

    r = compare(a, b, args.over)
    if args.mean is not None:
        ok = r["mean"] <= args.mean
        rule = f"mean <= {args.mean:g}"
    else:
        ok = r["share"] <= args.share
        rule = f"share <= {args.share:g}"
    print(
        f"over {args.over:g}: {r['n_over']} px (share {r['share']:.6f}), max {_num(r['max'])}, mean {r['mean']:.4f}"
        f"  {'PASS' if ok else 'FAIL'} ({rule})"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

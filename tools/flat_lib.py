"""Pure helpers for the flat-colour stage: ink choice and tone in Lab space."""
import numpy as np
from skimage.color import rgb2lab


def _lab(rgb):
    a = np.asarray(rgb, dtype=np.float64).reshape(1, 1, 3) / 255.0
    return rgb2lab(a)[0, 0]


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def nearest_ink(rgb, inks):
    """Index of the ink (list of RGB triples) closest to rgb in Lab."""
    lab = _lab(rgb)
    d = [float(np.sum((lab - _lab(i)) ** 2)) for i in inks]
    return int(np.argmin(d))


def tone(rgb, ink_rgb, paper_rgb):
    """0 = pure ink, 1 = paper: where rgb lies between them (Lab projection, clamped)."""
    c, a, b = _lab(rgb), _lab(ink_rgb), _lab(paper_rgb)
    v = b - a
    den = float(v @ v)
    if den == 0:
        return 1.0
    return float(np.clip(((c - a) @ v) / den, 0.0, 1.0))


def is_coloured(rgb, sat_min=0.45):
    """True if the colour is clearly chromatic (HSV saturation >= sat_min)."""
    c = np.asarray(rgb, dtype=np.float64)
    return c.max() > 0 and (c.max() - c.min()) / c.max() >= sat_min


def choose_ink(rgb, inks, chroma_min=25.0):
    """Ink for a piece. Clearly coloured pieces pick the chromatic ink of nearest hue
    (shade is left to tone, so a shadowed blue wall stays cobalt instead of turning
    black); grey pieces pick by plain Lab distance."""
    if is_coloured(rgb):
        labs = [_lab(i) for i in inks]
        cand = [k for k, l in enumerate(labs) if np.hypot(l[1], l[2]) >= chroma_min]
        if cand:
            c = _lab(rgb)
            d = [float(np.sum((c[1:] - labs[k][1:]) ** 2)) for k in cand]
            return cand[int(np.argmin(d))]
    return nearest_ink(rgb, inks)


def _index(ink_name, ink_names):
    if ink_name not in ink_names:
        raise ValueError(f"unknown ink {ink_name!r}; the palette has {', '.join(ink_names)}")
    return ink_names.index(ink_name)


def forced_ink(leaf_name, hand, ink_names):
    """Ink index a leaf is given by hand (hand["ink_by_leaf"]), or None if it is not listed."""
    ink_name = hand.get("ink_by_leaf", {}).get(leaf_name)
    return None if ink_name is None else _index(ink_name, ink_names)


def auto_inks(hand, ink_names):
    """Indices of the inks the automatic choice may use: all but hand["hand_only"]."""
    skip = {_index(n, ink_names) for n in hand.get("hand_only", [])}
    return [k for k in range(len(ink_names)) if k not in skip]

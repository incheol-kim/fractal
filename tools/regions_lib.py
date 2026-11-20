"""Pure functions for the region map: partition, fill, split by tone, polygons, fingerprint.

Label maps are 2-D uint16 arrays; 0 means "unassigned", leaves are numbered from 1.
Polygon coordinates are 0..1 of the image (x across, y down).
"""
import hashlib
import heapq

import numpy as np
from scipy import ndimage

OUT = -1            # label of the pixels outside the image (in polygon tracing)
MERGE_DE = 8.0      # tone clusters closer than this (CIE76 delta E) become one tone
MAJORITY_PX = 4.0   # Gaussian sigma of the majority vote that smooths the tone map
SAMPLE = 60000      # pixels used to fit the tone clusters

# directions of boundary edges, clockwise on screen: east, south, west, north (dx, dy)
_DIRS = np.array([[1, 0], [0, 1], [-1, 0], [0, -1]])


def fingerprint(labels):
    """The region map's fingerprint: the first 16 hex digits of the sha256 of "<h>x<w>:" and
    the ids as little-endian uint16, row by row. assets/regions.json carries it as
    "fingerprint"; what is made from the map carries it as "regions" (src/consistency.js)."""
    labels = np.asarray(labels)
    h, w = labels.shape
    if labels.size and (labels.min() < 0 or labels.max() > np.iinfo(np.uint16).max):
        raise ValueError("label ids outside 0..65535")
    data = f"{h}x{w}:".encode() + labels.astype("<u2").tobytes()
    return hashlib.sha256(data).hexdigest()[:16]


def partition(masks, shape):
    """Stack boolean masks into one label map; a later mask covers an earlier one.

    Mask i (0-based) becomes label i + 1; pixels no mask covers stay 0.
    """
    if len(masks) > np.iinfo(np.uint16).max:
        raise ValueError("too many masks for a uint16 label map")
    labels = np.zeros(shape, np.uint16)
    for i, m in enumerate(masks, 1):
        labels[np.asarray(m, bool)] = i
    return labels


def drop_specks(labels, min_px):
    """Release (set to 0) what would make poor pieces: the parts of a leaf thinner than
    3 px (removed by a 3x3 opening) and every piece of a leaf, other than its largest, that
    is smaller than min_px. fill_unassigned then hands them to their surroundings. A leaf
    that is thinner than 3 px everywhere is left as it is.
    """
    out = labels.copy()
    h, w = labels.shape
    square = np.ones((3, 3), bool)
    for i, sl in enumerate(ndimage.find_objects(labels.astype(np.int32)), 1):
        if sl is None:
            continue
        y0, y1 = max(sl[0].start - 2, 0), min(sl[0].stop + 2, h)
        x0, x1 = max(sl[1].start - 2, 0), min(sl[1].stop + 2, w)
        m = labels[y0:y1, x0:x1] == i
        # replicate the image border so that it does not erode the leaf
        keep = ndimage.binary_opening(np.pad(m, 1, mode="edge"), square)[1:-1, 1:-1]
        cl, k = ndimage.label(keep)
        if k == 0:
            continue
        if k > 1:
            sizes = np.bincount(cl.ravel())
            sizes[0] = 0
            big = sizes >= min_px
            big[np.argmax(sizes)] = True
            big[0] = False
            keep = big[cl]
        out[y0:y1, x0:x1][m & ~keep] = 0
    return out


def fill_unassigned(labels):
    """Give every 0 pixel the label of the nearest assigned pixel."""
    zero = labels == 0
    if not zero.any():
        return labels.copy()
    if zero.all():
        raise ValueError("nothing assigned to grow from")
    iy, ix = ndimage.distance_transform_edt(zero, return_distances=False, return_indices=True)
    return labels[iy, ix]


# ---------------------------------------------------------------- split by tone

def _lab(rgb):
    """sRGB (0..255) -> CIE Lab (D65)."""
    c = np.asarray(rgb, np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = (lin @ m.T) / np.array([0.95047, 1.0, 1.08883])
    e, k = 216 / 24389, 24389 / 27
    f = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def _nearest(x, centers):
    d = ((x[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
    return np.argmin(d, axis=1)


def _lloyd(x, centers, iters=40):
    for _ in range(iters):
        near = _nearest(x, centers)
        new = np.array([x[near == j].mean(0) for j in range(len(centers)) if (near == j).any()])
        if new.shape == centers.shape and np.allclose(new, centers, atol=1e-3):
            return new
        centers = new
    return centers


def _tone_centers(x, max_tones, rng):
    """k-means++ / Lloyd with k = max_tones, then merge centres closer than MERGE_DE."""
    centers = [x[rng.integers(len(x))]]
    d2 = ((x - centers[0]) ** 2).sum(1)
    for _ in range(1, max_tones):
        if d2.sum() <= 1e-9:
            break
        centers.append(x[rng.choice(len(x), p=d2 / d2.sum())])
        d2 = np.minimum(d2, ((x - centers[-1]) ** 2).sum(1))
    centers = _lloyd(x, np.array(centers))
    while len(centers) > 1:
        d = np.sqrt(((centers[:, None] - centers[None]) ** 2).sum(-1))
        d[np.diag_indices(len(centers))] = np.inf
        i, j = np.unravel_index(np.argmin(d), d.shape)
        if d[i, j] >= MERGE_DE:
            break
        near = _nearest(x, centers)
        ni, nj = (near == i).sum(), (near == j).sum()
        merged = (centers[i] * ni + centers[j] * nj) / max(ni + nj, 1)
        keep = [c for k, c in enumerate(centers) if k not in (i, j)]
        centers = _lloyd(x, np.array(keep + [merged]))
    return centers


def _merge_small(comp, n, min_px):
    """Merge components smaller than min_px into the neighbour they share most border with.

    comp: int array, 0 = outside the leaf, 1..n = components. Changed in place.
    A small component without any neighbour inside the leaf is left alone.
    """
    sizes = np.bincount(comp.ravel(), minlength=n + 1).astype(np.int64)
    boxes = [None] + list(ndimage.find_objects(comp, max_label=n))
    heap = [(int(sizes[i]), i) for i in range(1, n + 1) if 0 < sizes[i] < min_px]
    heapq.heapify(heap)
    h, w = comp.shape
    while heap:
        size, i = heapq.heappop(heap)
        if sizes[i] != size:          # stale entry: it grew (or vanished) since it was pushed
            if 0 < sizes[i] < min_px:
                heapq.heappush(heap, (int(sizes[i]), i))
            continue
        ys, xs = boxes[i]
        sl = (slice(max(ys.start - 1, 0), min(ys.stop + 1, h)),
              slice(max(xs.start - 1, 0), min(xs.stop + 1, w)))
        sub = comp[sl]
        me = sub == i
        ring = ndimage.binary_dilation(me) & ~me & (sub > 0)
        if not ring.any():
            continue
        ids, counts = np.unique(sub[ring], return_counts=True)
        j = int(ids[np.argmax(counts)])
        sub[me] = j
        sizes[j] += sizes[i]
        sizes[i] = 0
        bj = boxes[j]
        boxes[j] = (slice(min(bj[0].start, ys.start), max(bj[0].stop, ys.stop)),
                    slice(min(bj[1].start, xs.start), max(bj[1].stop, xs.stop)))
        if sizes[j] < min_px:
            heapq.heappush(heap, (int(sizes[j]), j))
    return sizes


def split_by_tone(labels, image, leaf_id, max_tones=4, min_area=0.0015):
    """Split one leaf into light/shade pieces by clustering its colours in Lab.

    Up to max_tones colour clusters (clusters closer than MERGE_DE merge), a smoothed
    majority vote turns them into a tone map, and every connected piece of that map
    smaller than min_area (fraction of the whole image) joins the neighbouring piece it
    shares most border with. The largest piece keeps leaf_id; the others get new ids
    after the current maximum, largest first.
    """
    out = labels.copy()
    full = labels == leaf_id
    if not full.any():
        return out
    ys, xs = np.nonzero(full)
    sl = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    m = full[sl]
    lab = _lab(image[sl])
    x = lab[m]

    rng = np.random.default_rng(0)
    sample = x if len(x) <= SAMPLE else x[rng.choice(len(x), SAMPLE, replace=False)]
    centers = _tone_centers(sample, max_tones, rng)
    if len(centers) < 2:
        return out

    tone = np.full(m.shape, -1, np.int64)
    tone[m] = _nearest(x, centers)
    votes = np.stack([ndimage.gaussian_filter((tone == t).astype(np.float32), MAJORITY_PX)
                      for t in range(len(centers))])
    tone = np.where(m, np.argmax(votes, axis=0), -1)

    comp = np.zeros(m.shape, np.int32)
    n = 0
    for t in range(len(centers)):
        cl, k = ndimage.label(tone == t)
        comp[cl > 0] = cl[cl > 0] + n
        n += k
    min_px = min_area * labels.size
    sizes = _merge_small(comp, n, min_px)

    alive = [i for i in range(1, n + 1) if sizes[i] > 0]
    big = [i for i in alive if sizes[i] >= min_px]
    if len(big) < 2:
        return out
    flat = comp.ravel()
    first = {i: int(np.argmax(flat == i)) for i in big}    # first pixel, for stable ties
    big.sort(key=lambda i: (-sizes[i], first[i]))
    new_id = int(labels.max()) + 1
    if new_id + len(big) - 2 > np.iinfo(labels.dtype).max:
        raise ValueError("label map is full")
    region = out[sl]
    for k, i in enumerate(big[1:]):
        region[comp == i] = new_id + k
    # small isolated pieces (no neighbour inside the leaf) stay with leaf_id
    return out


# ---------------------------------------------------------------- polygons

def _window(labels, y0, y1, x0, x1):
    """labels[y0:y1, x0:x1] as int64, with OUT where the window leaves the image."""
    h, w = labels.shape
    win = np.full((y1 - y0, x1 - x0), OUT, np.int64)
    sy0, sy1, sx0, sx1 = max(y0, 0), min(y1, h), max(x0, 0), min(x1, w)
    win[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = labels[sy0:sy1, sx0:sx1]
    return win


def _seg_dist(q, a, b):
    ab = b - a
    l2 = float(ab @ ab)
    if l2 == 0.0:
        return np.hypot(q[:, 0] - a[0], q[:, 1] - a[1])
    t = np.clip(((q - a) @ ab) / l2, 0.0, 1.0)
    p = a + t[:, None] * ab
    return np.hypot(q[:, 0] - p[:, 0], q[:, 1] - p[:, 1])


def _douglas_peucker(p, tol):
    n = len(p)
    if n <= 2 or tol <= 0:
        return p
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        d = _seg_dist(p[a + 1:b], p[a], p[b])
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack.append((a, k))
            stack.append((k, b))
    return p[keep]


def _simplify_chain(chain, tol):
    """Douglas-Peucker in a canonical direction, so two neighbours get the same result.

    A loop (first point == last point) is first cut at its point farthest from the start
    (ties: smallest x, then y), which is the same from either side.
    """
    if len(chain) > 3 and np.array_equal(chain[0], chain[-1]):
        d2 = ((chain - chain[0]) ** 2).sum(1)
        far = np.nonzero(d2 == d2.max())[0]
        k = far[np.lexsort((chain[far, 1], chain[far, 0]))[0]]
        return np.concatenate([_simplify_chain(chain[:k + 1], tol)[:-1],
                               _simplify_chain(chain[k:], tol)])
    if tuple(chain[0]) > tuple(chain[-1]):
        return _douglas_peucker(chain[::-1], tol)[::-1]
    return _douglas_peucker(chain, tol)


def _split_points(pts, brk):
    """Indices where a ring is cut into chains: its break vertices, or, for a ring without
    any, its extreme points (chosen from the point set alone, the same from either side)."""
    bi = np.nonzero(brk)[0]
    if len(bi):
        return bi
    x, y = pts[:, 0], pts[:, 1]
    picks = {np.lexsort((y, x))[0], np.lexsort((y, -x))[0],
             np.lexsort((x, y))[0], np.lexsort((x, -y))[0]}
    return np.sort(np.array(sorted(picks)))


def _trace_rings(m):
    """Boundary rings of a boolean mask (with a one-pixel empty border) on the pixel-corner grid.

    Every directed edge has the mask on its right (screen, y down), so outer rings run
    clockwise and holes counter-clockwise. Diagonal-only contacts are kept apart (the walk
    turns right). Returns (start vertices (n, 2) as (x, y), directions (n,), rings as index arrays).
    """
    up = np.zeros_like(m)
    up[1:] = m[:-1]
    down = np.zeros_like(m)
    down[:-1] = m[1:]
    left = np.zeros_like(m)
    left[:, 1:] = m[:, :-1]
    right = np.zeros_like(m)
    right[:, :-1] = m[:, 1:]
    parts = []
    for d, side, (ox, oy) in ((0, ~up, (0, 0)), (1, ~right, (1, 0)),
                              (2, ~down, (1, 1)), (3, ~left, (0, 1))):
        r, c = np.nonzero(m & side)
        parts.append((np.stack([c + ox, r + oy], 1), np.full(len(r), d)))
    s = np.concatenate([p[0] for p in parts])
    d = np.concatenate([p[1] for p in parts])
    e = s + _DIRS[d]
    vw = m.shape[1] + 1
    skey = s[:, 1] * vw + s[:, 0]
    ekey = e[:, 1] * vw + e[:, 0]
    order = np.argsort(skey, kind="stable")
    sk = skey[order]
    lo = np.searchsorted(sk, ekey, "left")
    hi = np.searchsorted(sk, ekey, "right")
    nxt = order[np.minimum(lo, len(order) - 1)]
    amb = np.nonzero(hi - lo == 2)[0]
    if len(amb):
        a, b = order[lo[amb]], order[lo[amb] + 1]
        nxt[amb] = np.where(d[a] == (d[amb] + 1) % 4, a, b)

    seen = np.zeros(len(s), bool)
    rings = []
    nxt_l = nxt.tolist()
    for i0 in range(len(s)):
        if seen[i0]:
            continue
        ring = []
        i = i0
        while not seen[i]:
            seen[i] = True
            ring.append(i)
            i = nxt_l[i]
        rings.append(np.array(ring))
    return s, d, rings


def _ring_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def to_polys(labels, leaf_id, tol_px=1.0):
    """Polygons of one leaf: a list of rings, each a list of [x, y] in 0..1.

    Outer rings run clockwise on screen (y down), holes counter-clockwise; an island of
    the leaf inside one of its holes is another outer ring. The rings follow the pixel
    boundary through the middle of each boundary pixel edge (so staircases become
    straight lines), keep the true corner between two straight runs, and pass exactly
    through every corner where three or more leaves (or the image border) meet. Each
    stretch between such meeting corners is simplified with
    Douglas-Peucker (tol_px, in pixels) in a fixed direction, so neighbouring leaves get
    identical shared boundaries and tile the image without gaps.
    """
    hgt, wid = labels.shape
    ys, xs = np.nonzero(labels == leaf_id)
    if ys.size == 0:
        return []
    y0, x0 = int(ys.min()) - 1, int(xs.min()) - 1
    win = _window(labels, y0, int(ys.max()) + 2, x0, int(xs.max()) + 2)
    s, d, rings = _trace_rings(win == leaf_id)

    polys = []
    for ring in rings:
        sv = s[ring]
        vx, vy = sv[:, 0], sv[:, 1]
        tl, tr = win[vy - 1, vx - 1], win[vy - 1, vx]
        bl, br = win[vy, vx - 1], win[vy, vx]
        distinct = 1 + (tr != tl) + ((bl != tl) & (bl != tr)) + ((br != tl) & (br != tr) & (br != bl))
        diag = (tl == br) & (tr == bl) & (tl != tr)
        gx, gy = vx + x0, vy + y0
        corner = ((gx == 0) | (gx == wid)) & ((gy == 0) | (gy == hgt))
        brk = (distinct >= 3) | diag | corner
        # a real corner (both straight runs at least two edges, not crossing a break) is kept;
        # single steps of a staircase are cut through their edge midpoints
        dd = d[ring]
        turn = dd != np.roll(dd, 1)
        long_before = (np.roll(dd, 1) == np.roll(dd, 2)) & ~np.roll(brk, 1)
        long_after = (dd == np.roll(dd, -1)) & ~np.roll(brk, -1)
        emit = brk | (turn & long_before & long_after)

        k = len(ring)
        pos = np.arange(k) + np.cumsum(emit) - emit
        pts = np.empty((k + int(emit.sum()), 2))
        is_brk = np.zeros(len(pts), bool)
        pts[pos[emit]] = sv[emit]
        is_brk[pos[brk]] = True
        pts[pos + emit] = sv + 0.5 * _DIRS[dd]
        pts += (x0, y0)

        cuts = _split_points(pts, is_brk)
        out = []
        for j in range(len(cuts)):
            a, b = cuts[j], cuts[(j + 1) % len(cuts)]
            chain = pts[a:b + 1] if b > a else np.concatenate([pts[a:], pts[:b + 1]])
            out.append(_simplify_chain(chain, tol_px)[:-1])
        simple = np.concatenate(out)
        # a ring thinner than the tolerance collapses to a line: it is dropped, and the
        # neighbours (simplified the same way) meet along that line
        if len(simple) < 3 or abs(_ring_area(simple)) < 1e-9:
            continue
        polys.append((simple / (wid, hgt)).tolist())
    return polys

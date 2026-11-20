"""Pure functions for the line material: strokes from region rings, wire polylines from a
mask, overshooting pencil ends, and the parent/child generations of the strokes.

A stroke's points are [x, y] pairs. The functions assume one isotropic unit for x and y
(tools/make_strokes.py passes x and y both divided by the image width, so that lengths and
angles are true); trace_wires works in the mask's pixels (x = column, y = row, pixel
centres at +0.5).
"""
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize


# ---------------------------------------------------------------- small geometry

def polyline_length(pts):
    p = np.asarray(pts, float)
    if len(p) < 2:
        return 0.0
    return float(np.hypot(*np.diff(p, axis=0).T).sum())


def midpoint(pts):
    """The point halfway along the polyline (by arc length)."""
    p = np.asarray(pts, float)
    if len(p) == 1:
        return p[0].copy()
    seg = np.hypot(*np.diff(p, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    half = cum[-1] / 2
    i = min(int(np.searchsorted(cum, half, "right")) - 1, len(seg) - 1)
    t = 0.0 if seg[i] == 0 else (half - cum[i]) / seg[i]
    return p[i] + t * (p[i + 1] - p[i])


def seg_dist(q, a, b):
    """Distances of the points q (n, 2) to the segment ab."""
    ab = b - a
    l2 = float(ab @ ab)
    if l2 == 0.0:
        return np.hypot(*(q - a).T)
    t = np.clip(((q - a) @ ab) / l2, 0.0, 1.0)
    return np.hypot(*(q - (a + t[:, None] * ab)).T)


def simplify(pts, tol):
    """Douglas-Peucker; keeps the first and last point."""
    p = np.asarray(pts, float)
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
        d = seg_dist(p[a + 1:b], p[a], p[b])
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return p[keep]


def _turn_deg(p):
    """Turning angle (degrees) at the interior points of an open chain."""
    a = np.diff(p, axis=0)
    a1, a2 = a[:-1], a[1:]
    cross = a1[:, 0] * a2[:, 1] - a1[:, 1] * a2[:, 0]
    dot = (a1 * a2).sum(1)
    return np.degrees(np.abs(np.arctan2(cross, dot)))


def _clip_t(a, b, box):
    """Liang-Barsky: the parameter range [t0, t1] of segment ab inside the box, or None."""
    x0, y0, x1, y1 = box
    d = b - a
    t0, t1 = 0.0, 1.0
    for p, q in ((-d[0], a[0] - x0), (d[0], x1 - a[0]), (-d[1], a[1] - y0), (d[1], y1 - a[1])):
        if p == 0:
            if q < 0:
                return None
        elif p < 0:
            t0 = max(t0, q / p)
        else:
            t1 = min(t1, q / p)
    return (t0, t1) if t0 <= t1 else None


def clip_polyline(pts, box):
    """The parts of a polyline inside box (x0, y0, x1, y1), as a list of polylines.

    Points inside are kept as they are; a segment that crosses the box's edge is cut where
    it crosses, on the segment itself (the new point is only pinned onto the edge against
    rounding), so a straight stroke stays straight. A polyline that leaves and comes back
    gives several pieces; one entirely outside gives none.
    """
    p = np.asarray(pts, float)
    lo, hi = np.array(box[:2], float), np.array(box[2:], float)
    pieces, cur = [], []
    for a, b in zip(p[:-1], p[1:]):
        t = _clip_t(a, b, box)
        if t is None:
            if cur:
                pieces.append(cur)
                cur = []
            continue
        t0, t1 = t
        ca = a if t0 == 0.0 else np.clip(a + t0 * (b - a), lo, hi)
        cb = b if t1 == 1.0 else np.clip(a + t1 * (b - a), lo, hi)
        if cur and t0 == 0.0:
            cur.append(cb)
        else:
            if cur:
                pieces.append(cur)
            cur = [ca, cb]
        if t1 < 1.0:
            pieces.append(cur)
            cur = []
    if cur:
        pieces.append(cur)
    return [np.asarray(q).tolist() for q in pieces if polyline_length(q) > 0]


# ---------------------------------------------------------------- strokes from rings

BORDER = -1        # boundary_runs: the stretch lies on the image border
UNMATCHED = -2     # boundary_runs: no other leaf has this stretch (reversed) in its rings


def boundary_runs(leaves):
    """Every ring of every leaf ({"id", "polys"}, 0..1 coordinates) cut into stretches along
    one neighbour: (leaf, neighbour, points, closed). The neighbour of a segment is the leaf
    whose ring has the same segment reversed (shared boundaries are identical on both
    sides); a segment without one is BORDER if it lies on the image's edge (x or y both 0 or
    both 1), else UNMATCHED. A ring along one neighbour only is one closed stretch. Shared
    stretches appear once from each side."""
    owner = {}
    rings = []
    for lf in leaves:
        for ring in lf["polys"]:
            pts = [tuple(p) for p in ring]
            rings.append((lf["id"], pts))
            for i in range(len(pts)):
                owner[(pts[i], pts[(i + 1) % len(pts)])] = lf["id"]

    def across(a, b):
        if (b, a) in owner:
            return owner[(b, a)]
        on_edge = (a[0] == b[0] and a[0] in (0.0, 1.0)) or (a[1] == b[1] and a[1] in (0.0, 1.0))
        return BORDER if on_edge else UNMATCHED

    runs = []
    for lid, pts in rings:
        n = len(pts)
        nb = [across(pts[i], pts[(i + 1) % n]) for i in range(n)]
        change = [i for i in range(n) if nb[i] != nb[i - 1]]
        if not change:
            runs.append((lid, nb[0], pts, True))
            continue
        s = change[0]
        pts, nb = pts[s:] + pts[:s], nb[s:] + nb[:s]
        start = 0
        for i in range(1, n + 1):
            if i == n or nb[i] != nb[start]:
                runs.append((lid, nb[start], pts[start:i + 1] if i < n else pts[start:] + pts[:1], False))
                start = i
    return runs


def split_at_corners(pts, corner_deg=35.0, closed=False, tol=0.0):
    """Cut a chain at the vertices where it turns by more than corner_deg.

    The chain is first simplified with Douglas-Peucker (tol, 0 = not at all). An open chain
    is cut at its interior corners. A closed ring (given without repeating its first point)
    without any corner comes back whole as one closed stroke (first point repeated at the
    end); otherwise it is cut into the pieces between consecutive corners.
    """
    p = np.asarray(pts, float)
    keep = np.ones(len(p), bool)
    keep[1:] = np.any(np.diff(p, axis=0) != 0, axis=1)      # drop repeated points
    p = p[keep]
    if closed:
        if len(p) > 1 and np.array_equal(p[0], p[-1]):
            p = p[:-1]
        if len(p) < 3:
            return []
        if tol > 0:
            # cut the ring at two far-apart points so that each half keeps its ends
            k = int(np.argmax(((p - p[0]) ** 2).sum(1)))
            p = np.concatenate([simplify(p[:k + 1], tol)[:-1], simplify(np.vstack([p[k:], p[:1]]), tol)[:-1]])
        ring = np.vstack([p[-1:], p, p[:1]])
        corners = np.nonzero(_turn_deg(ring) > corner_deg)[0]
        if len(corners) == 0:
            return [np.vstack([p, p[:1]]).tolist()]
        out = []
        for j, a in enumerate(corners):
            b = corners[(j + 1) % len(corners)]
            piece = p[a:b + 1] if b > a else np.vstack([p[a:], p[:b + 1]])
            out.append(piece.tolist())
        return out
    if len(p) < 2:
        return []
    if tol > 0:
        p = simplify(p, tol)
    if len(p) < 3:
        return [p.tolist()]
    cuts = [0] + (np.nonzero(_turn_deg(p) > corner_deg)[0] + 1).tolist() + [len(p) - 1]
    return [p[a:b + 1].tolist() for a, b in zip(cuts[:-1], cuts[1:])]


def rings_to_strokes(polys, corner_deg=35.0, tol=0.0):
    """Every ring of a polygon cut at its corners (see split_at_corners)."""
    out = []
    for ring in polys:
        out += split_at_corners(ring, corner_deg, closed=True, tol=tol)
    return out


def straighten(pts, tol=0.0015):
    """Two end points only, if no point is farther than tol from the chord; else unchanged."""
    p = np.asarray(pts, float)
    if len(p) <= 2 or np.array_equal(p[0], p[-1]):
        return pts
    if float(seg_dist(p, p[0], p[-1]).max()) <= tol:
        return [p[0].tolist(), p[-1].tolist()]
    return pts


def overshoot(pts, frac, seed):
    """A straight (two-point) stroke whose ends run past the original ends, as a pencil does.

    Each end goes out along the line by frac x length x k, with k drawn per end from
    uniform(0.5, 1.5) by a generator seeded with seed: frac is the mean overshoot, the same
    seed gives the same result. Strokes of more than two points come back unchanged.
    """
    if len(pts) != 2:
        return pts
    a, b = np.asarray(pts, float)
    d = b - a
    length = float(np.hypot(*d))
    if length == 0.0:
        return pts
    k = np.random.default_rng(seed).uniform(0.5, 1.5, 2)
    return [(a - d * frac * k[0]).tolist(), (b + d * frac * k[1]).tolist()]


def extend(pts, dist, span=0.0):
    """The polyline with a point added beyond each end, dist further along the direction of
    its last span of length (the end segment when span is 0)."""
    p = np.asarray(pts, float)
    if len(p) < 2 or dist == 0:
        return p.tolist()
    a = p[0] + _end_dir(p, span) * dist
    b = p[-1] + _end_dir(p[::-1], span) * dist
    return np.vstack([a, p, b]).tolist()


# ---------------------------------------------------------------- wires

_N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _neighbours(sk):
    """For every skeleton pixel, its neighbours under m-adjacency (a diagonal neighbour only
    counts when neither of the two pixels between them is on the skeleton), so staircases
    and corners do not look like junctions."""
    h, w = sk.shape
    pad = np.pad(sk, 1)
    ys, xs = np.nonzero(sk)
    nb = {}
    for y, x in zip(ys.tolist(), xs.tolist()):
        out = []
        for dy, dx in _N8:
            if not pad[y + 1 + dy, x + 1 + dx]:
                continue
            if dy and dx and (pad[y + 1 + dy, x + 1] or pad[y + 1, x + 1 + dx]):
                continue
            out.append((y + dy, x + dx))
        nb[(y, x)] = out
    return nb


def _chains(nb):
    """Split the skeleton graph into chains between nodes (pixels of degree != 2).

    Returns (chains, node_of): each chain is a list of pixels whose first and last pixel
    may be nodes; isolated loops come back as one chain that starts and ends on itself.
    """
    node = {p for p, q in nb.items() if len(q) != 2}
    seen_edge = set()
    chains = []
    for start in sorted(node):
        for q in nb[start]:
            if (start, q) in seen_edge:
                continue
            chain = [start, q]
            seen_edge.add((start, q))
            seen_edge.add((q, start))
            prev, cur = start, q
            while cur not in node:
                nxt = [r for r in nb[cur] if r != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                seen_edge.add((prev, cur))
                seen_edge.add((cur, prev))
                chain.append(cur)
                if cur == start:
                    break
            chains.append(chain)
    # loops without any node
    visited = {p for c in chains for p in c}
    for p in sorted(nb):
        if p in visited or len(nb[p]) != 2:
            continue
        chain = [p]
        prev, cur = p, nb[p][0]
        while cur != p:
            chain.append(cur)
            visited.add(cur)
            nxt = [r for r in nb[cur] if r != prev]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
        visited.add(p)
        chain.append(p)
        chains.append(chain)
    return chains, node


def _smooth_chain(p, sigma):
    if sigma <= 0 or len(p) < 5:
        return p
    q = np.stack([ndimage.gaussian_filter1d(p[:, k], sigma, mode="nearest") for k in (0, 1)], 1)
    q[0], q[-1] = p[0], p[-1]
    return q


def trace_wires(mask, spur=10, max_turn=35.0, tol=0.5, min_len=4.0, sigma=1.0):
    """Thin-line mask -> polylines through its skeleton, in pixel units (x, y).

    The skeleton is split into chains between end points and junctions. Junction pixels
    closer than a few pixels form one crossing; side branches shorter than spur pixels that
    end in the open are dropped. At every crossing the branches are paired, straightest pair
    first, when they turn by less than max_turn degrees, and paired branches are joined, so
    two wires that cross come back as two polylines. Each polyline is smoothed (Gaussian,
    sigma pixels along the chain), simplified (Douglas-Peucker, tol pixels) and kept if it is
    at least min_len pixels long.
    """
    sk = skeletonize(np.asarray(mask, bool))
    nb = _neighbours(sk)
    if not nb:
        return []
    for _ in range(3):                                    # prune short open spurs
        chains, node = _chains(nb)
        drop = []
        for c in chains:
            a, b = c[0], c[-1]
            open_a, open_b = len(nb[a]) <= 1, len(nb[b]) <= 1
            if len(c) - 1 < spur and (open_a != open_b) and (len(nb[a]) >= 3 or len(nb[b]) >= 3):
                drop.append(c)
        if not drop:
            break
        for c in drop:
            for p in (c if len(nb[c[0]]) <= 1 else c[::-1])[:-1]:   # keep the junction pixel
                for q in nb.pop(p, []):
                    if q in nb and p in nb[q]:
                        nb[q].remove(p)
    chains, node = _chains(nb)

    # crossings: groups of junction pixels joined by chains shorter than a few pixels
    junction = sorted(p for p in node if len(nb[p]) >= 3)
    jid = {p: i for i, p in enumerate(junction)}
    parent = list(range(len(junction)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    bridges = set()
    for ci, c in enumerate(chains):
        a, b = c[0], c[-1]
        if a in jid and b in jid and a != b and len(c) - 1 <= 6:
            parent[find(jid[a])] = find(jid[b])
            bridges.add(ci)
    cross_of = {p: find(jid[p]) for p in junction}

    # branch ends at crossings: (crossing, chain index, which end)
    ends = {}
    for ci, c in enumerate(chains):
        if ci in bridges:
            continue
        for e, p in ((0, c[0]), (1, c[-1])):
            if p in cross_of:
                ends.setdefault(cross_of[p], []).append((ci, e))

    def direction(ci, e):
        c = np.asarray(chains[ci], float)
        if e == 1:
            c = c[::-1]
        k = min(len(c) - 1, 10)
        v = c[k] - c[0]
        n = float(np.hypot(*v))
        return v / n if n else v

    link = {}                                             # (ci, e) -> (cj, f)
    for x in sorted(ends):
        br = ends[x]
        pairs = []
        for i in range(len(br)):
            for j in range(i + 1, len(br)):
                if br[i][0] == br[j][0]:
                    continue
                d = float(np.clip(-direction(*br[i]) @ direction(*br[j]), -1, 1))
                pairs.append((np.degrees(np.arccos(d)), i, j))
        used = set()
        for ang, i, j in sorted(pairs):
            if ang > max_turn or i in used or j in used:
                continue
            used |= {i, j}
            link[br[i]] = br[j]
            link[br[j]] = br[i]

    out = []
    for walk in _walks([i for i in range(len(chains)) if i not in bridges], link):
        path = []
        for ci, ent in walk:
            c = chains[ci] if ent == 0 else chains[ci][::-1]
            path.extend(c[1:] if path and path[-1] == c[0] else c)
        p = np.asarray(path, float)[:, ::-1] + 0.5       # (row, col) -> (x, y) pixel centres
        p = simplify(_smooth_chain(p, sigma), tol)
        if polyline_length(p) >= min_len:
            out.append(p.tolist())
    return out


def _walks(items, link):
    """Paths through pieces linked end to end. link maps (piece, end) -> (piece, end), ends
    being 0 (first point) and 1 (last point). Each path is a list of (piece, entry end)."""
    out = []
    done = set()
    for ci in items:
        if ci in done:
            continue
        cur, e = ci, 0                          # go back to a free end (or round a loop)
        seen = {ci}
        while (cur, e) in link:
            nj, f = link[(cur, e)]
            if nj in seen:
                break
            seen.add(nj)
            cur, e = nj, 1 - f
        walk = []
        visited = set()
        while True:
            visited.add(cur)
            walk.append((cur, e))
            nxt = link.get((cur, 1 - e))
            if nxt is None or nxt[0] in visited:
                break
            cur, e = nxt
        done |= visited
        out.append(walk)
    return out


def _end_dir(p, span):
    """Outward unit direction at the first point of p, seen from the point span along it."""
    seg = np.hypot(*np.diff(p, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    k = min(max(int(np.searchsorted(cum, span)), 1), len(p) - 1)
    v = p[0] - p[k]
    n = float(np.hypot(*v))
    return v / n if n else v


def _angle(u, v):
    nu, nv = float(np.hypot(*u)), float(np.hypot(*v))
    if nu == 0 or nv == 0:
        return 180.0
    return float(np.degrees(np.arccos(np.clip(u @ v / (nu * nv), -1, 1))))


def join_pieces(lines, max_gap, max_turn=20.0, span=10.0):
    """Join polylines end to end across gaps of up to max_gap when the two ends point at
    each other: the end directions (taken over span) and the gap itself all within max_turn
    degrees of one straight line. Best-matching ends join first; each end joins once."""
    P = [np.asarray(l, float) for l in lines]
    if len(P) < 2:
        return [p.tolist() for p in P]
    pos = np.array([p[0] if e == 0 else p[-1] for p in P for e in (0, 1)])
    dirs = [_end_dir(p if e == 0 else p[::-1], span) for p in P for e in (0, 1)]
    cands = []
    for a, b in sorted(cKDTree(pos).query_pairs(max_gap)):
        if a // 2 == b // 2:
            continue
        g = pos[b] - pos[a]
        dist = float(np.hypot(*g))
        ang = _angle(dirs[a], -dirs[b])
        if dist > 1e-9:
            ang = max(ang, _angle(dirs[a], g), _angle(dirs[b], -g))
        if ang <= max_turn:
            cands.append((ang, dist, a, b))
    parent = list(range(len(P)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    link = {}
    for _, _, a, b in sorted(cands):
        ea, eb = (a // 2, a % 2), (b // 2, b % 2)
        if ea in link or eb in link or find(ea[0]) == find(eb[0]):
            continue
        parent[find(ea[0])] = find(eb[0])
        link[ea], link[eb] = eb, ea
    out = []
    for walk in _walks(range(len(P)), link):
        path = []
        for i, ent in walk:
            path.extend((P[i] if ent == 0 else P[i][::-1]).tolist())
        out.append(path)
    return out


def chain_along(pieces, guide):
    """Join polylines that lie along one guide path into one polyline, in the guide's order.

    Each piece is projected on the guide (arc length of its nearest guide point), oriented
    the guide's way and appended; the joins are straight segments across the gaps.
    """
    g = np.asarray(guide, float)
    seg = np.hypot(*np.diff(g, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])

    def where(q):
        best = (np.inf, 0.0)
        for i in range(len(g) - 1):
            ab = g[i + 1] - g[i]
            l2 = float(ab @ ab)
            t = 0.0 if l2 == 0 else float(np.clip((q - g[i]) @ ab / l2, 0, 1))
            d = float(np.hypot(*(q - (g[i] + t * ab))))
            if d < best[0]:
                best = (d, cum[i] + t * seg[i])
        return best[1]

    placed = []
    for pc in pieces:
        p = np.asarray(pc, float)
        s0, s1 = where(p[0]), where(p[-1])
        if s1 < s0:
            p, s0, s1 = p[::-1], s1, s0
        placed.append((s0, s1, p))
    placed.sort(key=lambda t: (t[0], t[1]))
    out = []
    for _, _, p in placed:
        out.extend(p.tolist())
    return out


# ---------------------------------------------------------------- generations

def _prepare(strokes, margin, pad):
    """Lengths, midpoints, enlarged region boxes (NaN: contains nothing), compatibility
    groups (zone and family) and region keys of the strokes (see assign_generations)."""
    n = len(strokes)
    lens = np.array([s["len"] if "len" in s else polyline_length(s["pts"]) for s in strokes])
    mids = np.array([midpoint(s["pts"]) for s in strokes]).reshape(n, 2)
    boxes = np.full((n, 4), np.nan)
    for i, s in enumerate(strokes):
        if "box" in s and s["box"] is None:
            continue
        if s.get("box") is not None:
            b = np.asarray(s["box"], float)
        else:
            p = np.asarray(s["pts"], float)
            b = np.array([p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()])
        grow = margin * max(b[2] - b[0], b[3] - b[1]) + pad
        boxes[i] = b + np.array([-grow, -grow, grow, grow])
    zone = [s.get("zone") for s in strokes]
    fam = [s.get("family", "line") for s in strokes]
    keys = sorted({(z is None, str(z), f) for z, f in zip(zone, fam)})
    group = np.array([keys.index((z is None, str(z), f)) for z, f in zip(zone, fam)], int)
    regs = [s.get("region") for s in strokes]
    rkeys = {r: k for k, r in enumerate(sorted({str(r) for r in regs if r is not None}))}
    region = np.array([-1 - i if r is None else rkeys[str(r)] for i, r in enumerate(regs)], int)
    return lens, mids, boxes, group, region


def _inside(boxes, q):
    return ((boxes[:, 0] <= q[0]) & (q[0] <= boxes[:, 2]) &
            (boxes[:, 1] <= q[1]) & (q[1] <= boxes[:, 3]))


def assign_generations(strokes, margin=0.1, pad=0.002):
    """Parent/child generations, longest stroke first.

    Each stroke is a dict with "pts" and optionally:
      "box": its region box [x0, y0, x1, y1] (default: the box of its points; None: the
             stroke is never a parent's box, i.e. it contains nothing),
      "region": strokes of the same region (e.g. the sides of one leaf) never contain each
             other: they are siblings,
      "zone", "family": a stroke is only ever the child of a stroke with the same zone and
             family (default None and "line"),
      "gen0": False: the stroke is never gen 0 (if no box contains it, its parent is the
             nearest gen-0 stroke of the same zone and family, by midpoint distance),
      "len": its length (default: computed).
    Going from the longest stroke down, a stroke whose midpoint lies inside the box
    (enlarged by margin x its larger side + pad on every side) of a longer gen-0 or gen-1
    stroke of another region becomes the child of the smallest such box: gen 1 under a
    gen-0 stroke, gen 2 under a gen-1 stroke. Otherwise it is gen 0. Returns copies of the
    dicts with "gen" and "parent" (index in the input list, -1 for gen 0) added.
    """
    n = len(strokes)
    out = [dict(s) for s in strokes]
    lens, mids, boxes, group, region = _prepare(strokes, margin, pad)
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])

    gen = np.full(n, -1)
    parent = np.full(n, -1)
    can = np.zeros(n, bool)                 # may contain later strokes
    order = sorted(range(n), key=lambda i: -lens[i])
    late = []
    for i in order:
        m = can & (group == group[i]) & (lens > lens[i]) & (region != region[i])
        m &= _inside(boxes, mids[i])
        js = np.nonzero(m)[0]
        if len(js):
            j = int(js[np.lexsort((js, area[js]))[0]])
            gen[i] = gen[j] + 1
            parent[i] = j
        elif strokes[i].get("gen0", True):
            gen[i] = 0
        else:
            late.append(i)
            continue
        can[i] = gen[i] < 2 and not np.isnan(boxes[i, 0])
    for i in late:
        js = np.nonzero((gen == 0) & (group == group[i]))[0]
        if not len(js):
            raise ValueError(f"stroke {i} may not be gen 0 and has no gen-0 stroke to join")
        d = np.hypot(*(mids[js] - mids[i]).T)
        j = int(js[np.lexsort((js, d))[0]])
        gen[i], parent[i] = 1, j
    for i, s in enumerate(out):
        s["gen"] = int(gen[i])
        s["parent"] = int(parent[i])
    return out


def promote(strokes, lift):
    """Strokes from assign_generations with the gen-1 strokes in lift made gen 0 (no parent);
    their children (gen 2) become gen 1 under them."""
    out = [dict(s) for s in strokes]
    for i in lift:
        if strokes[i]["gen"] != 1:
            raise ValueError(f"stroke {i} is not gen 1")
        out[i]["gen"], out[i]["parent"] = 0, -1
    for s in out:
        if s["gen"] == 2 and s["parent"] in lift:
            s["gen"] = 1
    return out


def balance(strokes, max_children):
    """A gen-0 stroke keeps at most max_children gen-1 children: its longest ones, and every
    child that has children of its own. The other children (childless) become gen 2 under
    the nearest kept child, by midpoint, so that no parent has a very long queue of children."""
    out = [dict(s) for s in strokes]
    n = len(out)
    lens = np.array([s["len"] if "len" in s else polyline_length(s["pts"]) for s in strokes])
    mids = np.array([midpoint(s["pts"]) for s in strokes]).reshape(n, 2)
    has_kids = np.zeros(n, bool)
    kids = {}
    for i, s in enumerate(strokes):
        if s["parent"] >= 0:
            has_kids[s["parent"]] = True
            if s["gen"] == 1:
                kids.setdefault(s["parent"], []).append(i)
    for p in sorted(kids):
        ch = kids[p]
        if len(ch) <= max_children:
            continue
        order = sorted(ch, key=lambda i: (not has_kids[i], -lens[i], i))
        kept = np.array(order[:max(max_children, int(has_kids[ch].sum()))])
        for i in order[len(kept):]:
            d = np.hypot(*(mids[kept] - mids[i]).T)
            out[i]["gen"] = 2
            out[i]["parent"] = int(kept[np.lexsort((kept, d))[0]])
    return out


def demote(strokes, keep, margin=0.1, pad=0.002):
    """Strokes from assign_generations with every gen-0 stroke not in keep made gen 1.

    A demoted stroke's parent is a kept gen-0 stroke of the same zone and family: the
    longest one of its own region, else the smallest box (as in assign_generations) holding
    its midpoint, else the nearest by midpoint. Its children become gen 2 and its
    grandchildren are hung directly under it (gen 2), so a parent is always one generation
    above its child.
    """
    n = len(strokes)
    out = [dict(s) for s in strokes]
    lens, mids, boxes, group, region = _prepare(strokes, margin, pad)
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    gen = np.array([s["gen"] for s in strokes])
    parent = np.array([s["parent"] for s in strokes])
    kept = np.zeros(n, bool)
    kept[sorted(keep)] = True
    if np.any(kept & (gen != 0)):
        raise ValueError("keep holds strokes that are not gen 0")
    dropped = np.nonzero((gen == 0) & ~kept)[0]
    for i in dropped:
        ok = kept & (group == group[i])
        js = np.nonzero(ok & (region == region[i]))[0]
        if len(js):
            j = int(js[np.lexsort((js, -lens[js]))[0]])
        else:
            js = np.nonzero(ok & _inside(boxes, mids[i]))[0]
            if len(js):
                j = int(js[np.lexsort((js, area[js]))[0]])
            else:
                js = np.nonzero(ok)[0]
                if not len(js):
                    raise ValueError(f"stroke {i}: no kept gen-0 stroke of its zone and family")
                d = np.hypot(*(mids[js] - mids[i]).T)
                j = int(js[np.lexsort((js, d))[0]])
        parent[i] = j
    old_gen = gen.copy()
    old_parent = parent.copy()
    for i in range(n):
        if old_gen[i] == 0 and not kept[i]:
            gen[i] = 1
        elif old_gen[i] == 1 and not kept[old_parent[i]]:
            gen[i] = 2
        elif old_gen[i] == 2:
            p = old_parent[i]                     # a gen-1 stroke
            if old_gen[p] == 1 and not kept[old_parent[p]]:
                parent[i] = old_parent[p]         # now gen 2 under the demoted stroke
    for i, s in enumerate(out):
        s["gen"] = int(gen[i])
        s["parent"] = int(parent[i])
    return out

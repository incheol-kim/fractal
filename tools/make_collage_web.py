"""The collage pieces' web set: the baked cuts (assets/collage/) as JPEG, mostly at half size, in assets/collage-web/.

    .venv\\Scripts\\python.exe tools\\make_collage_web.py           make the web set (or bring it up to date)
    .venv\\Scripts\\python.exe tools\\make_collage_web.py --check   do the web set, its lists and assets/pieces.json fit?

The pieces come in two sets. The originals (assets/collage/b<row>_<k>.webp, lossless, sized for the 4K
video; tools/make_collage.py --bake) stay in the private repository; the web set, made here from them,
goes to both repositories and is what the public web version plays. A web piece has the original's name
with .jpg, JPEG quality 90 with no colour subsampling (4:4:4), no metadata (Pillow's JFIF header alone),
at one of two scales:
  - 0.5, the default: half the original's width and height (each rounded half up: half(), the page's
    Math.max(1, Math.round(n / 2))), Lanczos;
  - 1: the original's size, not resampled, for the pieces data/collage_full_size.json names: those the page
    draws on screen while the camera is pushed in to 1.2x or more, the punch-in after the strike (the
    owner's decision at gate 5a, plan 5's Task 1b; the list is made by node tools/full_size_pieces.mjs from
    the score and the page's own timeline, and records the sha256 of assets/score.json and
    assets/collage.json it was made from: a list that does not match them is stale and stops the run).
The same originals and list make the same bytes.

assets/collage-web/web.json lists the set: {"scale": 0.5, "quality": 90, "cuts": {"<name>.jpg": {"key":
<the original's bake key in assets/collage/baked.json>, "scale": <1 or 0.5>, "w": <width>, "h": <height>}}}
(the top "scale" is the default). A piece whose key and scale are the ones wanted is kept; any other is made
again (its entry and file go first, so a failed run never leaves a piece listed under a key or a scale it
was not made at); pieces whose original is gone are removed. Files are written to a temporary name and
renamed. The run also writes assets/pieces.json, which says which sets the tree has ({"sets": ["full",
"web"]} here; the public tree, which has no originals, says ["web"]): the page reads it to choose its set
(src/collage_set.js).

--check: with the originals there, every original of baked.json has its web piece, listed with the same
key, at the scale the full-size list gives it and at that scale's size of the original, and nothing else
is in the folder or the list; without them (the public tree) the list and the files agree, at the scales
the full-size list gives them. Both: every listed file is there, a 4:4:4 JPEG of the listed size; web.json
has this default scale and quality; the full-size list is there and not stale; assets/pieces.json names
the sets whose folders are there. Prints the problems one a line (exit 1) or one line starting PASS:
(exit 0).
"""
import argparse
import hashlib
import io
import json
import math
import os
import sys
import time

from PIL import Image, JpegImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ORIG_DIR = "assets/collage"
BAKED = "assets/collage/baked.json"
WEB_DIR = "assets/collage-web"
WEB_LIST = "assets/collage-web/web.json"
PIECES = "assets/pieces.json"
FULL_LIST = "data/collage_full_size.json"  # node tools/full_size_pieces.mjs
FULL_LIST_INPUTS = ("assets/score.json", "assets/collage.json")
MAKE_FULL_LIST = "node tools/full_size_pieces.mjs"
SCALE = 0.5  # the default scale
SCALES = (1, 0.5)
QUALITY = 90


def half(n):
    """Half of a side in px, rounded half up (the page's Math.max(1, Math.round(n / 2)); Python's round()
    rounds .5 to the even number)."""
    return max(1, math.floor(n / 2 + 0.5))


def at_scale(size, scale):
    """An original's (w, h) -> its web piece's at scale (1: the same; 0.5: half() of each side)."""
    return tuple(size) if scale == 1 else (half(size[0]), half(size[1]))


def web_name(name):
    """An original's file name (b00_001.webp) -> its web piece's (b00_001.jpg)."""
    return os.path.splitext(name)[0] + ".jpg"


def _p(root, rel):
    return os.path.join(root, *rel.split("/"))


def _load(root, rel):
    with open(_p(root, rel), encoding="utf-8") as f:
        return json.load(f)


def _write(path, data, tries=20):
    """Bytes to a temporary name, then renamed. On Windows a file just written can be held for a moment (a
    virus scan, the search indexer): the rename then fails with access denied (seen 2026-11-20, once in a
    few hundred renames of web.json), and is tried again for up to about 2 s."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    for i in range(tries):
        try:
            os.replace(path + ".tmp", path)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.1)


def dumps(cuts):
    """web.json as text: one piece a line, by name."""
    lines = ["{", ' "scale": %s,' % json.dumps(SCALE), ' "quality": %d,' % QUALITY, ' "cuts": {']
    names = sorted(cuts)
    for i, n in enumerate(names):
        e = cuts[n]
        lines.append("  %s: %s%s" % (json.dumps(n), json.dumps({"key": e["key"], "scale": e["scale"], "w": e["w"], "h": e["h"]}),
                                     "," if i < len(names) - 1 else ""))
    lines += [" }", "}"]
    return "\n".join(lines) + "\n"


def _save_list(root, cuts):
    _write(_p(root, WEB_LIST), dumps(cuts).encode("utf-8"))


def _sets(root):
    """The sets whose folders are there, in the order the page prefers them."""
    return [s for s, rel in (("full", ORIG_DIR), ("web", WEB_DIR)) if os.path.isdir(_p(root, rel))]


def _size(path):
    with Image.open(path) as im:
        return im.size


def list_inputs(root=ROOT):
    """The sha256 of each file the full-size list is made from, as the list records them."""
    out = {}
    for rel in FULL_LIST_INPUTS:
        with open(_p(root, rel), "rb") as f:
            out[rel] = hashlib.sha256(f.read()).hexdigest()
    return out


def full_size(root=ROOT):
    """data/collage_full_size.json -> (the originals' names it gives scale 1, problems): problems when it is not
    there, not a list of names, or stale (made from other inputs than the files there now)."""
    try:
        lst = _load(root, FULL_LIST)
    except (OSError, ValueError) as e:
        return set(), ["%s: not there or not JSON (%s); make it with %s" % (FULL_LIST, e, MAKE_FULL_LIST)]
    pieces = lst.get("pieces") if isinstance(lst, dict) else None
    if not isinstance(pieces, list) or not all(isinstance(n, str) for n in pieces):
        return set(), ["%s: no list of pieces; make it with %s" % (FULL_LIST, MAKE_FULL_LIST)]
    try:
        now = list_inputs(root)
    except OSError as e:
        return set(pieces), ["%s: its inputs cannot be read (%s)" % (FULL_LIST, e)]
    had = lst.get("inputs") if isinstance(lst.get("inputs"), dict) else {}
    changed = [rel for rel in FULL_LIST_INPUTS if had.get(rel) != now[rel]]
    if changed:
        return set(pieces), ["%s: stale: made from another %s; make it again with %s" % (FULL_LIST, " and ".join(changed), MAKE_FULL_LIST)]
    return set(pieces), []


def encode(path, scale=SCALE):
    """An original -> (its web piece's JPEG bytes, (w, h)) at scale (1: the original's size, not resampled)."""
    with Image.open(path) as im:
        src = im.convert("RGB")
    size = at_scale(src.size, scale)
    sized = src if size == src.size else src.resize(size, Image.Resampling.LANCZOS)
    clean = Image.frombytes("RGB", size, sized.tobytes())  # nothing of the original's info goes along
    buf = io.BytesIO()
    clean.save(buf, format="JPEG", quality=QUALITY, subsampling=0, optimize=True)
    return buf.getvalue(), size


def _entry_scale(e):
    """A web.json entry's scale (its own, else the default); None when it is none of SCALES."""
    s = e.get("scale", SCALE) if isinstance(e, dict) else None
    return s if s in SCALES and not isinstance(s, bool) else None


def _listed(root):
    """web.json's cuts when it is there and made with this default scale and quality, else {} (everything is made again)."""
    try:
        lst = _load(root, WEB_LIST)
    except (OSError, ValueError):
        return {}
    if not isinstance(lst, dict) or lst.get("scale") != SCALE or lst.get("quality") != QUALITY or not isinstance(lst.get("cuts"), dict):
        return {}
    return {n: e for n, e in lst["cuts"].items() if isinstance(e, dict)}


def make(root=ROOT, out=print):
    """Make the web set from the originals. -> {"made", "kept", "removed", "seconds"} (file names, sorted)."""
    if not os.path.exists(_p(root, BAKED)):
        raise SystemExit("%s is not there: the web set is made from the original pieces (%s/, tools/make_collage.py "
                         "--bake), which this tree does not have" % (BAKED, ORIG_DIR))
    baked = _load(root, BAKED)
    gone = sorted(n for n in baked if not os.path.exists(_p(root, ORIG_DIR + "/" + n)))
    if gone:
        raise SystemExit("%s lists originals that are not there (%d): %s; bake them with tools/make_collage.py --bake"
                         % (BAKED, len(gone), ", ".join(gone[:5]) + (" ..." if len(gone) > 5 else "")))
    full, problems = full_size(root)
    unknown = sorted(full - set(baked))
    if unknown:
        problems.append("%s names pieces %s does not have: %s" % (FULL_LIST, BAKED, ", ".join(unknown[:5])))
    if problems:
        raise SystemExit("\n".join(problems))
    want = {web_name(n): (n, key, 1 if n in full else SCALE) for n, key in baked.items()}
    out_dir = _p(root, WEB_DIR)
    os.makedirs(out_dir, exist_ok=True)
    cuts = _listed(root)
    todo, kept = [], []
    for wn, (n, key, scale) in sorted(want.items()):
        path = os.path.join(out_dir, wn)
        e = cuts.get(wn)
        if e and e.get("key") == key and _entry_scale(e) == scale and os.path.exists(path):
            size = (e.get("w"), e.get("h"))
            if _size(path) == size and size == at_scale(_size(_p(root, ORIG_DIR + "/" + n)), scale):
                e["scale"] = scale  # a list from before the scales gave none: the default
                kept.append(wn)
                continue
        todo.append(wn)
        # an entry and a file from another original or scale go first: never listed under what they were not made from
        cuts.pop(wn, None)
        if os.path.exists(path):
            os.remove(path)
    for wn in [w for w in cuts if w not in want]:
        del cuts[wn]
    _save_list(root, cuts)
    t0 = time.time()
    for i, wn in enumerate(todo):
        n, key, scale = want[wn]
        data, (w, h) = encode(_p(root, ORIG_DIR + "/" + n), scale)
        _write(os.path.join(out_dir, wn), data)
        cuts[wn] = {"key": key, "scale": scale, "w": w, "h": h}
        _save_list(root, cuts)
        if (i + 1) % 50 == 0:
            out("%d / %d" % (i + 1, len(todo)))
    seconds = time.time() - t0
    removed = []
    for name in sorted(os.listdir(out_dir)):
        if name != os.path.basename(WEB_LIST) and name not in want:
            os.remove(os.path.join(out_dir, name))
            removed.append(name)
    _write(_p(root, PIECES), (json.dumps({"sets": _sets(root)}) + "\n").encode("utf-8"))
    return {"made": todo, "kept": kept, "removed": removed, "seconds": seconds}


def _jpeg_problem(path):
    """None for an RGB JPEG with no colour subsampling, else what the file is."""
    try:
        with Image.open(path) as im:
            if im.format != "JPEG" or im.mode != "RGB":
                return "a %s %s picture, not an RGB JPEG" % (im.mode, im.format)
            if JpegImagePlugin.get_sampling(im) != 0:
                return "a JPEG with colour subsampling, not 4:4:4"
    except OSError as e:
        return "not a picture (%s)" % e
    return None


def check(root=ROOT):
    """-> problems (see the module's docstring)."""
    problems = []
    sets = _sets(root)
    try:
        pieces = _load(root, PIECES)
    except (OSError, ValueError) as e:
        pieces = None
        problems.append("%s: not there or not JSON (%s); tools/make_collage_web.py writes it" % (PIECES, e))
    if pieces is not None and pieces != {"sets": sets}:
        problems.append("%s says %s, the folders say %s" % (PIECES, json.dumps(pieces), json.dumps({"sets": sets})))
    if "web" not in sets:
        return problems + ["%s/ is not there; make it with tools/make_collage_web.py" % WEB_DIR]
    try:
        lst = _load(root, WEB_LIST)
    except (OSError, ValueError) as e:
        return problems + ["%s: not there or not JSON (%s)" % (WEB_LIST, e)]
    if not isinstance(lst, dict) or not isinstance(lst.get("cuts"), dict):
        return problems + ["%s: not {scale, quality, cuts}" % WEB_LIST]
    if lst.get("scale") != SCALE or lst.get("quality") != QUALITY:
        problems.append("%s: scale %r and quality %r, the tool makes %r and %r" % (WEB_LIST, lst.get("scale"), lst.get("quality"), SCALE, QUALITY))
    cuts = lst["cuts"]
    full, list_problems = full_size(root)
    problems += list_problems
    out_dir = _p(root, WEB_DIR)
    files = set(os.listdir(out_dir)) - {os.path.basename(WEB_LIST)}
    for wn in sorted(cuts):
        e = cuts[wn]
        path = os.path.join(out_dir, wn)
        if not os.path.exists(path):
            problems.append("%s: missing (%s lists it)" % (wn, WEB_LIST))
            continue
        bad = _jpeg_problem(path)
        if bad:
            problems.append("%s: %s" % (wn, bad))
            continue
        have = _size(path)
        listed = (e.get("w"), e.get("h")) if isinstance(e, dict) else (None, None)
        if have != listed:
            problems.append("%s: %dx%d, %s says %sx%s" % (wn, have[0], have[1], WEB_LIST, listed[0], listed[1]))
        scale = _entry_scale(e)
        if scale is None:
            problems.append("%s: %s gives it scale %s (a piece is at scale 1 or 0.5)" % (wn, WEB_LIST, e.get("scale") if isinstance(e, dict) else None))
    for wn in sorted(files - set(cuts)):
        problems.append("%s/%s: left over (not in %s)" % (WEB_DIR, wn, WEB_LIST))
    # the scale of each piece is the full-size list's
    named = {web_name(n): n for n in full}
    for wn in sorted(set(cuts)):
        scale = _entry_scale(cuts[wn])
        wanted = 1 if wn in named else SCALE
        if scale is not None and scale != wanted:
            problems.append("%s: made at scale %s, %s wants scale %s; run tools/make_collage_web.py" % (wn, scale, FULL_LIST, wanted))
    if "full" in sets:
        if not os.path.exists(_p(root, BAKED)):
            return problems + ["%s: not there, though %s/ is" % (BAKED, ORIG_DIR)]
        baked = _load(root, BAKED)
        for n in sorted(full - set(baked)):
            problems.append("%s names %s, which %s does not have" % (FULL_LIST, n, BAKED))
        want = {web_name(n): (n, key) for n, key in baked.items()}
        for wn in sorted(set(want) - set(cuts)):
            problems.append("%s: missing from %s (%s has %s); run tools/make_collage_web.py" % (wn, WEB_LIST, BAKED, want[wn][0]))
        for wn in sorted(set(cuts) - set(want)):
            problems.append("%s: in %s but not in %s (left over); run tools/make_collage_web.py" % (wn, WEB_LIST, BAKED))
        for wn in sorted(set(want) & set(cuts)):
            n, key = want[wn]
            e = cuts[wn] if isinstance(cuts[wn], dict) else {}
            if e.get("key") != key:
                problems.append("%s: made from another bake of %s (stale: web.json has %s, baked.json %s); run tools/make_collage_web.py"
                                % (wn, n, e.get("key"), key))
                continue
            orig = _p(root, ORIG_DIR + "/" + n)
            if not os.path.exists(orig):
                problems.append("%s: its original %s/%s is not there (%s lists it)" % (wn, ORIG_DIR, n, BAKED))
                continue
            scale = _entry_scale(e)
            if scale is None:
                continue
            osize = _size(orig)
            sized = at_scale(osize, scale)
            if (e.get("w"), e.get("h")) != sized:
                what = "half of" if scale == SCALE else "the size of"
                problems.append("%s: %s records %sx%s, but at scale %s (%s %s, %dx%d) it is %dx%d" % (
                    wn, WEB_LIST, e.get("w"), e.get("h"), scale, what, n, osize[0], osize[1], sized[0], sized[1]))
    else:
        for n in sorted(full):
            if web_name(n) not in cuts:
                problems.append("%s names %s, which %s does not list" % (FULL_LIST, n, WEB_LIST))
    return problems


def _summary(root):
    lst = _load(root, WEB_LIST)
    out_dir = _p(root, WEB_DIR)
    size = sum(os.path.getsize(os.path.join(out_dir, n)) for n in lst["cuts"])
    ones = sum(1 for e in lst["cuts"].values() if _entry_scale(e) == 1)
    return len(lst["cuts"]), ones, size


def main(argv=None, root=ROOT):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="do the web set, its lists and assets/pieces.json fit?")
    a = ap.parse_args(argv)
    if a.check:
        problems = check(root)
        if problems:
            print("\n".join(problems))
            sys.exit(1)
        n, ones, size = _summary(root)
        sets = _sets(root)
        how = "current with %s" % BAKED if "full" in sets else "%s and the files agree (no originals here)" % WEB_LIST
        print("PASS: %d web pieces, %d of them full size (%.1f MiB), %s and %s; %s: %s" % (
            n, ones, size / 2 ** 20, how, FULL_LIST, PIECES, ", ".join(sets)))
        sys.exit(0)
    t0 = time.time()
    r = make(root)
    n, ones, size = _summary(root)
    print("made %d (%.1f s), kept %d, removed %d; %d pieces, %d of them full size, %d bytes (%.1f MiB); %.1f s in all" % (
        len(r["made"]), r["seconds"], len(r["kept"]), len(r["removed"]), n, ones, size, size / 2 ** 20, time.time() - t0))


if __name__ == "__main__":
    main()

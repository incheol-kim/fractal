import contextlib
import io
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import collage_lib  # noqa: E402
import make_collage  # noqa: E402
import make_collage_web  # noqa: E402
import pick_collage  # noqa: E402
import public_tree  # noqa: E402
import upscale_refs  # noqa: E402

# The public tree's mark (tools/public_tree.py: a file at the root of the tree generated for the public
# repository, which has no original pieces and no docs/): the tests of what it lacks skip there, and only there.
PUBLIC_TREE = public_tree.MARKER

LETTERS = "abcde"


def fake_sheet():
    cands = []
    for i, ch in enumerate(LETTERS):
        cands.append({
            "letter": ch, "image": "resources/x/%s.png" % ch, "folder": "x",
            "crop": [10.0 * i, 0.0, 100.0, 50.0], "scale_at_4k": 1.0,
            "rotation_deg": 0.5 * i, "mean_rgb": [1, 2, 3], "shows": "s" + ch,
            "accent": ch == "e", "colour_shift": None,
        })
    block = {"no": 3, "name": "wing_left", "place": "p", "accent": True,
             "leaves": [1, 2], "bbox": [0.1, 0.1, 0.5, 0.5], "candidates": cands}
    return {"look": {}, "blocks": [block]}


def letters_of(blocks):
    return "".join(im["letter"] for im in blocks[0]["images"])


def run(spec):
    blocks, notes = collage_lib.apply_picks(fake_sheet(), {"blocks": [spec] if spec else []})
    return blocks, notes


class PickTest(unittest.TestCase):
    def test_default(self):
        blocks, _ = run(None)
        self.assertEqual(letters_of(blocks), "abcde")
        self.assertEqual(blocks[0]["accent"], 4)

    def test_drop(self):
        blocks, _ = run({"block": 3, "drop": ["b"]})
        self.assertEqual(letters_of(blocks), "acde")

    def test_order(self):
        blocks, _ = run({"block": 3, "order": ["d", "a"]})
        self.assertEqual(letters_of(blocks), "dabce")

    def test_drop_and_order(self):
        blocks, _ = run({"block": 3, "drop": ["b"], "order": ["d"]})
        self.assertEqual(letters_of(blocks), "dace")

    def test_only(self):
        blocks, _ = run({"block": 3, "only": ["c", "a"]})
        self.assertEqual(letters_of(blocks), "ca")
        self.assertEqual(blocks[0]["accent"], -1)

    def test_number_or_name(self):
        a, _ = run({"block": 3, "order": ["c"]})
        b, _ = run({"block": "wing_left", "order": ["c"]})
        self.assertEqual(a, b)

    def test_dropped_accent_noted(self):
        blocks, notes = run({"block": 3, "drop": ["e"]})
        self.assertEqual(blocks[0]["accent"], -1)
        self.assertTrue(any("wing_left" in n and "강조" in n for n in notes))

    def test_few_images_noted(self):
        _, notes = run(None)
        self.assertTrue(any("wing_left" in n and "5" in n for n in notes))

    def test_image_fields(self):
        blocks, _ = run(None)
        im = blocks[0]["images"][1]
        self.assertEqual(set(im), {"letter", "image", "crop", "tilt", "shift", "shows"})
        self.assertEqual(im["tilt"], 0.5)
        self.assertEqual(blocks[0]["no"], 3)
        self.assertEqual(blocks[0]["bbox"], [0.1, 0.1, 0.5, 0.5])

    def test_scale_at_4k(self):
        self.assertAlmostEqual(
            collage_lib.scale_at_4k([0.0, 0.0, 0.5, 1.0], [0, 0, 1472, 100]),
            0.5 * 2944 * collage_lib.PX4K / 1472)


class PickErrorTest(unittest.TestCase):
    def assertFails(self, spec, *words):
        with self.assertRaises(collage_lib.PickError) as cm:
            collage_lib.apply_picks(fake_sheet(), {"blocks": spec})
        for w in words:
            self.assertIn(w, str(cm.exception))

    def test_unknown_letter(self):
        self.assertFails([{"block": 3, "drop": ["z"]}], "wing_left", "z")
        self.assertFails([{"block": 3, "order": ["z"]}], "wing_left", "z")
        self.assertFails([{"block": 3, "only": ["z"]}], "wing_left", "z")

    def test_unknown_block(self):
        self.assertFails([{"block": "nope"}], "nope")
        self.assertFails([{"block": 99}], "99")

    def test_twice(self):
        self.assertFails([{"block": 3}, {"block": "wing_left"}], "wing_left")

    def test_only_with_drop(self):
        self.assertFails([{"block": 3, "only": ["a"], "drop": ["b"]}], "wing_left")

    def test_drop_and_order_same_letter(self):
        self.assertFails([{"block": 3, "drop": ["b"], "order": ["b"]}], "wing_left", "b")

    def test_order_twice(self):
        self.assertFails([{"block": 3, "order": ["a", "a"]}], "wing_left", "a")

    def test_misspelt_spec_key(self):
        self.assertFails([{"block": 3, "drops": ["c"]}], "wing_left", "drops")
        self.assertFails([{"block": "wing_left", "ordr": ["c"]}], "wing_left", "ordr")

    def test_misspelt_picks_key(self):
        for picks in ({"block": [{"block": 3}]}, {"blockz": []}):
            with self.assertRaises(collage_lib.PickError) as cm:
                collage_lib.apply_picks(fake_sheet(), picks)
            self.assertIn(list(picks)[0], str(cm.exception))

    def test_boolean_block(self):
        self.assertFails([{"block": True}], "True")

    def test_missing_block_key(self):
        self.assertFails([{"drop": ["a"]}], "block")

    def test_letter_not_a_string(self):
        self.assertFails([{"block": 3, "drop": [["a"]]}], "wing_left")
        self.assertFails([{"block": 3, "order": [1]}], "wing_left")

    def test_nothing_left(self):
        self.assertFails([{"block": 3, "drop": list(LETTERS)}], "wing_left")

    def test_picks_not_an_object(self):
        for picks in ([], "blocks", None, 5):
            with self.assertRaises(collage_lib.PickError, msg=repr(picks)):
                collage_lib.apply_picks(fake_sheet(), picks)

    def test_blocks_not_a_list(self):
        for blocks in (None, 5, {"block": 3}):
            with self.assertRaises(collage_lib.PickError, msg=repr(blocks)) as cm:
                collage_lib.apply_picks(fake_sheet(), {"blocks": blocks})
            self.assertIn("blocks", str(cm.exception))

    def test_regions_key_allowed(self):
        blocks, _ = collage_lib.apply_picks(fake_sheet(), {"sheet": "s.json", "regions": "0123456789abcdef",
                                                           "message": "", "blocks": []})
        self.assertEqual(letters_of(blocks), "abcde")


def fake_regions(fp="0123456789abcdef"):
    """A region map for fake_sheet: leaves 1 and 2 span the block's bbox [0.1, 0.1, 0.5, 0.5]."""
    return {"fingerprint": fp, "leaves": [{"id": 1, "bbox": [0.1, 0.2, 0.3, 0.5]},
                                          {"id": 2, "bbox": [0.2, 0.1, 0.5, 0.4]},
                                          {"id": 9, "bbox": [0.0, 0.0, 1.0, 1.0]}]}


class SheetMapTest(unittest.TestCase):
    """The candidate sheet belongs to one region map: the picks file names its fingerprint, and every
    block's leaves and bbox are that map's."""

    def picks(self, **kw):
        return dict({"sheet": "s.json", "regions": "0123456789abcdef", "blocks": []}, **kw)

    def assertStops(self, sheet, picks, regions, *words):
        with self.assertRaises(collage_lib.PickError) as cm:
            collage_lib.check_sheet_map(sheet, picks, regions)
        for w in words:
            self.assertIn(w, str(cm.exception))

    def test_fits(self):
        collage_lib.check_sheet_map(fake_sheet(), self.picks(), fake_regions())

    def test_no_fingerprint(self):
        picks = self.picks()
        del picks["regions"]
        self.assertStops(fake_sheet(), picks, fake_regions(), "regions")
        self.assertStops(fake_sheet(), self.picks(regions=None), fake_regions(), "regions")

    def test_other_map(self):
        self.assertStops(fake_sheet(), self.picks(), fake_regions("fedcba9876543210"),
                         "0123456789abcdef", "fedcba9876543210", "sheet")

    def test_leaf_not_on_the_map(self):
        sheet = fake_sheet()
        sheet["blocks"][0]["leaves"] = [1, 2, 7]
        self.assertStops(sheet, self.picks(), fake_regions(), "wing_left", "7")

    def test_box_not_its_leaves(self):
        sheet = fake_sheet()
        sheet["blocks"][0]["bbox"] = [0.1, 0.1, 0.5, 0.52]
        self.assertStops(sheet, self.picks(), fake_regions(), "wing_left", "bbox")


class PickMainTest(unittest.TestCase):
    """pick_collage.main stops with a message, not a traceback, and writes nothing."""

    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, rel, obj):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def stops(self):
        with self.assertRaises(SystemExit) as cm:
            pick_collage.main(self.root)
        self.assertIsInstance(cm.exception.code, str)
        self.assertFalse(os.path.exists(os.path.join(self.root, "data", "collage.json")))
        return cm.exception.code

    def test_picks_file_not_an_object(self):
        self.write("data/collage_picks.json", [])
        self.assertIn("collage_picks.json", self.stops())

    def test_sheet_for_another_map(self):
        self.write("data/collage_picks.json", {"sheet": "sheet.json", "regions": "0123456789abcdef", "blocks": []})
        self.write("sheet.json", fake_sheet())
        self.write("assets/regions.json", fake_regions("fedcba9876543210"))
        self.assertIn("fedcba9876543210", self.stops())

    def test_bad_pick(self):
        self.write("data/collage_picks.json", {"sheet": "sheet.json", "regions": "0123456789abcdef",
                                               "blocks": [{"block": 3, "drop": ["z"]}]})
        self.write("sheet.json", fake_sheet())
        self.write("assets/regions.json", fake_regions())
        self.assertIn("wing_left", self.stops())

    def test_the_sheets_old_names_through_the_table(self):
        self.write("data/collage_picks.json", {"sheet": "sheet.json", "names": "names.md", "regions": "0123456789abcdef",
                                               "blocks": []})
        self.write("sheet.json", ref_sheet())
        self.write("assets/regions.json", fake_regions())
        with open(os.path.join(self.root, "names.md"), "w", encoding="utf-8") as f:
            f.write(NAME_TABLE)
        with contextlib.redirect_stdout(io.StringIO()):
            pick_collage.main(self.root)
        data = load_json_at(self.root, "data/collage.json")
        self.assertEqual([im["image"] for im in data["blocks"][0]["images"]],
                         ["resources/midjourney_images/x/x-%02d.png" % (i + 1) for i in range(5)])
        self.assertEqual(data["sheet"], "sheet.json")

    def test_a_missing_name_table_stops(self):
        self.write("data/collage_picks.json", {"sheet": "sheet.json", "names": "names.md", "regions": "0123456789abcdef",
                                               "blocks": []})
        self.write("sheet.json", ref_sheet())
        self.write("assets/regions.json", fake_regions())
        self.assertIn("names.md", self.stops())


def load_json_at(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return json.load(f)


def ref_sheet():
    """fake_sheet with its images under the tracked root of the reference images, named as before the
    renaming (old_<letter>.png in folder x)."""
    sheet = fake_sheet()
    for c in sheet["blocks"][0]["candidates"]:
        c["image"] = "resources/midjourney_images/x/old_%s.png" % c["letter"]
    return sheet


# the name table in the form of docs/2026-11-20-reference-image-names.md (the private repository's): a row
# per image, its new name first, then its old name
NAME_TABLE = "\n".join(["# names", "", "## x (5)", "", "| 새 이름 | 옛 이름 | 뿌리 | 키운 것 |", "|---|---|---|---|"]
                       + ["| `x/x-%02d.png` | `x/old_%s.png` | `resources/` | - |" % (i + 1, ch) for i, ch in enumerate(LETTERS)]) + "\n"


class NameTableTest(unittest.TestCase):
    """A candidate sheet made before the reference images got their plain names (2026-11-20) names them by
    their old names; the picks file names the table that gives the new ones ("names")."""

    def test_read(self):
        table = collage_lib.read_name_table(NAME_TABLE)
        self.assertEqual(table, {"x/old_%s.png" % ch: "x/x-%02d.png" % (i + 1) for i, ch in enumerate(LETTERS)})

    def test_a_table_without_rows_or_with_a_name_twice_stops(self):
        for text in ("# names\n", NAME_TABLE + "| `x/x-09.png` | `x/old_a.png` | `resources/` | - |\n",
                     NAME_TABLE + "| `x/x-01.png` | `x/old_z.png` | `resources/` | - |\n"):
            with self.assertRaises(collage_lib.PickError):
                collage_lib.read_name_table(text)

    def test_renamed_sheet(self):
        sheet = ref_sheet()
        got = collage_lib.renamed_sheet(sheet, collage_lib.read_name_table(NAME_TABLE), "names.md")
        self.assertEqual([c["image"] for c in got["blocks"][0]["candidates"]],
                         ["resources/midjourney_images/x/x-%02d.png" % (i + 1) for i in range(5)])
        # nothing else changes, and the sheet given stays as it was
        for a, b in zip(got["blocks"][0]["candidates"], ref_sheet()["blocks"][0]["candidates"]):
            self.assertEqual(dict(a, image=None), dict(b, image=None))
        self.assertEqual(sheet, ref_sheet())

    def test_a_name_not_in_the_table_stops(self):
        sheet = ref_sheet()
        sheet["blocks"][0]["candidates"][2]["image"] = "local-only/resources/midjourney_images/x/old_q.png"
        with self.assertRaises(collage_lib.PickError) as cm:
            collage_lib.renamed_sheet(sheet, collage_lib.read_name_table(NAME_TABLE), "names.md")
        self.assertIn("x/old_q.png", str(cm.exception))
        self.assertIn("names.md", str(cm.exception))

    def test_the_picks_file_names_the_table(self):
        self.assertIsNone(collage_lib.picks_names({"sheet": "s.json", "blocks": []}))
        self.assertEqual(collage_lib.picks_names({"sheet": "s.json", "names": "n.md", "blocks": []}), "n.md")
        for bad in ("", 5, None):
            with self.assertRaises(collage_lib.PickError):
                collage_lib.picks_names({"sheet": "s.json", "names": bad, "blocks": []})
        # apply_picks takes the key
        blocks, _ = collage_lib.apply_picks(fake_sheet(), {"sheet": "s.json", "names": "n.md", "blocks": []})
        self.assertEqual(letters_of(blocks), "abcde")


def load_json(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


SHEET_WORDS = "the candidate sheet the collage's picks were made from (a review bundle under docs/)"
NAMES_WORDS = "the table of the reference images' old and new names, which the sheet is read through (docs/)"


def load_sheet(rel):
    """The candidate sheet data/collage.json names (docs/review/...), its images' old names read through the
    name table data/collage_picks.json names ("names", docs/): skipped in the public tree, which has no docs/
    (tools/public_tree.py); anywhere else a missing sheet or table fails."""
    public_tree.skip_unpublished(rel, SHEET_WORDS)
    sheet = load_json(rel)
    names = collage_lib.picks_names(load_json("data/collage_picks.json"))
    if names:
        public_tree.skip_unpublished(names, NAMES_WORDS)
        with open(os.path.join(ROOT, *names.split("/")), encoding="utf-8") as f:
            sheet = collage_lib.renamed_sheet(sheet, collage_lib.read_name_table(f.read()), names)
    return sheet


class DataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_json("data/collage.json")
        cls.regions = load_json("assets/regions.json")

    @property
    def sheet(self):
        return load_sheet(self.data["sheet"])

    def test_blocks_partition_colour_leaves(self):
        self.assertEqual(len(self.data["blocks"]), 25)
        want = {l["id"] for l in self.regions["leaves"]
                if l["kind"] in ("mass", "part") and l["size"] >= 1}
        got = [i for b in self.data["blocks"] for i in b["leaves"]]
        self.assertEqual(len(got), len(set(got)))
        self.assertEqual(set(got), want)
        self.assertEqual(len(want), 134)

    def test_images_and_accents(self):
        for b in self.data["blocks"]:
            self.assertTrue(1 <= len(b["images"]) <= 10, b["name"])
        blocks, _ = collage_lib.apply_picks(self.sheet, {"blocks": []})
        self.assertEqual({b["name"] for b in blocks if b["accent"] >= 0},
                         {"glass_room", "wing_left", "blue_block", "yellow_block", "red_room"})

    def test_crops(self):
        for b in self.data["blocks"]:
            bw = (b["bbox"][2] - b["bbox"][0]) * 2944
            bh = (b["bbox"][3] - b["bbox"][1]) * 1648
            for im in b["images"]:
                x, y, w, h = im["crop"]
                self.assertTrue(x >= 0 and y >= 0 and x + w <= 2944 + 1e-6
                                and y + h <= 1648 + 1e-6, (b["name"], im["letter"]))
                self.assertAlmostEqual((h / w) / (bh / bw), 1.0, delta=0.01)

    def test_scale(self):
        # every crop at the key image's scale (plan amendment 2026-11-17)
        for b in self.data["blocks"]:
            for im in b["images"]:
                self.assertAlmostEqual(collage_lib.scale_at_4k(b["bbox"], im["crop"]) / collage_lib.SCALE, 1.0,
                                       delta=0.005, msg=(b["name"], im["letter"]))

    def test_fingerprint(self):
        self.assertEqual(self.data["regions"], self.regions["fingerprint"])

    def test_sheet_fits_the_map(self):
        picks = load_json("data/collage_picks.json")
        self.assertEqual(picks["regions"], self.regions["fingerprint"])
        collage_lib.check_sheet_map(self.sheet, picks, self.regions)

    def test_committed_bytes(self):
        public_tree.skip_unpublished(load_json("data/collage_picks.json")["sheet"], SHEET_WORDS)
        with open(os.path.join(ROOT, "data", "collage.json"), "rb") as f:
            have = f.read()
        self.assertEqual(have, pick_collage.dumps(pick_collage.build()).encode("utf-8"))


def need_originals(names):
    """Skip the calling test (unittest.SkipTest) when a reference original is in neither root."""
    for name in sorted(names):
        try:
            collage_lib.ref_path(name)
        except FileNotFoundError as e:
            raise unittest.SkipTest("needs the reference originals: %s" % e)


# ---------------------------------------------------------------- where the reference images live

def touch(root, rel, data=b"x"):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


class RefPathTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_name(self):
        self.assertEqual(collage_lib.ref_name("resources/midjourney_images/sky line/a b.png"), "sky line/a b.png")
        self.assertEqual(collage_lib.ref_name("local-only/resources/midjourney_images/p/q.png"), "p/q.png")
        self.assertEqual(collage_lib.ref_name("local-only\\resources\\midjourney_images\\p\\q.png"), "p/q.png")
        self.assertEqual(collage_lib.ref_name("p/q.png"), "p/q.png")
        with self.assertRaises(ValueError):
            collage_lib.ref_name("assets/x/p/q.png")

    def test_path_in_either_root(self):
        touch(self.root, "local-only/resources/midjourney_images/p/q.png")
        self.assertEqual(collage_lib.ref_path("p/q.png", self.root), "local-only/resources/midjourney_images/p/q.png")
        # a path naming the other root finds the file where it is
        self.assertEqual(collage_lib.ref_path("resources/midjourney_images/p/q.png", self.root),
                         "local-only/resources/midjourney_images/p/q.png")
        touch(self.root, "resources/midjourney_images/p/q.png")
        self.assertEqual(collage_lib.ref_path("p/q.png", self.root), "resources/midjourney_images/p/q.png")

    def test_missing_names_both_places(self):
        with self.assertRaises(FileNotFoundError) as cm:
            collage_lib.ref_path("p/none.png", self.root)
        for r in collage_lib.REF_ROOTS:
            self.assertIn(r + "/p/none.png", str(cm.exception))

    def test_upscaled_path(self):
        self.assertEqual(collage_lib.upscaled_path("local-only/resources/midjourney_images/p/q.png"),
                         "local-only/assets/collage_src/p/q.png")
        self.assertEqual(collage_lib.upscaled_path("p/q.png"), "local-only/assets/collage_src/p/q.png")

    def test_box_and_margin(self):
        bw, bh, m = collage_lib.box_and_margin([0.25, 0.25, 0.75, 0.75])
        self.assertEqual((bw, bh), (math.ceil(0.5 * 2944 * 2160 / 1648), 1080))
        self.assertEqual(m, math.ceil(0.5 * math.hypot(bw, bh) * math.sin(math.radians(2))) + 8)
        self.assertEqual(m, 47)
        # a product that is a whole number is not rounded up by float noise
        self.assertEqual(collage_lib.box_and_margin([0.0, 0.0, 412 / 2944, 206 / 1648])[:2], (540, 270))


# ---------------------------------------------------------------- colour shift

def colours(n=4096, seed=5):
    """uint8 (64, n/64, 3): random colours plus the corners of the RGB cube and greys."""
    rng = np.random.default_rng(seed)
    px = rng.integers(0, 256, (n, 3)).astype(np.uint8)
    corners = np.array([[r, g, b] for r in (0, 255) for g in (0, 255) for b in (0, 255)], np.uint8)
    greys = np.repeat(np.arange(0, 256, 8, dtype=np.uint8)[:, None], 3, axis=1)
    px[:len(corners)] = corners
    px[len(corners):len(corners) + len(greys)] = greys
    return px.reshape(64, -1, 3)


def sheet_mean(src, bbox, crop, rot, shift, ids, leaves):
    """The sheet's mean_rgb of a candidate (v3_lib.cand_mean, on the original): the crop drawn into the
    block's box at half the picture's scale, rotated about the crop centre, colour-shifted, averaged
    inside the silhouette."""
    pw, ph, sc = 2944, 1648, 0.5
    x0, y0 = math.floor(bbox[0] * pw * sc), math.floor(bbox[1] * ph * sc)
    x1, y1 = math.ceil(bbox[2] * pw * sc), math.ceil(bbox[3] * ph * sc)
    w, h = x1 - x0, y1 - y0
    centre = ((bbox[0] + bbox[2]) / 2 * pw * sc - x0, (bbox[1] + bbox[3]) / 2 * ph * sc - y0)
    bw, bh = (bbox[2] - bbox[0]) * pw, (bbox[3] - bbox[1]) * ph
    cx, cy, ws = crop[0] + crop[2] / 2, crop[1] + crop[3] / 2, crop[2]
    z = bw * sc / ws
    r = 0.75 * max(ws, ws * bh / bw) + 40
    sx0, sx1 = int(max(0, cx - r)), int(min(src.shape[1], cx + r + 2))
    sy0, sy1 = int(max(0, cy - r)), int(min(src.shape[0], cy + r + 2))
    sz = cv2.resize(src[sy0:sy1, sx0:sx1], None, fx=z, fy=z, interpolation=cv2.INTER_AREA if z < 1 else cv2.INTER_LANCZOS4)
    pcx, pcy = (cx - sx0) * z, (cy - sy0) * z
    m = cv2.getRotationMatrix2D((pcx, pcy), rot, 1.0)
    m[0, 2] += centre[0] - pcx
    m[1, 2] += centre[1] - pcy
    f = cv2.warpAffine(sz, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
    f = collage_lib.apply_shift(f, shift).astype(np.float64)
    inside = np.isin(ids[2 * y0:2 * y1, 2 * x0:2 * x1], leaves).astype(np.float32)
    u = cv2.resize(inside, (w, h), interpolation=cv2.INTER_AREA).astype(np.float64)
    return (f * u[..., None]).sum((0, 1)) / u.sum()


class ShiftTest(unittest.TestCase):
    def test_none_is_identity(self):
        rgb = colours()
        out = collage_lib.apply_shift(rgb, None)
        self.assertEqual(out.dtype, np.uint8)
        np.testing.assert_array_equal(out, rgb)

    def test_zero_offset_round_trip(self):
        rgb = colours()
        out = collage_lib.apply_shift(rgb, {"op": "lab_offset", "delta_lab": [0, 0, 0]})
        self.assertEqual(out.dtype, np.uint8)
        self.assertLessEqual(int(np.abs(out.astype(int) - rgb.astype(int)).max()), 1)

    def test_three_forms(self):
        rgb = colours()
        d = [-4.94, 14.49, 8.81]
        sheet = {"op": "lab_offset", "delta_lab": d, "toward_rgb": [170, 52, 29], "strength": 0.55,
                 "lightness_part": 0.6, "how": "..."}
        a = collage_lib.apply_shift(rgb, d)
        np.testing.assert_array_equal(a, collage_lib.apply_shift(rgb, sheet))
        np.testing.assert_array_equal(a, collage_lib.apply_shift(rgb, tuple(d)))
        self.assertGreater(int(np.abs(a.astype(int) - rgb.astype(int)).max()), 10)

    def test_unknown_op(self):
        with self.assertRaises(ValueError) as cm:
            collage_lib.apply_shift(colours(), {"op": "hue_rotate", "degrees": 30})
        self.assertIn("hue_rotate", str(cm.exception))

    def test_sheet_mean_colour(self):
        sheet = load_sheet(load_json("data/collage.json")["sheet"])
        shifted = [(b, c) for b in sheet["blocks"] for c in b["candidates"] if c.get("colour_shift")]
        self.assertGreater(len(shifted), 0)
        need_originals({collage_lib.ref_name(c["image"]) for _, c in shifted})
        ids = np.asarray(Image.open(os.path.join(ROOT, "assets", "regions_id.png"))).astype(np.int32)
        cache = {}
        for b, c in shifted:
            path = collage_lib.ref_path(c["image"])
            if path not in cache:
                cache[path] = np.asarray(Image.open(os.path.join(ROOT, path)).convert("RGB"))
            got = sheet_mean(cache[path], b["bbox"], c["crop"], c["rotation_deg"], c["colour_shift"], ids, b["leaves"])
            self.assertLessEqual(float(np.abs(got - np.array(c["mean_rgb"])).max()), 3.0,
                                 (b["name"], c["letter"], got.round(1).tolist(), c["mean_rgb"]))


# ---------------------------------------------------------------- other cuts

PW, PH = 2944, 1648


def synthetic(seed=7, w=PW, h=PH):
    """A picture with structure: smooth colour fields and fine noise."""
    rng = np.random.default_rng(seed)
    low = rng.integers(0, 256, (12, 20, 3)).astype(np.float32)
    big = cv2.resize(low, (w, h), interpolation=cv2.INTER_CUBIC)
    big += rng.normal(0, 12, (h, w, 3)).astype(np.float32)
    return np.clip(big, 0, 255).astype(np.uint8)


def two_colours():
    """The synthetic picture, reddish in its left half and bluish in its right half."""
    img = synthetic()
    img[:, :PW // 2] = np.clip(img[:, :PW // 2].astype(int) // 4 + [150, 30, 20], 0, 255)
    img[:, PW // 2:] = np.clip(img[:, PW // 2:].astype(int) // 4 + [20, 40, 150], 0, 255)
    return img


def iou(a, b):
    iw = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def share(rect, box, w=PW, h=PH):
    """Share of rect (px) inside box (0..1)."""
    x0, y0, x1, y1 = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    iw = max(0.0, min(rect[0] + rect[2], x1) - max(rect[0], x0))
    ih = max(0.0, min(rect[1] + rect[3], y1) - max(rect[1], y0))
    return iw * ih / (rect[2] * rect[3])


def corners(rect, tilt):
    return make_collage._corners(rect, tilt)


class OtherCutsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img = synthetic()
        cls.picked = [[1000.0, 400.0, 600.0, 450.0]]
        cls.size = (600.0, 450.0)
        cls.kw = dict(seed=11)
        cls.cuts = collage_lib.other_cuts(cls.img, cls.size, cls.picked, [], 12, **cls.kw)

    def test_shape(self):
        self.assertTrue(0 < len(self.cuts) <= 12, len(self.cuts))
        for c in self.cuts:
            self.assertEqual(set(c), {"rect", "tilt"})
            x, y, w, h = c["rect"]
            self.assertEqual((w, h), self.size)                 # the key image's scale: the size is fixed
            self.assertTrue(x >= 0 and y >= 0 and x + w <= PW and y + h <= PH, c)
            self.assertLessEqual(abs(c["tilt"]), 2.0)
            for px, py in corners(c["rect"], c["tilt"]):        # turned, it still lies in the picture
                self.assertTrue(0 <= px <= PW and 0 <= py <= PH, c)

    def test_apart(self):
        rects = self.picked + [c["rect"] for c in self.cuts]
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                self.assertLessEqual(iou(rects[i], rects[j]), 0.7, (rects[i], rects[j]))
                self.assertLessEqual(iou(rects[i], rects[j]), collage_lib.IOU_MAX + 1e-12)

    def test_taken(self):
        taken = [c["rect"] for c in self.cuts[:3]]
        more = collage_lib.other_cuts(self.img, self.size, self.picked, taken, 6, **self.kw)
        for c in more:
            for t in taken:
                self.assertLessEqual(iou(c["rect"], t), collage_lib.IOU_MAX + 1e-12)

    def test_avoid(self):
        cuts = collage_lib.other_cuts(self.img, self.size, self.picked, [], 12, avoid=[[0.0, 0.0, 0.5, 1.0]], **self.kw)
        self.assertGreater(len(cuts), 0)
        for c in cuts:
            self.assertLessEqual(share(c["rect"], [0.0, 0.0, 0.5, 1.0]), 0.12 + 1e-9, c)

    def test_within_and_keep_out(self):
        within = [0.1, 0.1, 0.9, 0.9]
        cuts = collage_lib.other_cuts(self.img, self.size, self.picked, [], 12, within=within,
                                      keep_out=[[0.45, 0.4, 0.55, 0.6]], **self.kw)
        self.assertGreater(len(cuts), 0)
        for c in cuts:
            self.assertAlmostEqual(share(c["rect"], within), 1.0, places=9)
            self.assertLessEqual(share(c["rect"], [0.45, 0.4, 0.55, 0.6]), 0.02 + 1e-9)
            for px, py in corners(c["rect"], c["tilt"]):
                self.assertTrue(0.1 * PW <= px <= 0.9 * PW and 0.1 * PH <= py <= 0.9 * PH, c)

    def test_nearest_colour_first(self):
        cuts = collage_lib.other_cuts(two_colours(), (500.0, 375.0), [[200.0, 300.0, 500.0, 375.0]], [], 3,
                                      colour_max=math.inf, seed=3)
        self.assertEqual(len(cuts), 3)
        for c in cuts:
            self.assertLess(c["rect"][0] + c["rect"][2], PW / 2 + 1, c)

    def test_colour_cap(self):
        cuts = collage_lib.other_cuts(two_colours(), (500.0, 375.0), [[200.0, 300.0, 500.0, 375.0]], [], 40,
                                      colour_max=15.0, seed=5)
        self.assertGreater(len(cuts), 2)
        for c in cuts:
            self.assertLessEqual(share(c["rect"], [0.5, 0.0, 1.0, 1.0]), 0.25, c)

    def test_detail_floor(self):
        img = synthetic()
        img[:, PW // 2:] = cv2.GaussianBlur(img[:, PW // 2:], (0, 0), 6)       # the right half out of focus
        kw = dict(seed=6, colour_max=math.inf)
        cuts = collage_lib.other_cuts(img, (500.0, 375.0), [[200.0, 300.0, 500.0, 375.0]], [], 40, detail_min=0.6, **kw)
        self.assertGreater(len(cuts), 2)
        for c in cuts:
            self.assertLessEqual(share(c["rect"], [0.5, 0.0, 1.0, 1.0]), 0.5, c)
        anywhere = collage_lib.other_cuts(img, (500.0, 375.0), [[200.0, 300.0, 500.0, 375.0]], [], 40, detail_min=0.0, **kw)
        self.assertTrue(any(share(c["rect"], [0.5, 0.0, 1.0, 1.0]) > 0.5 for c in anywhere))

    def test_same_twice(self):
        again = collage_lib.other_cuts(self.img, self.size, self.picked, [], 12, **self.kw)
        self.assertEqual(again, self.cuts)

    def test_other_cuts_may_be_fewer(self):
        # the cut is the whole picture: there is nowhere else to cut it
        cuts = collage_lib.other_cuts(self.img, (float(PW), float(PH)), [[0.0, 0.0, float(PW), float(PH)]], [], 5, seed=1)
        self.assertEqual(cuts, [])


# ---------------------------------------------------------------- tools/upscale_refs.py

def nearest2(rgb):
    return np.repeat(np.repeat(rgb, 2, axis=0), 2, axis=1)


class UpscaleRefsTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        rng = np.random.default_rng(3)
        self.key = upscale_refs.key_name()

        def png(rel):
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            Image.fromarray(rng.integers(0, 256, (24, 40, 3)).astype(np.uint8)).save(path)
        png("resources/midjourney_images/" + self.key)
        png("resources/midjourney_images/p/a.png")
        png("resources/midjourney_images/p/c.png")
        png("local-only/resources/midjourney_images/p/c.png")
        png("local-only/resources/midjourney_images/q/b.png")
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.root)

    def up(self, rgb):
        self.calls.append(rgb.shape)
        return nearest2(rgb)

    def test_both_roots_without_the_key_image(self):
        refs = upscale_refs.references(self.root)
        self.assertEqual(sorted(refs), ["p/a.png", "p/c.png", "q/b.png"])
        self.assertEqual(refs["p/c.png"], "resources/midjourney_images/p/c.png")          # the first root wins
        self.assertEqual(refs["q/b.png"], "local-only/resources/midjourney_images/q/b.png")

    def test_run_skip_and_log(self):
        lines = upscale_refs.run(self.root, upscaler=self.up, out=lambda s: None)
        self.assertEqual(len(lines), 3)
        for name in ("p/a.png", "p/c.png", "q/b.png"):
            with Image.open(os.path.join(self.root, collage_lib.upscaled_path(name))) as im:
                self.assertEqual(im.size, (80, 48))
        with open(os.path.join(self.root, upscale_refs.LOG), encoding="utf-8") as f:
            logged = f.read().splitlines()
        self.assertEqual(logged, lines)
        parts = lines[2].split("\t")
        self.assertEqual(parts[:3], ["3/3", "q/b.png", "80x48"])
        self.assertTrue(parts[3].startswith("mean ") and parts[4].startswith("p99_tile ") and parts[5].endswith(" s"), parts)
        self.assertEqual(float(parts[3].split()[1]), 0.0)                 # nearest 2x shrinks back exactly
        leftovers = [f for _, _, fs in os.walk(os.path.join(self.root, "local-only", "assets")) for f in fs if ".tmp" in f]
        self.assertEqual(leftovers, [])
        # run again: everything exists, nothing is upscaled
        self.calls.clear()
        self.assertEqual(upscale_refs.run(self.root, upscaler=self.up, out=lambda s: None), [])
        self.assertEqual(self.calls, [])

    def test_only(self):
        only = os.path.join(self.root, "collage.json")
        with open(only, "w", encoding="utf-8") as f:
            json.dump({"blocks": [{"images": [{"image": "local-only/resources/midjourney_images/q/b.png"}]}]}, f)
        lines = upscale_refs.run(self.root, only=only, upscaler=self.up, out=lambda s: None)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("1/1\tq/b.png\t"), lines[0])
        self.assertFalse(os.path.exists(os.path.join(self.root, collage_lib.upscaled_path("p/a.png"))))
        with open(only, "w", encoding="utf-8") as f:
            json.dump({"blocks": [{"images": [{"image": "resources/midjourney_images/p/none.png"}]}]}, f)
        with self.assertRaises(SystemExit) as cm:
            upscale_refs.run(self.root, only=only, upscaler=self.up, out=lambda s: None)
        self.assertIn("p/none.png", str(cm.exception))

    def test_nothing_half_written(self):
        def fails(rgb):
            raise RuntimeError("out of memory")
        with self.assertRaises(RuntimeError):
            upscale_refs.run(self.root, upscaler=fails, out=lambda s: None)
        made = [f for _, _, fs in os.walk(os.path.join(self.root, "local-only", "assets")) for f in fs]
        self.assertEqual(made, [])

    def test_unfaithful_upscale_is_not_kept(self):
        noise = lambda rgb: np.random.default_rng(0).integers(0, 256, (48, 80, 3)).astype(np.uint8)  # noqa: E731
        with self.assertRaises(SystemExit) as cm:
            upscale_refs.run(self.root, upscaler=noise, out=lambda s: None)
        self.assertIn("p/a.png", str(cm.exception))
        self.assertFalse(os.path.exists(os.path.join(self.root, collage_lib.upscaled_path("p/a.png"))))
        with open(os.path.join(self.root, upscale_refs.LOG), encoding="utf-8") as f:
            self.assertTrue(f.read().rstrip("\n").endswith("OVER LIMIT"))


# ---------------------------------------------------------------- baking

class BakeTest(unittest.TestCase):
    """make_collage.bake on a synthetic picture in a temporary root. A 1200 x 800 original (its 2x upscale a
    smooth enlargement) and one block of 412 x 206 source px: its box is exactly 540 x 270 px at 4K."""
    BBOX = [0.2, 0.3, 0.2 + 412 / 2944, 0.3 + 206 / 1648]
    LEAF = (589, 495, 1000, 700)         # the block's one leaf (id 7), picture px: the box ...
    NOTCH = (850, 600, 1000, 700)        # ... without its lower right corner
    SHIFT = [-6.0, 14.0, 9.0]

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp()
        cls.orig = {}
        for name, seed in (("x/a.png", 1), ("x/b.png", 2)):
            o = synthetic(seed, 1200, 800)
            o = cv2.GaussianBlur(o, (0, 0), 2)                  # smooth, so resampling methods agree
            cls.orig[name] = o
            for rel, px in ((collage_lib.REF_ROOTS[1] + "/" + name, o),
                            (collage_lib.upscaled_path(name), cv2.resize(o, (2400, 1600), interpolation=cv2.INTER_CUBIC))):
                path = os.path.join(cls.root, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                Image.fromarray(px).save(path, compress_level=1)
        ids = np.zeros((1648, 2944), np.uint16)
        x0, y0, x1, y1 = cls.LEAF
        ids[y0:y1, x0:x1] = 7
        x0, y0, x1, y1 = cls.NOTCH
        ids[y0:y1, x0:x1] = 0
        os.makedirs(os.path.join(cls.root, "assets"), exist_ok=True)
        Image.fromarray(ids).save(os.path.join(cls.root, "assets", "regions_id.png"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root)

    def setUp(self):
        shutil.rmtree(os.path.join(self.root, "assets", "collage"), ignore_errors=True)
        bw, bh, m = collage_lib.box_and_margin(self.BBOX)
        self.assertEqual((bw, bh), (540, 270))
        src = collage_lib.REF_ROOTS[1] + "/x/"
        cuts = [("a.png", [300.0, 200.0, 412.0, 206.0], None), ("b.png", [500.0, 300.0, 412.0, 206.0], self.SHIFT),
                ("a.png", [700.0, 500.0, 412.0, 206.0], None)]
        self.manifest = {"regions": "0123456789abcdef", "scale": 1.31068, "look": {}, "blocks": [{
            "name": "t", "leaves": [7], "bbox": self.BBOX, "box": [bw, bh], "margin": m, "n": 2, "accent": -1,
            "cuts": [{"file": make_collage.cut_file(0, k), "tilt": 0.0, "src": src + f, "rect": r, "shift": s}
                     for k, (f, r, s) in enumerate(cuts)]}]}
        self.m = m

    def baked(self, k):
        with Image.open(os.path.join(self.root, "assets", "collage", "b00_%03d.webp" % k)) as im:
            return np.asarray(im.convert("RGB"))

    def reference(self, name, rect):
        """The upscale's region under the cut, reduced to the box (540 x 270)."""
        up = cv2.resize(self.orig[name], (2400, 1600), interpolation=cv2.INTER_CUBIC)
        x, y, w, h = (int(v * 2) for v in rect)
        return cv2.resize(up[y:y + h, x:x + w], (540, 270), interpolation=cv2.INTER_AREA).astype(np.float64)

    def inside(self):
        with Image.open(os.path.join(self.root, "assets", "regions_id.png")) as im:
            ids = np.asarray(im).astype(np.int32)
        return collage_lib.baked_inside(ids, [7], self.BBOX, (540, 270), self.m)

    def kept_centre(self):
        """The box's pixels the bake keeps (within the margin of the leaf), as a mask of the centre."""
        dist = cv2.distanceTransform((~self.inside()).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        m = self.m
        return (dist <= m)[m:m + 270, m:m + 540]

    def assertCentre(self, k, want):
        m = self.m
        got = self.baked(k)[m:m + 270, m:m + 540].astype(np.float64)
        keep = self.kept_centre()
        self.assertGreater(keep.mean(), 0.8)
        self.assertLessEqual(np.abs(got - want)[keep].mean(), 1.0)
        return got, keep

    def test_size_centre_shift_and_far_corner(self):
        r = make_collage.bake(self.manifest, self.root, everything=True)
        self.assertEqual(sorted(r["baked"]), ["b00_000.webp", "b00_001.webp", "b00_002.webp"])
        m = self.m
        for k in range(3):
            self.assertEqual(self.baked(k).shape, (270 + 2 * m, 540 + 2 * m, 3))
        self.assertCentre(0, self.reference("x/a.png", [300, 200, 412, 206]))
        # the colour shift is baked in
        plain = self.reference("x/b.png", [500, 300, 412, 206])
        got, keep = self.assertCentre(1, collage_lib.apply_shift(plain.round().astype(np.uint8), self.SHIFT).astype(np.float64))
        self.assertGreater(np.abs(got - plain)[keep].mean(), 5.0)
        # far from the leaf (the corners, deep in the notch): the mean colour of the pixels on the leaf;
        # near it: the picture
        inside = self.inside()
        px = self.baked(1)
        mean = np.rint(px[inside].mean(axis=0))
        notch = (m + round((995 - 588.8) * collage_lib.PX4K), m + round((695 - 494.4) * collage_lib.PX4K))
        for y, x in ((0, 0), (px.shape[0] - 1, px.shape[1] - 1), (0, px.shape[1] - 1), (notch[1], notch[0])):
            np.testing.assert_allclose(px[y, x], mean, atol=1, err_msg=str((y, x)))
        self.assertTrue(np.abs(px[m + 5:m + 15, m + 5:m + 15].astype(float) - mean).max() > 3)

    def test_only_changed_cuts_bake_again(self):
        make_collage.bake(self.manifest, self.root, everything=True)
        self.manifest["blocks"][0]["cuts"][2]["rect"] = [650.0, 480.0, 412.0, 206.0]
        r = make_collage.bake(self.manifest, self.root, everything=True)
        self.assertEqual(r["baked"], ["b00_002.webp"])
        self.assertEqual(sorted(r["kept"]), ["b00_000.webp", "b00_001.webp"])
        self.assertCentre(2, self.reference("x/a.png", [650, 480, 412, 206]))

    def test_unused_files_go(self):
        make_collage.bake(self.manifest, self.root, everything=True)
        r = make_collage.bake(self.manifest, self.root)             # no score: the picked cuts only
        self.assertEqual(r["removed"], ["b00_002.webp"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "assets", "collage"))),
                         ["b00_000.webp", "b00_001.webp", "baked.json"])
        with open(os.path.join(self.root, "assets", "collage", "baked.json"), encoding="utf-8") as f:
            self.assertEqual(sorted(json.load(f)), ["b00_000.webp", "b00_001.webp"])

    def test_check(self):
        make_collage.bake(self.manifest, self.root)
        self.assertEqual(make_collage.check(self.manifest, self.root), [])
        # a stale key: the file was made from another cut
        path = os.path.join(self.root, "assets", "collage", "baked.json")
        with open(path, encoding="utf-8") as f:
            baked = json.load(f)
        baked["b00_001.webp"] = "0" * 40
        with open(path, "w", encoding="utf-8") as f:
            json.dump(baked, f)
        p = make_collage.check(self.manifest, self.root)
        self.assertTrue(len(p) == 1 and "b00_001.webp" in p[0] and "stale" in p[0], p)
        # a cut changed in the list after baking is stale too
        make_collage.bake(self.manifest, self.root)
        self.manifest["blocks"][0]["cuts"][0]["shift"] = [1.0, 2.0, 3.0]
        p = make_collage.check(self.manifest, self.root)
        self.assertTrue(len(p) == 1 and "b00_000.webp" in p[0] and "stale" in p[0], p)
        # wrong size, missing
        Image.new("RGB", (10, 10)).save(os.path.join(self.root, "assets", "collage", "b00_001.webp"), lossless=True)
        os.remove(os.path.join(self.root, "assets", "collage", "b00_000.webp"))
        p = make_collage.check(self.manifest, self.root)
        self.assertTrue(any("b00_000.webp" in s and "missing" in s for s in p), p)
        self.assertTrue(any("b00_001.webp" in s and "10x10" in s for s in p), p)

    def test_score_decides(self):
        score = {"collage": {"changes": {"calm": {"start": [0], "events": [{"t": 20.0, "note": 3, "block": 0, "to": 2}]},
                                         "high": {"start": [1], "events": []}}}}
        self.assertEqual(make_collage.used_cuts(self.manifest, score), [(0, 0), (0, 1), (0, 2)])
        self.assertEqual(make_collage.used_cuts(self.manifest, {"collage": {"changes": {"mid": {"start": [2], "events": []}}}}), [(0, 2)])
        self.assertEqual(make_collage.used_cuts(self.manifest, None), [(0, 0), (0, 1)])
        with self.assertRaises(SystemExit):
            make_collage.used_cuts(self.manifest, {"collage": {"changes": {"mid": {"start": [3], "events": []}}}})

    def test_missing_sources(self):
        up = os.path.join(self.root, collage_lib.upscaled_path("x/b.png"))
        os.rename(up, up + ".away")
        try:
            with self.assertRaises(SystemExit) as cm:
                make_collage.bake(self.manifest, self.root, everything=True)
            self.assertIn("x/b.png", str(cm.exception))
            self.assertIn(collage_lib.upscaled_path("x/b.png"), str(cm.exception))
            # the others are baked all the same; nothing is left for the missing one
            names = sorted(os.listdir(os.path.join(self.root, "assets", "collage")))
            self.assertEqual(names, ["b00_000.webp", "b00_002.webp", "baked.json"])
        finally:
            os.rename(up + ".away", up)
        shutil.rmtree(os.path.join(self.root, "assets", "collage"))    # nothing baked: a.png's cuts must be read
        orig = os.path.join(self.root, collage_lib.REF_ROOTS[1], "x", "a.png")
        os.rename(orig, orig + ".away")
        try:
            with self.assertRaises(SystemExit) as cm:
                make_collage.bake(self.manifest, self.root, everything=True)
            for r in collage_lib.REF_ROOTS:
                self.assertIn(r + "/x/a.png", str(cm.exception))
        finally:
            os.rename(orig + ".away", orig)

    def test_stale_file_goes_when_it_cannot_bake_again(self):
        make_collage.bake(self.manifest, self.root, everything=True)
        self.manifest["blocks"][0]["cuts"][1]["rect"] = [520.0, 300.0, 412.0, 206.0]
        up = os.path.join(self.root, collage_lib.upscaled_path("x/b.png"))
        os.rename(up, up + ".away")
        try:
            with self.assertRaises(SystemExit):
                make_collage.bake(self.manifest, self.root, everything=True)
        finally:
            os.rename(up + ".away", up)
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets", "collage", "b00_001.webp")))
        self.assertTrue(any("b00_001.webp" in s and "missing" in s
                            for s in make_collage.check(self.manifest, self.root)))


class MakeCollageArgsTest(unittest.TestCase):
    """Option mistakes stop before anything is read, built, baked or checked (argparse: exit 2)."""

    def stops(self, argv, word):
        err = io.StringIO()
        with mock.patch.object(make_collage, "_build", side_effect=AssertionError("built the list")), \
                mock.patch.object(make_collage, "bake", side_effect=AssertionError("baked")), \
                mock.patch.object(make_collage, "check", side_effect=AssertionError("checked")), \
                contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as cm:
                make_collage.main(argv)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn(word, err.getvalue())

    def test_all_needs_bake(self):
        self.stops(["--all"], "--all")

    def test_bake_and_check_are_separate_runs(self):
        self.stops(["--bake", "--check"], "--check")
        self.stops(["--bake", "--all", "--check"], "--check")


class ManifestKeyTest(unittest.TestCase):
    """Each cut of the committed list carries its bake key (the page compares it with baked.json); the
    key is not one of its own inputs, so adding it leaves every baked file current. Needs no originals."""

    @classmethod
    def setUpClass(cls):
        cls.man = load_json("assets/collage.json")

    def test_every_cut_carries_its_bake_key(self):
        for row, b in enumerate(self.man["blocks"]):
            for k, c in enumerate(b["cuts"]):
                self.assertEqual(c.get("key"), make_collage.bake_key(self.man, row, k), (b["name"], k))

    def test_the_key_is_not_its_own_input(self):
        man = json.loads(json.dumps(self.man))
        before = make_collage.bake_key(man, 0, 0)
        man["blocks"][0]["cuts"][0]["key"] = "0" * 40
        self.assertEqual(make_collage.bake_key(man, 0, 0), before)


# ---------------------------------------------------------------- the list (real data)

class ManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load_json("data/collage.json")
        cls.regions = load_json("assets/regions.json")
        cls.sources = make_collage.load_sources()
        need_originals({collage_lib.ref_name(im["image"]) for b in cls.data["blocks"] for im in b["images"]})
        cls.man = make_collage.build_manifest()
        with open(os.path.join(ROOT, "assets", "collage.json"), "rb") as f:
            cls.committed = f.read()

    def test_committed_bytes(self):
        self.assertEqual(self.committed, make_collage.dumps(self.man).encode("utf-8"))
        self.assertEqual(json.loads(self.committed.decode("utf-8")), self.man)
        self.assertEqual(self.man["regions"], self.regions["fingerprint"])
        self.assertEqual(self.man["look"], self.data["look"])
        self.assertEqual(self.man["scale"], 1.31068)

    def test_picked_cuts(self):
        self.assertEqual(make_collage.CUTS_MAX, 48)
        self.assertEqual(len(self.man["blocks"]), len(self.data["blocks"]))
        for mb, db in zip(self.man["blocks"], self.data["blocks"]):
            self.assertEqual((mb["name"], mb["leaves"], mb["bbox"]), (db["name"], db["leaves"], db["bbox"]))
            self.assertEqual(mb["n"], len(db["images"]))
            self.assertEqual(mb["accent"], db["accent"])
            self.assertLessEqual(len(mb["cuts"]), make_collage.CUTS_MAX)
            for cut, im in zip(mb["cuts"], db["images"]):
                self.assertEqual(cut["src"], im["image"])
                self.assertEqual(cut["rect"], im["crop"])
                self.assertEqual(cut["tilt"], im["tilt"])
                self.assertEqual(cut["shift"], im["shift"]["delta_lab"] if im["shift"] else None)

    def test_box_and_margin(self):
        for mb in self.man["blocks"]:
            x0, y0, x1, y1 = mb["bbox"]
            bw = math.ceil(round((x1 - x0) * 2944 * 2160 / 1648, 6))
            bh = math.ceil(round((y1 - y0) * 1648 * 2160 / 1648, 6))
            self.assertEqual(mb["box"], [bw, bh], mb["name"])
            self.assertEqual(mb["margin"], math.ceil(0.5 * math.hypot(bw, bh) * math.sin(math.radians(2))) + 8)

    def test_scale(self):
        # the width against the (rounded-up) box, as the amendment states it; the height against the
        # block's exact height in picture px (rounding a 145 px box up alone is 0.6 %)
        for mb in self.man["blocks"]:
            bh = (mb["bbox"][3] - mb["bbox"][1]) * 1648
            for c in mb["cuts"]:
                self.assertAlmostEqual(c["rect"][2] / (mb["box"][0] / collage_lib.SCALE), 1.0, delta=0.005, msg=mb["name"])
                self.assertAlmostEqual(c["rect"][3] / bh, 1.0, delta=0.005, msg=mb["name"])

    def test_other_cuts(self):
        for row, mb in enumerate(self.man["blocks"]):
            n, cuts = mb["n"], mb["cuts"]
            picked = {(c["src"], json.dumps(c["shift"])) for c in cuts[:n]}
            accent_src = cuts[mb["accent"]]["src"] if mb["accent"] >= 0 else None
            seen = set()
            for k, c in enumerate(cuts):
                self.assertEqual(set(c), {"file", "tilt", "src", "rect", "shift", "key"})
                self.assertEqual(c["key"], make_collage.bake_key(self.man, row, k), (mb["name"], k))
                self.assertEqual(c["file"], "collage/b%02d_%03d.webp" % (row, k))
                key = (c["src"], tuple(c["rect"]))
                self.assertNotIn(key, seen, (mb["name"], k))
                seen.add(key)
                if k < n:
                    continue
                self.assertIn((c["src"], json.dumps(c["shift"])), picked, (mb["name"], k))
                self.assertNotEqual(c["src"], accent_src, (mb["name"], k))
                self.assertLessEqual(abs(c["tilt"]), 2.0)
                for px, py in corners(c["rect"], c["tilt"]):
                    self.assertTrue(0 <= px <= 2944 and 0 <= py <= 1648, (mb["name"], k))
                for j in range(k):
                    if cuts[j]["src"] == c["src"]:
                        self.assertLessEqual(iou(c["rect"], cuts[j]["rect"]), collage_lib.IOU_MAX + 1e-12, (mb["name"], j, k))

    def test_other_cuts_stay_out_of_the_hand_areas(self):
        conf = self.sources
        for mb in self.man["blocks"]:
            for c in mb["cuts"][mb["n"]:]:
                e = conf["images"].get(collage_lib.ref_name(c["src"]))
                if not e:
                    continue
                r = c["rect"]
                self.assertLessEqual(sum(share(r, box) for box in e["avoid"]), conf["avoid_max"] + 1e-9, (mb["name"], r))
                self.assertLessEqual(sum(share(r, box) for box in e["keep_out"]), conf["keep_out_max"] + 1e-9, (mb["name"], r))
                if e["within"]:
                    self.assertAlmostEqual(share(r, e["within"]), 1.0, places=9)

    def test_sources_file(self):
        # keyed by <folder>/<file>; every used image the v3 sheet had areas for is listed (the 34 of 2026-11-17)
        for name in self.sources["images"]:
            self.assertEqual(collage_lib.ref_name(name), name)
        used = {collage_lib.ref_name(c["src"]) for mb in self.man["blocks"] for c in mb["cuts"]}
        self.assertGreaterEqual(len(used & set(self.sources["images"])), 34)


class BakedTest(unittest.TestCase):
    """The committed baked cuts (assets/collage/), seen as `make_collage.py --check` sees them: every cut the
    score's three schedules use has its file, of the right size, made from that cut. A clone without the
    files fails here; only the public tree (PUBLIC_TREE at its root), which has no originals, skips, and
    WebSetTest checks its pieces."""
    ROOT = ROOT

    @classmethod
    def setUpClass(cls):
        if public_tree.is_public_tree(cls.ROOT):
            raise unittest.SkipTest("the public tree (%s at its root) has no original pieces (%s/); its web set is "
                                    "checked by WebSetTest" % (PUBLIC_TREE, make_collage.OUT_DIR))
        cls.manifest = make_collage._committed(cls.ROOT)
        cls.score = make_collage._score(cls.ROOT)
        cls.used = make_collage.used_cuts(cls.manifest, cls.score)

    def test_schedules_use_cuts(self):
        self.assertIsNotNone(self.score)
        self.assertGreater(len(self.used), 0)

    def test_every_used_cut_is_baked_and_current(self):
        self.assertEqual(make_collage.check(self.manifest, self.ROOT, self.score), [])

    def test_files_are_the_used_cuts_and_the_record(self):
        folder = os.path.join(self.ROOT, make_collage.OUT_DIR)
        names = {os.path.basename(self.manifest["blocks"][r]["cuts"][k]["file"]) for r, k in self.used}
        self.assertEqual(len(names), len(self.used))
        self.assertTrue(os.path.isdir(folder), "%s is missing" % folder)
        self.assertEqual(set(os.listdir(folder)), names | {"baked.json"})
        self.assertEqual(set(make_collage._load_baked(self.ROOT)), names)

    def test_every_file_is_under_95_mb(self):
        """tools/README.md: no file of the repository is over 95 MB (the baked cuts are committed)."""
        folder = os.path.join(self.ROOT, make_collage.OUT_DIR)
        files = [os.path.join(d, f) for d, _, fs in os.walk(folder) for f in fs]
        self.assertGreater(len(files), 0)
        for path in files:
            self.assertLess(os.path.getsize(path), 95 * 1000 * 1000, path)


class BakedSkipTest(unittest.TestCase):
    """BakedTest skips in the public tree only: anywhere else a tree without the originals fails it."""

    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root)

    def baked_test(self):
        return type("Baked", (BakedTest,), {"ROOT": self.root})

    def test_skips_with_the_public_trees_mark(self):
        touch(self.root, PUBLIC_TREE, b"")
        with self.assertRaises(unittest.SkipTest) as cm:
            self.baked_test().setUpClass()
        self.assertIn(PUBLIC_TREE, str(cm.exception))

    def test_fails_without_it(self):
        with self.assertRaises(Exception) as cm:
            self.baked_test().setUpClass()
        self.assertNotIsInstance(cm.exception, unittest.SkipTest)

    def test_this_repository_is_not_the_public_tree(self):
        self.assertFalse(os.path.exists(os.path.join(ROOT, PUBLIC_TREE)) and os.path.isdir(os.path.join(ROOT, make_collage.OUT_DIR)),
                         "%s and %s/ together: the private repository marked as the public tree" % (PUBLIC_TREE, make_collage.OUT_DIR))


class WebSetTest(unittest.TestCase):
    """The committed web set (assets/collage-web/, tools/make_collage_web.py): a JPEG for every cut the score's
    three schedules use, listed in web.json with that cut's bake key (the list's "key", which the page
    compares) and its scale: 1, the original's size, for the pieces data/collage_full_size.json names (those
    drawn while the camera is pushed in after the strike; tools/full_size_pieces.mjs), 0.5, half of it, for
    every other; nothing else, 40 MiB at most in all; and make_collage_web.py --check. Runs in the public tree
    too: it needs no originals."""

    @classmethod
    def setUpClass(cls):
        cls.manifest = make_collage._committed(ROOT)
        cls.used = make_collage.used_cuts(cls.manifest, make_collage._score(ROOT))
        cls.folder = os.path.join(ROOT, *make_collage_web.WEB_DIR.split("/"))
        cls.list = load_json(make_collage_web.WEB_LIST)
        cls.full = set(load_json(make_collage_web.FULL_LIST)["pieces"])

    def test_check(self):
        self.assertEqual(make_collage_web.check(ROOT), [])

    def test_a_current_piece_for_every_used_cut_and_nothing_else(self):
        want = {}
        for r, k in self.used:
            b = self.manifest["blocks"][r]
            c = b["cuts"][k]
            name = os.path.basename(c["file"])
            scale = 1 if name in self.full else 0.5
            w, h = make_collage_web.at_scale((b["box"][0] + 2 * b["margin"], b["box"][1] + 2 * b["margin"]), scale)
            want[make_collage_web.web_name(name)] = {"key": c["key"], "scale": scale, "w": w, "h": h}
        self.assertGreater(len(want), 0)
        self.assertEqual(self.list["cuts"], want)
        self.assertEqual(set(os.listdir(self.folder)), set(want) | {"web.json"})

    def test_the_full_size_pieces_are_the_punch_ins_few(self):
        """The full-size list names pieces the score uses, a few of them (83 of 606 on 2026-11-20): the set stays
        mostly half size."""
        used = {os.path.basename(self.manifest["blocks"][r]["cuts"][k]["file"]) for r, k in self.used}
        self.assertTrue(self.full <= used, sorted(self.full - used))
        self.assertGreater(len(self.full), 0)
        self.assertLess(len(self.full), len(used) / 4)

    def test_under_40_mib(self):
        sizes = [os.path.getsize(os.path.join(self.folder, n)) for n in self.list["cuts"]]
        self.assertEqual(len(sizes), len(self.used))
        self.assertLess(sum(sizes), 40 * 2 ** 20)


if __name__ == "__main__":
    unittest.main()

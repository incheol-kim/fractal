"""tools/make_collage_web.py on a few small pictures in a temporary root (no real data: see WebSetTest in
tools/test_collage.py for the committed set)."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import make_collage_web as web  # noqa: E402

# (name, width, height): odd sides whose half ends in .5 (Python's round() would go to the even number), an
# even one, and a side of 1
PIECES = (("b00_000.webp", 101, 57), ("b00_001.webp", 64, 40), ("b01_000.webp", 3, 1))


def picture(w, h, seed):
    """A smooth picture with some fine structure, RGB."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    base = np.stack([128 + 90 * np.sin(x / 9.0 + seed), 128 + 90 * np.cos(y / 7.0), 128 + 60 * np.sin((x + y) / 11.0)], axis=2)
    return np.clip(base + rng.normal(0, 4, (h, w, 3)), 0, 255).astype(np.uint8)


def jpeg_markers(data):
    """The markers of a JPEG file from SOI to SOS -> [(marker byte, segment bytes)]."""
    assert data[:2] == b"\xff\xd8", "not a JPEG (no SOI)"
    out, i = [], 2
    while i < len(data):
        assert data[i] == 0xFF, "no marker at %d" % i
        m = data[i + 1]
        n = int.from_bytes(data[i + 2:i + 4], "big")
        out.append((m, data[i + 4:i + 2 + n]))
        if m == 0xDA:  # SOS: the picture's data follows
            break
        i += 2 + n
    return out


class WebSetCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.orig = {}
        baked = {}
        os.makedirs(os.path.join(self.root, "assets", "collage"))
        for k, (name, w, h) in enumerate(PIECES):
            px = picture(w, h, k + 1)
            self.orig[name] = px
            Image.fromarray(px).save(os.path.join(self.root, "assets", "collage", name), format="WEBP", lossless=True)
            baked[name] = "%040x" % (k + 1)
        self.write_json("assets/collage/baked.json", baked)
        # the inputs of the full-size list (tools/full_size_pieces.mjs), and the list: no piece at full size
        self.write_json("assets/score.json", {"score": 1})
        self.write_json("assets/collage.json", {"collage": 1})
        self.write_list([])

    def tearDown(self):
        shutil.rmtree(self.root)

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def write_json(self, rel, obj):
        os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
        with open(self.path(rel), "w", encoding="utf-8", newline="\n") as f:
            json.dump(obj, f)

    def write_list(self, pieces, inputs=None):
        """data/collage_full_size.json naming these originals, made from the current inputs (or `inputs`)."""
        self.write_json(web.FULL_LIST, {"zoom": 1.2, "inputs": inputs or web.list_inputs(self.root), "pieces": pieces})

    def read_json(self, rel):
        with open(self.path(rel), encoding="utf-8") as f:
            return json.load(f)

    def read(self, rel):
        with open(self.path(rel), "rb") as f:
            return f.read()

    def make(self):
        return web.make(self.root, out=lambda s: None)


class HalfTest(unittest.TestCase):
    def test_rounds_half_up_like_the_page(self):
        # the page's Math.max(1, Math.round(n / 2)): .5 goes up (Python's round() would give 28, 50 and 0)
        self.assertEqual([web.half(n) for n in (57, 101, 1, 2, 3, 64, 2024, 1174, 169)],
                         [29, 51, 1, 1, 2, 32, 1012, 587, 85])

    def test_web_name(self):
        self.assertEqual(web.web_name("b00_001.webp"), "b00_001.jpg")


class MakeTest(WebSetCase):
    def test_half_size_jpeg_444_no_metadata(self):
        r = self.make()
        self.assertEqual(r["made"], ["b00_000.jpg", "b00_001.jpg", "b01_000.jpg"])
        for name, w, h in PIECES:
            data = self.read("assets/collage-web/" + web.web_name(name))
            with Image.open(io.BytesIO(data)) as im:
                self.assertEqual(im.format, "JPEG")
                self.assertEqual(im.mode, "RGB")
                self.assertEqual(im.size, (web.half(w), web.half(h)), name)
                for k in ("exif", "icc_profile", "xmp", "comment", "photoshop"):
                    self.assertNotIn(k, im.info, (name, k))
            marks = jpeg_markers(data)
            kinds = [m for m, _ in marks]
            # SOI, the JFIF header, tables, the frame and the scan; no EXIF/XMP (APP1), ICC (APP2), comment
            # (COM) or any other APPn
            self.assertEqual([m for m in kinds if 0xE0 <= m <= 0xEF or m == 0xFE], [0xE0], (name, kinds))
            self.assertTrue(dict(marks)[0xE0].startswith(b"JFIF\x00"), name)
            sof = dict(marks)[0xC0]  # baseline
            comps = sof[5]
            self.assertEqual(comps, 3)
            self.assertEqual([sof[6 + 3 * c + 1] for c in range(comps)], [0x11, 0x11, 0x11], name)  # 4:4:4

    def test_lanczos_half_of_the_original(self):
        # stripes 3 px wide: the filters differ by far more than JPEG's loss (Lanczos ~2.4, bicubic ~6, box ~13)
        h, w = 57, 101
        y, x = np.mgrid[0:h, 0:w]
        px = np.stack([np.where((x // 3) % 2 == 0, 220, 40), np.where((y // 3) % 2 == 0, 200, 60), (2 * x + y) % 256], axis=2).astype(np.uint8)
        src = Image.fromarray(px)
        src.save(self.path("assets/collage/b00_000.webp"), format="WEBP", lossless=True)
        self.make()
        with Image.open(self.path("assets/collage-web/b00_000.jpg")) as im:
            got = np.asarray(im).astype(float)
        size = (web.half(w), web.half(h))
        diff = {f: np.abs(got - np.asarray(src.resize(size, getattr(Image.Resampling, f))).astype(float)).mean()
                for f in ("LANCZOS", "BICUBIC", "HAMMING", "BILINEAR", "BOX", "NEAREST")}
        self.assertLess(diff["LANCZOS"], 3.0, diff)
        self.assertLess(diff["LANCZOS"] * 2, min(v for f, v in diff.items() if f != "LANCZOS"), diff)

    def test_list(self):
        self.make()
        lst = self.read_json("assets/collage-web/web.json")
        self.assertEqual(lst["scale"], 0.5)
        self.assertEqual(lst["quality"], 90)
        baked = self.read_json("assets/collage/baked.json")
        self.assertEqual(sorted(lst["cuts"]), ["b00_000.jpg", "b00_001.jpg", "b01_000.jpg"])
        for name, w, h in PIECES:
            self.assertEqual(lst["cuts"][web.web_name(name)], {"key": baked[name], "scale": 0.5, "w": web.half(w), "h": web.half(h)})
        self.assertEqual(self.read_json("assets/pieces.json"), {"sets": ["full", "web"]})
        self.assertEqual(sorted(os.listdir(self.path("assets/collage-web"))), ["b00_000.jpg", "b00_001.jpg", "b01_000.jpg", "web.json"])

    def test_same_bytes_twice(self):
        self.make()
        first = {n: self.read("assets/collage-web/" + n) for n in os.listdir(self.path("assets/collage-web"))}
        shutil.rmtree(self.path("assets/collage-web"))
        os.remove(self.path("assets/pieces.json"))
        self.make()
        again = {n: self.read("assets/collage-web/" + n) for n in os.listdir(self.path("assets/collage-web"))}
        self.assertEqual(sorted(first), sorted(again))
        for n in first:
            self.assertEqual(first[n], again[n], n)

    def test_only_a_changed_key_is_made_again(self):
        self.make()
        mtime = {n: os.stat(self.path("assets/collage-web/" + n)).st_mtime_ns for n in ("b00_000.jpg", "b01_000.jpg")}
        baked = self.read_json("assets/collage/baked.json")
        baked["b00_001.webp"] = "f" * 40
        self.write_json("assets/collage/baked.json", baked)
        r = self.make()
        self.assertEqual(r["made"], ["b00_001.jpg"])
        self.assertEqual(r["kept"], ["b00_000.jpg", "b01_000.jpg"])
        self.assertEqual(self.read_json("assets/collage-web/web.json")["cuts"]["b00_001.jpg"]["key"], "f" * 40)
        for n, t in mtime.items():
            self.assertEqual(os.stat(self.path("assets/collage-web/" + n)).st_mtime_ns, t, n)
        self.assertEqual(self.make()["made"], [])

    def test_left_over_pieces_go(self):
        self.make()
        baked = self.read_json("assets/collage/baked.json")
        del baked["b01_000.webp"]
        self.write_json("assets/collage/baked.json", baked)
        os.remove(self.path("assets/collage/b01_000.webp"))
        with open(self.path("assets/collage-web/stray.jpg"), "wb") as f:
            f.write(b"x")
        r = self.make()
        self.assertEqual(r["made"], [])
        self.assertEqual(r["removed"], ["b01_000.jpg", "stray.jpg"])
        self.assertEqual(sorted(self.read_json("assets/collage-web/web.json")["cuts"]), ["b00_000.jpg", "b00_001.jpg"])
        self.assertEqual(web.check(self.root), [])

    def test_no_originals_stops(self):
        shutil.rmtree(self.path("assets/collage"))
        with self.assertRaises(SystemExit) as cm:
            self.make()
        self.assertIn("assets/collage/baked.json", str(cm.exception))
        self.assertFalse(os.path.exists(self.path("assets/collage-web")))

    def test_an_original_baked_json_lists_but_is_not_there_stops(self):
        os.remove(self.path("assets/collage/b00_001.webp"))
        with self.assertRaises(SystemExit) as cm:
            self.make()
        self.assertIn("b00_001.webp", str(cm.exception))
        self.assertFalse(os.path.exists(self.path("assets/collage-web")))

    def test_full_size_pieces(self):
        """A piece the full-size list names is the original's size (no resampling), the same JPEG settings; the
        others are half size."""
        # b00_000: stripes 3 px wide, where any resampling there and back differs by far more than JPEG's loss
        y, x = np.mgrid[0:57, 0:101]
        stripes = np.stack([np.where((x // 3) % 2 == 0, 220, 40), np.where((y // 3) % 2 == 0, 200, 60), (2 * x + y) % 256], axis=2).astype(np.uint8)
        Image.fromarray(stripes).save(self.path("assets/collage/b00_000.webp"), format="WEBP", lossless=True)
        self.orig["b00_000.webp"] = stripes
        self.write_list(["b00_000.webp"])
        self.make()
        lst = self.read_json("assets/collage-web/web.json")
        self.assertEqual(lst["scale"], 0.5)
        for name, w, h in PIECES:
            e = lst["cuts"][web.web_name(name)]
            full = name == "b00_000.webp"
            self.assertEqual(e["scale"], 1 if full else 0.5, name)
            want = (w, h) if full else (web.half(w), web.half(h))
            self.assertEqual((e["w"], e["h"]), want, name)
            data = self.read("assets/collage-web/" + web.web_name(name))
            with Image.open(io.BytesIO(data)) as im:
                self.assertEqual((im.format, im.mode, im.size), ("JPEG", "RGB", want), name)
                self.assertNotIn("exif", im.info)
                if full:
                    got = np.asarray(im).astype(float)
            sof = dict(jpeg_markers(data))[0xC0]
            self.assertEqual([sof[6 + 3 * c + 1] for c in range(3)], [0x11, 0x11, 0x11], name)
        # the original's pixels, with JPEG's loss only (no resampling): far nearer than the half size and back
        orig = self.orig["b00_000.webp"]
        there_and_back = np.asarray(Image.fromarray(orig).resize((51, 29), Image.Resampling.LANCZOS).resize((101, 57), Image.Resampling.LANCZOS)).astype(float)
        jpeg_loss = np.abs(got - orig.astype(float)).mean()
        self.assertLess(jpeg_loss, 3.0)
        self.assertLess(jpeg_loss * 5, np.abs(there_and_back - orig.astype(float)).mean())
        self.assertEqual(web.check(self.root), [])

    def test_only_a_piece_whose_scale_changed_is_made_again(self):
        self.make()
        mtime = {n: os.stat(self.path("assets/collage-web/" + n)).st_mtime_ns for n in ("b00_000.jpg", "b01_000.jpg")}
        self.write_list(["b00_001.webp"])
        r = self.make()
        self.assertEqual(r["made"], ["b00_001.jpg"])
        self.assertEqual(r["kept"], ["b00_000.jpg", "b01_000.jpg"])
        self.assertEqual(self.read_json("assets/collage-web/web.json")["cuts"]["b00_001.jpg"]["scale"], 1)
        for n, t in mtime.items():
            self.assertEqual(os.stat(self.path("assets/collage-web/" + n)).st_mtime_ns, t, n)
        self.write_list([])
        self.assertEqual(self.make()["made"], ["b00_001.jpg"])
        self.assertEqual(self.read_json("assets/collage-web/web.json")["cuts"]["b00_001.jpg"]["scale"], 0.5)

    def test_without_the_full_size_list_stops(self):
        os.remove(self.path(web.FULL_LIST))
        with self.assertRaises(SystemExit) as cm:
            self.make()
        self.assertIn(web.FULL_LIST, str(cm.exception))
        self.assertIn("full_size_pieces.mjs", str(cm.exception))

    def test_a_stale_full_size_list_stops(self):
        self.write_json("assets/score.json", {"score": 2})
        with self.assertRaises(SystemExit) as cm:
            self.make()
        self.assertIn("assets/score.json", str(cm.exception))
        self.assertIn("full_size_pieces.mjs", str(cm.exception))


class CheckTest(WebSetCase):
    def setUp(self):
        super().setUp()
        self.make()

    def assertProblem(self, *words):
        p = web.check(self.root)
        self.assertTrue(any(all(w in s for w in words) for s in p), p)
        return p

    def test_passes(self):
        self.assertEqual(web.check(self.root), [])

    def test_missing_file(self):
        os.remove(self.path("assets/collage-web/b00_001.jpg"))
        self.assertProblem("b00_001.jpg", "missing")

    def test_missing_entry(self):
        lst = self.read_json("assets/collage-web/web.json")
        del lst["cuts"]["b00_001.jpg"]
        self.write_json("assets/collage-web/web.json", lst)
        self.assertProblem("b00_001.jpg", "baked.json")

    def test_left_over_file(self):
        shutil.copy(self.path("assets/collage-web/b00_000.jpg"), self.path("assets/collage-web/b07_000.jpg"))
        self.assertProblem("b07_000.jpg", "left over")

    def test_left_over_entry(self):
        lst = self.read_json("assets/collage-web/web.json")
        lst["cuts"]["b07_000.jpg"] = dict(lst["cuts"]["b00_000.jpg"])
        self.write_json("assets/collage-web/web.json", lst)
        shutil.copy(self.path("assets/collage-web/b00_000.jpg"), self.path("assets/collage-web/b07_000.jpg"))
        self.assertProblem("b07_000.jpg", "baked.json")

    def test_other_key(self):
        baked = self.read_json("assets/collage/baked.json")
        baked["b01_000.webp"] = "e" * 40
        self.write_json("assets/collage/baked.json", baked)
        self.assertProblem("b01_000.jpg", "stale")

    def test_recorded_size_not_the_file(self):
        lst = self.read_json("assets/collage-web/web.json")
        lst["cuts"]["b00_000.jpg"]["h"] = 28  # Python's round(57 / 2)
        self.write_json("assets/collage-web/web.json", lst)
        self.assertProblem("b00_000.jpg", "51x28", "51x29")

    def test_original_gone(self):
        os.remove(self.path("assets/collage/b00_001.webp"))
        self.assertProblem("b00_001.jpg", "original", "not there")

    def test_not_half_of_the_original(self):
        Image.fromarray(picture(104, 60, 9)).save(self.path("assets/collage/b00_000.webp"), format="WEBP", lossless=True)
        self.assertProblem("b00_000.jpg", "half")

    def test_pieces_json(self):
        self.write_json("assets/pieces.json", {"sets": ["web"]})
        self.assertProblem("pieces.json", "full")
        os.remove(self.path("assets/pieces.json"))
        self.assertProblem("pieces.json")

    def test_other_settings(self):
        lst = self.read_json("assets/collage-web/web.json")
        lst["quality"] = 80
        self.write_json("assets/collage-web/web.json", lst)
        self.assertProblem("quality")

    def test_scale_not_the_full_size_lists(self):
        self.write_list(["b00_000.webp"])
        self.assertProblem("b00_000.jpg", "scale 0.5", "scale 1")
        self.make()
        self.assertEqual(web.check(self.root), [])
        self.write_list([])
        self.assertProblem("b00_000.jpg", "scale 1", "scale 0.5")

    def test_size_not_its_scale(self):
        self.write_list(["b00_000.webp"])
        self.make()
        lst = self.read_json("assets/collage-web/web.json")
        lst["cuts"]["b00_000.jpg"].update(scale=0.5)  # listed at half size, made at full size
        self.write_json("assets/collage-web/web.json", lst)
        self.assertProblem("b00_000.jpg", "101x57", "51x29")
        lst["cuts"]["b00_000.jpg"].update(scale=0.75)
        self.write_json("assets/collage-web/web.json", lst)
        self.assertProblem("b00_000.jpg", "scale 0.75")

    def test_stale_full_size_list(self):
        self.write_json("assets/collage.json", {"collage": 2})
        self.assertProblem(web.FULL_LIST, "stale", "assets/collage.json", "full_size_pieces.mjs")
        os.remove(self.path(web.FULL_LIST))
        self.assertProblem(web.FULL_LIST, "not there")

    def test_full_size_list_names_a_piece_not_baked(self):
        self.write_list(["b07_000.webp"])
        self.assertProblem(web.FULL_LIST, "b07_000.webp", "baked.json")

    def test_without_the_originals_the_scales_are_still_the_lists(self):
        shutil.rmtree(self.path("assets/collage"))
        self.write_json("assets/pieces.json", {"sets": ["web"]})
        self.assertEqual(web.check(self.root), [])
        self.write_list(["b00_000.webp"])
        self.assertProblem("b00_000.jpg", "scale 0.5", "scale 1")
        self.write_list([], inputs={"assets/score.json": "0" * 64, "assets/collage.json": "0" * 64})
        self.assertProblem(web.FULL_LIST, "stale")

    def test_without_the_originals(self):
        """The public tree: no assets/collage/; web.json and the files must agree, pieces.json says web."""
        shutil.rmtree(self.path("assets/collage"))
        self.assertProblem("pieces.json")
        self.write_json("assets/pieces.json", {"sets": ["web"]})
        self.assertEqual(web.check(self.root), [])
        os.remove(self.path("assets/collage-web/b00_001.jpg"))
        self.assertProblem("b00_001.jpg", "missing")
        shutil.copy(self.path("assets/collage-web/b00_000.jpg"), self.path("assets/collage-web/b00_001.jpg"))
        self.assertProblem("b00_001.jpg", "51x29", "32x20")
        os.remove(self.path("assets/collage-web/b00_001.jpg"))
        lst = self.read_json("assets/collage-web/web.json")
        del lst["cuts"]["b00_001.jpg"]
        self.write_json("assets/collage-web/web.json", lst)
        self.assertEqual(web.check(self.root), [])
        shutil.copy(self.path("assets/collage-web/b00_000.jpg"), self.path("assets/collage-web/b09_000.jpg"))
        self.assertProblem("b09_000.jpg", "left over")

    def test_main(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as cm:
            web.main(["--check"], root=self.root)
        self.assertEqual(cm.exception.code, 0)
        self.assertTrue(out.getvalue().startswith("PASS: "), out.getvalue())
        os.remove(self.path("assets/collage-web/b00_001.jpg"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as cm:
            web.main(["--check"], root=self.root)
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("b00_001.jpg", out.getvalue())
        self.assertNotIn("PASS", out.getvalue())


if __name__ == "__main__":
    unittest.main()

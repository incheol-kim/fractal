import copy
import json
import os
import sys
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import make_life  # noqa: E402

CHANNELS = ("flow", "tremble", "breath")


def load(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return json.load(f)


class WeightsTest(unittest.TestCase):
    def test_square_leaf(self):
        ids = np.zeros((20, 20), np.uint16)
        ids[5:15, 5:15] = 5
        w = make_life.weights(ids, {5}, 4)
        self.assertEqual(w.dtype, np.float32)
        self.assertEqual(w[0, 0], 0)
        self.assertEqual(w[5, 5], 0.25)
        self.assertEqual(w[6, 9], 0.5)
        self.assertEqual(w[9, 9], 1.0)

    def test_the_edge_of_the_picture_is_outside(self):
        ids = np.full((20, 20), 5, np.uint16)
        w = make_life.weights(ids, {5}, 4)
        self.assertEqual(w[0, 0], 0.25)
        self.assertEqual(w[10, 10], 1.0)

    def test_keep_still_is_outside(self):
        ids = np.full((20, 20), 5, np.uint16)
        w = make_life.weights(ids, {5}, 4, keep_still=[[0.4, 0.4, 0.6, 0.6]])
        self.assertTrue((w[8:12, 8:12] == 0).all())
        self.assertEqual(w[7, 9], 0.25)
        self.assertEqual(w[9, 12], 0.25)

    def test_the_rim_stays_still_before_the_feather_begins(self):
        ids = np.zeros((30, 30), np.uint16)
        ids[5:25, 5:25] = 5
        w = make_life.weights(ids, {5}, 4, rim=2)
        self.assertTrue((w[5:7, 5:25] == 0).all(), "the first 2 px inside the edge")
        self.assertEqual(w[7, 15], 0.25)
        self.assertEqual(w[10, 15], 1.0)
        self.assertTrue(np.array_equal(make_life.weights(ids, {5}, 4, rim=0), make_life.weights(ids, {5}, 4)))

    def test_held_pixels_are_outside(self):
        ids = np.full((20, 20), 5, np.uint16)
        hold = np.zeros((20, 20), bool)
        hold[:, 10] = True
        w = make_life.weights(ids, {5}, 4, hold=hold)
        self.assertTrue((w[:, 10] == 0).all())
        self.assertEqual(w[10, 11], 0.25)
        self.assertEqual(w[10, 9], 0.25)
        self.assertEqual(w[10, 14], 1.0)


class ThinDarkTest(unittest.TestCase):
    """keep_thin: the thin dark things of the plate inside a channel's area are held still."""

    N = 60

    def flat(self, value=150.0):
        return np.full((self.N, self.N), value, np.float32)

    def test_a_thin_dark_line_is_held_and_the_weights_feather_round_it(self):
        lum = self.flat()
        lum[:, 29:32] = 100.0  # a 3 px line, 50 darker than the flat round it
        held = make_life.thin_dark(lum, np.ones(lum.shape, bool), size=11, darker=14, grow=2)
        self.assertTrue(held[:, 27:34].all(), "the line and 2 px on each side")
        self.assertFalse(held[:, :27].any() or held[:, 34:].any())
        ids = np.full(lum.shape, 5, np.uint16)
        w = make_life.weights(ids, {5}, 8, hold=held)
        self.assertTrue((w[:, 27:34] == 0).all())
        self.assertEqual(w[30, 34], 1 / 8)
        self.assertEqual(w[30, 26], 1 / 8)
        self.assertEqual(w[30, 38], 5 / 8)
        self.assertEqual(w[30, 45], 1.0)

    def test_a_broad_dark_region_is_not_held(self):
        lum = self.flat()
        lum[:, 15:45] = 60.0  # 30 px wide: wider than the window
        self.assertFalse(make_life.thin_dark(lum, np.ones(lum.shape, bool), size=11, darker=14, grow=2).any())

    def test_a_faint_line_is_not_held(self):
        lum = self.flat()
        lum[:, 29:32] = 140.0  # 10 darker: below the threshold
        self.assertFalse(make_life.thin_dark(lum, np.ones(lum.shape, bool), size=11, darker=14, grow=2).any())

    def test_only_inside_the_area(self):
        lum = self.flat()
        lum[:, 29:32] = 100.0
        inside = np.zeros(lum.shape, bool)
        inside[:, :20] = True  # the line is outside the area
        self.assertFalse(make_life.thin_dark(lum, inside, size=11, darker=14, grow=2).any())


class DataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.regions = load("assets", "regions.json")
        cls.ids = np.asarray(Image.open(os.path.join(ROOT, "assets", "regions_id.png")))
        cls.rgb, cls.meta, cls.held = make_life.build()

    def test_leaves_are_the_groups_and_leaves_of_the_data(self):
        data = load("data", "life.json")
        for name in CHANNELS:
            want = set()
            for g in data[name].get("groups", []):
                want |= set(self.regions["groups"][g])
            for leaf in data[name].get("leaves", []):
                want |= {x["id"] for x in self.regions["leaves"] if x["name"] == leaf}
            self.assertEqual(set(self.meta["channels"][name]["leaves"]), want, name)

    def test_flow_has_sky_and_cloud(self):
        got = set(self.meta["channels"]["flow"]["leaves"])
        self.assertTrue(set(self.regions["groups"]["sky"]) <= got)
        self.assertTrue(set(self.regions["groups"]["cloud_main"]) <= got)

    def test_nothing_outside_a_channels_leaves(self):
        for c, name in enumerate(CHANNELS):
            inside = np.isin(self.ids, self.meta["channels"][name]["leaves"])
            self.assertFalse((self.rgb[..., c][~inside] > 0).any(), name)

    def test_every_channel_reaches_255(self):
        for c, name in enumerate(CHANNELS):
            self.assertTrue((self.rgb[..., c] == 255).any(), name)

    def test_meta(self):
        self.assertEqual(self.meta["regions"], self.regions["fingerprint"])
        self.assertEqual((self.meta["file"], self.meta["w"], self.meta["h"]), ("life.png", 2944, 1648))
        self.assertEqual(self.rgb.shape, (1648, 2944, 3))
        self.assertEqual(self.rgb.dtype, np.uint8)
        for name in CHANNELS:
            ch = self.meta["channels"][name]
            self.assertAlmostEqual(ch["area"], np.isin(self.ids, ch["leaves"]).mean(), places=5)

    def test_committed_files_are_current(self):
        with open(os.path.join(ROOT, "assets", "life.json"), "rb") as f:
            self.assertEqual(f.read(), make_life.dumps(self.meta).encode("utf-8"))
        png = np.asarray(Image.open(os.path.join(ROOT, "assets", "life.png")).convert("RGB"))
        self.assertTrue(np.array_equal(png, self.rgb))

    def test_flow_holds_the_thin_dark_things_and_records_them(self):
        data = load("data", "life.json")
        flow = self.meta["channels"]["flow"]
        self.assertEqual(flow["keep_thin"], data["flow"]["keep_thin"])
        inside = np.isin(self.ids, flow["leaves"])
        self.assertAlmostEqual(flow["held"], (self.held & inside).sum() / inside.sum(), places=5)
        self.assertGreater(flow["held"], 0)
        # held pixels do not flow
        self.assertFalse((self.rgb[..., 0][self.held] > 0).any())
        self.assertEqual(flow.get("rim"), data["flow"].get("rim"))
        # the other channels hold nothing
        for name in ("tremble", "breath"):
            self.assertNotIn("keep_thin", self.meta["channels"][name])
            self.assertNotIn("held", self.meta["channels"][name])

    def test_without_keep_thin_nothing_is_held(self):
        spec = copy.deepcopy(load("data", "life.json"))
        del spec["flow"]["keep_thin"]
        rgb, meta, held = make_life.build(spec=spec)
        self.assertFalse(held.any())
        self.assertNotIn("keep_thin", meta["channels"]["flow"])
        self.assertNotIn("held", meta["channels"]["flow"])
        self.assertGreater((rgb[..., 0] == 255).sum(), (self.rgb[..., 0] == 255).sum())
        self.assertTrue(np.array_equal(rgb[..., 1:], self.rgb[..., 1:]))

    def test_unknown_group_stops_and_says_which(self):
        spec = copy.deepcopy(load("data", "life.json"))
        spec["tremble"]["groups"].append("nope")
        with self.assertRaises(SystemExit) as cm:
            make_life.build(spec=spec)
        self.assertIn("nope", str(cm.exception))

    def test_unknown_leaf_stops_and_says_which(self):
        spec = copy.deepcopy(load("data", "life.json"))
        spec["tremble"]["leaves"].append("nada")
        with self.assertRaises(SystemExit) as cm:
            make_life.build(spec=spec)
        self.assertIn("nada", str(cm.exception))


if __name__ == "__main__":
    unittest.main()

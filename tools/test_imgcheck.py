import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import imgcheck  # noqa: E402


def random_image(h=200, w=300, seed=0):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)


def nearest_2x(img):
    return img.repeat(2, axis=0).repeat(2, axis=1)


class FidelityTest(unittest.TestCase):
    def test_nearest_2x_is_identical(self):
        orig = random_image()
        r = imgcheck.fidelity(orig, nearest_2x(orig))
        self.assertEqual(r["mean"], 0.0)
        self.assertEqual(r["p99_tile"], 0.0)

    def test_shift_4px_differs(self):
        orig = random_image()
        shifted = np.roll(nearest_2x(orig), 4, axis=1)
        r = imgcheck.fidelity(orig, shifted)
        self.assertGreater(r["mean"], 5.0)
        self.assertGreater(r["p99_tile"], 5.0)

    def test_worst_has_12_tiles_in_descending_order(self):
        orig = random_image()
        r = imgcheck.fidelity(orig, np.roll(nearest_2x(orig), 4, axis=1))
        self.assertEqual(len(r["worst"]), 12)
        means = [m for _, _, m in r["worst"]]
        self.assertEqual(means, sorted(means, reverse=True))

    def test_worst_points_at_the_changed_tile(self):
        orig = random_image()
        hires = nearest_2x(orig)
        # change only the original-scale tile at x=128..191, y=64..127
        hires[128:256, 256:384] = 255 - hires[128:256, 256:384]
        r = imgcheck.fidelity(orig, hires)
        x, y, m = r["worst"][0]
        self.assertEqual((x, y), (128, 64))
        self.assertGreater(m, 5.0)
        self.assertEqual(r["worst"][1][2], 0.0)


if __name__ == "__main__":
    unittest.main()

import hashlib
import os
import re
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import regions_lib  # noqa: E402


def rect(shape, x0, y0, x1, y1):
    m = np.zeros(shape, bool)
    m[y0:y1, x0:x1] = True
    return m


def signed_area(ring, w, h):
    """Shoelace area in pixels of a ring given in 0..1 coordinates (y down)."""
    p = np.asarray(ring, float) * [w, h]
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


class PartitionTest(unittest.TestCase):
    def test_later_mask_covers_earlier(self):
        shape = (60, 80)
        a = rect(shape, 10, 10, 40, 40)
        b = rect(shape, 30, 30, 60, 50)
        lab = regions_lib.partition([a, b], shape)
        self.assertEqual(lab.dtype, np.uint16)
        self.assertEqual(lab.shape, shape)
        self.assertEqual(lab[35, 35], 2)  # overlap -> the later mask
        self.assertEqual(lab[15, 15], 1)
        self.assertEqual(lab[45, 55], 2)
        self.assertEqual(lab[5, 5], 0)  # unassigned
        self.assertEqual(int((lab == 2).sum()), int(b.sum()))
        self.assertEqual(int((lab == 1).sum()), int((a & ~b).sum()))


class FillUnassignedTest(unittest.TestCase):
    def test_no_zero_left_and_nearest_wins(self):
        lab = np.zeros((40, 60), np.uint16)
        lab[:, :20] = 1
        lab[:, 40:] = 2
        out = regions_lib.fill_unassigned(lab)
        self.assertEqual(int((out == 0).sum()), 0)
        self.assertEqual(out[10, 22], 1)
        self.assertEqual(out[10, 37], 2)
        np.testing.assert_array_equal(out[:, :20], 1)
        np.testing.assert_array_equal(out[:, 40:], 2)


class DropSpecksTest(unittest.TestCase):
    def test_islands_and_thin_parts_are_released(self):
        lab = np.full((60, 80), 2, np.uint16)
        lab[10:40, 10:40] = 1
        lab[20, 40:60] = 1           # one-pixel-wide spur
        lab[50:53, 60:63] = 1        # small island (9 px)
        lab[45:55, 5:15] = 3         # a small leaf on its own: it is its own largest piece and stays
        out = regions_lib.drop_specks(lab, min_px=20)
        self.assertEqual(int((out == 0).sum()), 1 * 20 + 9)
        self.assertTrue(np.all(out[10:40, 10:40] == 1))
        self.assertTrue(np.all(out[45:55, 5:15] == 3))
        self.assertTrue(np.all(out[20, 41:60] == 0))
        self.assertTrue(np.all(out[50:53, 60:63] == 0))

    def test_big_second_piece_stays(self):
        lab = np.full((40, 80), 2, np.uint16)
        lab[5:20, 5:20] = 1
        lab[25:35, 50:70] = 1        # 200 px, not a speck
        out = regions_lib.drop_specks(lab, min_px=50)
        np.testing.assert_array_equal(out, lab)


class ToPolysTest(unittest.TestCase):
    def setUp(self):
        # leaf 1: an 80x60 block with a 40x30 hole; inside the hole an 10x8 island of leaf 1.
        # leaf 2 fills the hole around the island; leaf 3 is everything outside.
        self.h, self.w = 100, 120
        lab = np.full((self.h, self.w), 3, np.uint16)
        lab[20:80, 20:100] = 1
        lab[35:65, 40:80] = 2
        lab[46:54, 55:65] = 1
        self.lab = lab

    def test_three_rings_with_orientation(self):
        polys = regions_lib.to_polys(self.lab, 1)
        self.assertEqual(len(polys), 3)
        areas = sorted(signed_area(r, self.w, self.h) for r in polys)
        # one hole (counter-clockwise on screen -> negative), two outer rings (clockwise -> positive)
        self.assertLess(areas[0], 0)
        self.assertGreater(areas[1], 0)
        self.assertGreater(areas[2], 0)
        for ring in polys:
            p = np.asarray(ring)
            self.assertTrue(np.all(p >= 0.0) and np.all(p <= 1.0))

    def test_area_matches_pixels(self):
        for leaf in (1, 2, 3):
            polys = regions_lib.to_polys(self.lab, leaf)
            total = sum(signed_area(r, self.w, self.h) for r in polys)
            px = int((self.lab == leaf).sum())
            self.assertLess(abs(total - px) / px, 0.01, f"leaf {leaf}: {total} vs {px}")

    def test_neighbours_share_the_same_boundary(self):
        # the hole ring of leaf 1 and the outer ring of leaf 2 are the same points, reversed
        rings1 = regions_lib.to_polys(self.lab, 1)
        rings2 = regions_lib.to_polys(self.lab, 2)
        hole = [r for r in rings1 if signed_area(r, self.w, self.h) < 0][0]
        outer2 = [r for r in rings2 if signed_area(r, self.w, self.h) > 0][0]
        self.assertEqual(sorted(map(tuple, hole)), sorted(map(tuple, outer2)))

    def test_all_leaves_tile_the_image_without_gaps(self):
        # irregular blobs with diagonal contacts and one-pixel specks
        from scipy import ndimage
        rng = np.random.default_rng(3)
        h, w = 150, 200
        noise = ndimage.gaussian_filter(rng.normal(size=(h, w, 5)), (5, 5, 0))
        lab = (np.argmax(noise, 2) + 1).astype(np.uint16)
        lab[rng.random((h, w)) < 0.003] = 6
        total = sum(signed_area(r, w, h) for i in range(1, 7) for r in regions_lib.to_polys(lab, i))
        self.assertAlmostEqual(total, h * w, places=6)

    def test_jagged_diagonal_is_simplified(self):
        h, w = 200, 200
        yy, xx = np.mgrid[0:h, 0:w]
        lab = np.where(xx * 0.37 + 20 > yy, 1, 2).astype(np.uint16)
        polys = regions_lib.to_polys(lab, 1, tol_px=1.0)
        self.assertEqual(len(polys), 1)
        self.assertLess(len(polys[0]), 12)
        total = signed_area(polys[0], w, h)
        px = int((lab == 1).sum())
        self.assertLess(abs(total - px) / px, 0.01)


class FingerprintTest(unittest.TestCase):
    def setUp(self):
        self.lab = (np.arange(60 * 80).reshape(60, 80) % 7 + 1).astype(np.uint16)

    def test_same_array_same_fingerprint(self):
        fp = regions_lib.fingerprint(self.lab)
        self.assertEqual(regions_lib.fingerprint(self.lab), fp)
        self.assertEqual(regions_lib.fingerprint(self.lab.copy()), fp)
        # the tools read the map as int32 or int64: the same ids give the same fingerprint
        self.assertEqual(regions_lib.fingerprint(self.lab.astype(np.int64)), fp)

    def test_one_pixel_changed_differs(self):
        other = self.lab.copy()
        other[31, 47] += 1
        self.assertNotEqual(regions_lib.fingerprint(other), regions_lib.fingerprint(self.lab))

    def test_shape_counts_not_only_the_bytes(self):
        a = np.arange(1, 7, dtype=np.uint16).reshape(2, 3)
        b = a.reshape(3, 2)
        self.assertEqual(a.tobytes(), b.tobytes())
        self.assertNotEqual(regions_lib.fingerprint(a), regions_lib.fingerprint(b))

    def test_sixteen_lowercase_hex_digits(self):
        self.assertRegex(regions_lib.fingerprint(self.lab), re.compile(r"\A[0-9a-f]{16}\Z"))

    def test_the_definition(self):
        # sha256 of "<h>x<w>:" and the ids as little-endian uint16, first 16 hex digits
        want = hashlib.sha256(b"60x80:" + self.lab.astype("<u2").tobytes()).hexdigest()[:16]
        self.assertEqual(regions_lib.fingerprint(self.lab), want)


class SplitByToneTest(unittest.TestCase):
    def test_half_bright_half_dark_splits_in_two_and_noise_merges(self):
        h, w = 120, 160
        lab = np.full((h, w), 2, np.uint16)  # 2 = surroundings
        lab[20:100, 20:140] = 1
        img = np.full((h, w, 3), 128, np.uint8)
        img[20:100, 20:80] = (40, 40, 50)
        img[20:100, 80:140] = (225, 220, 210)
        img[50, 50] = (250, 30, 30)  # one-pixel noise in the dark half
        out = regions_lib.split_by_tone(lab, img, 1, max_tones=4, min_area=0.01)
        np.testing.assert_array_equal(out[lab == 2], 2)  # others untouched
        ids = sorted(set(np.unique(out[lab == 1]).tolist()))
        self.assertEqual(ids, [1, 3])  # the new piece's id is appended after the largest
        dark = out[20:100, 20:80]
        bright = out[20:100, 80:140]
        self.assertEqual(len(np.unique(dark)), 1)
        self.assertEqual(len(np.unique(bright)), 1)
        self.assertNotEqual(dark[0, 0], bright[0, 0])

    def test_flat_region_stays_whole(self):
        h, w = 80, 80
        lab = np.full((h, w), 2, np.uint16)
        lab[10:70, 10:70] = 1
        rng = np.random.default_rng(1)
        img = np.clip(rng.normal(150, 3, size=(h, w, 3)), 0, 255).astype(np.uint8)
        out = regions_lib.split_by_tone(lab, img, 1, max_tones=4, min_area=0.01)
        np.testing.assert_array_equal(out, lab)


if __name__ == "__main__":
    unittest.main()

import contextlib
import io
import os
import re
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cmp_png  # noqa: E402

LINE = re.compile(r"^over 3: (\d+) px \(share ([0-9.]+)\), max ([0-9.]+), mean ([0-9.]+)")


def picture(h=100, w=100, seed=0):
    """A 100 x 100 RGB picture with room to add up to 55 to every value."""
    rng = np.random.default_rng(seed)
    return rng.integers(0, 200, size=(h, w, 3), dtype=np.uint8)


def nearest_2x(img):
    return img.repeat(2, axis=0).repeat(2, axis=1)


class CliCase(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._dir.cleanup()

    def save(self, name, img):
        path = os.path.join(self._dir.name, name)
        Image.fromarray(img).save(path)
        return path

    def cli(self, a, b, *args):
        """Runs the tool on two pictures -> (exit code, the printed line)."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = cmp_png.main([self.save("a.png", a), self.save("b.png", b), *args])
        return code, out.getvalue().strip()


class CompareTest(CliCase):
    def test_same_picture(self):
        a = picture()
        r = cmp_png.compare(a, a.copy())
        self.assertEqual(r["n_over"], 0)
        self.assertEqual(r["share"], 0.0)
        self.assertEqual(r["max"], 0)
        self.assertEqual(r["mean"], 0.0)
        code, line = self.cli(a, a.copy())
        self.assertEqual(code, 0)
        self.assertIn("PASS", line)

    def test_one_pixel_40_apart(self):
        a = picture()
        b = a.copy()
        b[37, 52, 1] += 40
        r = cmp_png.compare(a, b)
        self.assertEqual(r["n_over"], 1)
        self.assertEqual(r["share"], 0.0001)
        self.assertEqual(r["max"], 40)
        code, line = self.cli(a, b)
        self.assertEqual(code, 0)
        self.assertIn("PASS", line)

    def test_100_pixels_10_apart(self):
        a = picture()
        b = a.copy()
        b[:10, :10, 0] += 10
        r = cmp_png.compare(a, b)
        self.assertEqual(r["n_over"], 100)
        self.assertEqual(r["share"], 0.01)
        self.assertEqual(r["max"], 10)
        code, line = self.cli(a, b)
        self.assertEqual(code, 1)
        self.assertIn("FAIL", line)

    def test_every_pixel_2_apart(self):
        a = picture()
        b = a + 2
        r = cmp_png.compare(a, b)
        self.assertEqual(r["n_over"], 0)
        self.assertEqual(r["mean"], 2.0)
        self.assertEqual(self.cli(a, b)[0], 0, "default: no pixel over 3")
        self.assertEqual(self.cli(a, b, "--mean", "1.0")[0], 1)
        self.assertEqual(self.cli(a, b, "--mean", "2.0")[0], 0)

    def test_the_line(self):
        a = picture()
        b = a.copy()
        b[37, 52, 1] += 40
        code, line = self.cli(a, b)
        self.assertEqual(len(line.splitlines()), 1)
        m = LINE.match(line)
        self.assertIsNotNone(m, line)
        self.assertEqual(int(m.group(1)), 1)
        self.assertEqual(float(m.group(2)), 0.0001)
        self.assertEqual(float(m.group(3)), 40)
        self.assertAlmostEqual(float(m.group(4)), 40 / 30000, places=4)


class FitTest(CliCase):
    def test_sizes_differ_without_fit(self):
        a = picture()
        code, _ = self.cli(nearest_2x(a), a)
        self.assertEqual(code, 2)

    def test_nearest_2x_fits_exactly(self):
        a = picture()
        r = cmp_png.compare(cmp_png.fit(nearest_2x(a), a.shape[:2]), a)
        self.assertEqual(r["mean"], 0.0)
        self.assertEqual(r["n_over"], 0)
        code, line = self.cli(nearest_2x(a), a, "--fit")
        self.assertEqual(code, 0)
        m = LINE.match(line)
        self.assertIsNotNone(m, line)
        self.assertEqual(float(m.group(4)), 0.0)


if __name__ == "__main__":
    unittest.main()

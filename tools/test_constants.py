"""The constants the page (JS) and the tools (Python) both hold must agree."""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import make_music  # noqa: E402
import make_strokes  # noqa: E402
import score_lib  # noqa: E402


def js_const(path, name):
    """The number in the `export const name = value;` line of a JS module."""
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        m = re.search(r"^export const %s\s*=\s*([-+0-9.eE]+)\s*;" % re.escape(name), f.read(), re.M)
    assert m, "%s: no `export const %s = number;` line" % (path, name)
    return float(m.group(1))


def load(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return json.load(f)


def js_music(name):
    return js_const("src/music.js", name)


class ClockConstants(unittest.TestCase):
    def test_music_js(self):
        js = js_music
        self.assertEqual(js("OFFSET"), 0.923077)
        self.assertEqual(js("DUR"), 47.076938)
        self.assertEqual(js("BAR"), 1.846154)
        self.assertEqual(js("M1"), 0.923077)
        self.assertEqual(js("OFFSET"), make_music.OFFSET)
        self.assertEqual(js("BAR"), make_music.BAR)
        self.assertEqual(js("BAR"), score_lib.BAR)
        self.assertEqual(js("M1"), make_music.OFFSET)
        self.assertEqual(js("DUR"), make_music.DUR)

    def test_music_json(self):
        """assets/music.json has these keys and no other (the picture ends with the audio, at dur:
        no silent time after it)."""
        music = load("assets/music.json")
        self.assertEqual(set(music), {"dur", "offset", "bar", "m1", "cello", "piano", "attacks", "pedal", "env", "sections"})
        for key, want in (("offset", make_music.OFFSET), ("bar", make_music.BAR), ("m1", make_music.OFFSET)):
            self.assertEqual(music[key], round(want, 4), key)
        self.assertEqual(music["dur"], round(make_music.DUR, 4))
        self.assertEqual(music["sections"], {"A": [0.923, 15.692], "B": [15.692, 30.3], "C": [30.3, 41.538],
                                             "coda": [41.538, 45.231], "tail": [45.231, 47.077]})


class StrokeConstants(unittest.TestCase):
    def test_wire_pad(self):
        self.assertEqual(js_const("src/ribbons.js", "WIRE_PAD"), 2)
        self.assertEqual(make_strokes.WIRE_PAD_PX, 2)

    def test_view_frames(self):
        center = load("data/cues.json")["camera_center"]
        want = [score_lib.view_frame(z, center) for z in (8, 4, 2)]
        spec = [[0.4375, 0.3325, 0.5625, 0.4575], [0.375, 0.270, 0.625, 0.520], [0.25, 0.145, 0.75, 0.645]]
        self.assertEqual(len(make_strokes.FRAMES), 3)
        for got, w, s in zip(make_strokes.FRAMES, want, spec):
            for a, b, c in zip(got, w, s):
                self.assertAlmostEqual(a, b, delta=1e-12)
                self.assertAlmostEqual(a, c, delta=1e-12)


if __name__ == "__main__":
    unittest.main()

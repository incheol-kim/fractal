import json
import os
import sys
import unittest
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import make_music  # noqa: E402
import public_tree  # noqa: E402

WAV_WORDS = "the final WAV, which the loudness envelope is read from (resources/Mixdown/ is not published)"


class MusicDataTest(unittest.TestCase):
    """The notes come from the MIDI (resources/midi/, in both repositories); the loudness envelope from the
    final WAV, which only this repository has: in the public tree test_env skips, saying so."""

    @classmethod
    def setUpClass(cls):
        cls.m = make_music.build(with_env=False)

    def test_counts(self):
        m = self.m
        self.assertEqual(len(m["cello"]), 189)
        self.assertEqual(len(m["piano"]), 241)
        self.assertEqual(len(m["attacks"]), 108)
        sizes = Counter(len(a[1]) for a in m["attacks"])
        self.assertEqual(dict(sizes), {1: 27, 2: 67, 3: 1, 4: 1, 5: 3, 6: 5, 7: 4})

    def test_first_notes(self):
        m = self.m
        t, d, p, v = m["cello"][0]
        self.assertAlmostEqual(t, 0.937, delta=0.002)
        self.assertEqual((p, v), (45, 68))
        t, d, p, v = m["piano"][0]
        self.assertAlmostEqual(t, 0.880, delta=0.002)
        self.assertEqual(p, 79)

    def test_attack_at_34(self):
        m = self.m
        hit = [a for a in m["attacks"] if abs(a[0] - 34.08) < 0.02]
        self.assertEqual(len(hit), 1)
        self.assertEqual(len(hit[0][1]), 5)
        self.assertEqual({m["piano"][i][2] for i in hit[0][1]}, {27, 65, 67, 72, 79})

    def test_last_cello(self):
        t, d, p, v = self.m["cello"][-1]
        self.assertAlmostEqual(t, 44.26, delta=0.02)
        self.assertAlmostEqual(d, 0.61, delta=0.02)
        self.assertEqual(p, 78)

    def test_env(self):
        public_tree.skip_unpublished(os.path.relpath(make_music.WAV, ROOT).replace("\\", "/"), WAV_WORDS)
        env = make_music.envelope(make_music.WAV)
        self.assertAlmostEqual(len(env), 4708, delta=1)
        self.assertEqual(max(env), 1000)
        self.assertGreaterEqual(min(env), 0)

    def test_json_roundtrip(self):
        json.dumps(self.m)


if __name__ == "__main__":
    unittest.main()

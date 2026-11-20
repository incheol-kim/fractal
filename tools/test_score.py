import copy
import itertools
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import make_score  # noqa: E402
import score_lib  # noqa: E402

END = 44.87
BAR = 1.846154
EPS = 1e-6
MASSY = {"mass", "back", "sky"}
TWO_BARS_END = 19.384308        # B starts 15.692; two bars later
STRENGTHS = ("calm", "mid", "high")
LIMITS = {"area": 0.22, "gap_few": 3, "gap_many": 2, "many": 6}


def load(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return json.load(f)


def arc_midpoint(pts, k):
    """Point halfway along a polyline, lengths measured with y scaled by k (= h / w)."""
    p = np.asarray(pts, float) * (1.0, k)
    if len(p) == 1:
        return p[0] / (1.0, k)
    seg = np.hypot(*np.diff(p, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    half = cum[-1] / 2
    i = min(int(np.searchsorted(cum, half, "right")) - 1, len(seg) - 1)
    u = 0.0 if seg[i] == 0 else (half - cum[i]) / seg[i]
    return (p[i] + u * (p[i + 1] - p[i])) / (1.0, k)


# ---------------------------------------------------------------- score_lib

class RelHeightTest(unittest.TestCase):
    def test_ends_and_middle(self):
        self.assertEqual(score_lib.rel_height(80, 40, 80), 1.0)
        self.assertEqual(score_lib.rel_height(40, 40, 80), 0.0)
        self.assertAlmostEqual(score_lib.rel_height(60, 40, 80), 0.5)

    def test_clamped(self):
        self.assertEqual(score_lib.rel_height(90, 40, 80), 1.0)
        self.assertEqual(score_lib.rel_height(30, 40, 80), 0.0)

    def test_one_pitch_range_is_the_middle(self):
        self.assertEqual(score_lib.rel_height(60, 60, 60), 0.5)


class AssignTest(unittest.TestCase):
    def test_smallest_total_cost_not_first_come(self):
        cost = {("a", "x"): 0.0, ("a", "y"): 1.0, ("b", "x"): 0.0, ("b", "y"): 5.0}
        got = score_lib.assign([("a", 1.0), ("b", 2.0)], ["x", "y"], lambda n, c: cost[n, c])
        self.assertEqual(got, {"a": "y", "b": "x"})      # total 1; first come would cost 5

    def test_matches_brute_force(self):
        rng = np.random.default_rng(3)
        for _ in range(40):
            n = int(rng.integers(1, 5))
            m = int(rng.integers(n, 7))
            c = rng.random((n, m)).round(2)
            got = score_lib.assign([(i, float(i)) for i in range(n)], list(range(m)), lambda i, j: c[i, j])
            self.assertEqual(sorted(got), list(range(n)))
            self.assertEqual(len(set(got.values())), n)
            best = min(sum(c[i, p[i]] for i in range(n)) for p in itertools.permutations(range(m), n))
            self.assertAlmostEqual(sum(c[i, got[i]] for i in got), best)

    def test_each_candidate_once_and_extra_notes_get_nothing(self):
        got = score_lib.assign([(i, float(i)) for i in range(4)], ["x", "y"], lambda n, c: float(n))
        self.assertEqual(len(got), 2)
        self.assertEqual(sorted(got.values()), ["x", "y"])

    def test_input_order_of_notes_does_not_matter(self):
        notes = [(k, t) for k, t in zip(range(6), [0.5, 0.1, 0.5, 0.3, 0.2, 0.4])]
        cost = lambda n, c: abs(n - c) * 0.1  # noqa: E731
        a = score_lib.assign(notes, list(range(6)), cost)
        b = score_lib.assign(list(reversed(notes)), list(range(6)), cost)
        self.assertEqual(a, b)
        self.assertEqual(sorted(a.values()), list(range(6)))


class HelperTest(unittest.TestCase):
    def test_view_frames_of_section_a(self):
        c = (0.5, 0.395)
        want = {8: [0.4375, 0.3325, 0.5625, 0.4575], 4: [0.375, 0.270, 0.625, 0.520],
                2: [0.25, 0.145, 0.75, 0.645], 1: [0.0, 0.0, 1.0, 1.0]}
        for zoom, frame in want.items():
            np.testing.assert_allclose(score_lib.view_frame(zoom, c), frame, atol=1e-12)
        self.assertEqual(score_lib.view_center(1, c), (0.5, 0.5))

    def test_ink_ramp(self):
        self.assertEqual(score_lib.ink_at(10.0), 0.0)
        self.assertEqual(score_lib.ink_at(24.9), 0.0)
        self.assertAlmostEqual(score_lib.ink_at(26.75), 0.5)
        self.assertEqual(score_lib.ink_at(28.6), 1.0)
        self.assertEqual(score_lib.ink_at(40.0), 1.0)

    def test_family_step(self):
        self.assertAlmostEqual(score_lib.family_step(10.0, 5, END), BAR / 16)
        self.assertAlmostEqual(score_lib.family_step(10.0, 185, END), 2 * BAR / 186)
        self.assertAlmostEqual(score_lib.family_step(44.0, 9, END), (END - 44.0) / 10)

    def test_rank_corr_matches_scipy(self):
        a = [1, 2, 2, 3, 5, 4, 4, 0]
        b = [0.3, 0.1, 0.4, 0.4, 0.9, 0.2, 0.8, 0.0]
        self.assertAlmostEqual(score_lib.rank_corr(a, b), spearmanr(a, b)[0])
        self.assertAlmostEqual(score_lib.rank_corr([1, 2, 3], [3, 2, 1]), -1.0)

    def test_nearest_attack(self):
        attacks = [[1.0, [0]], [1.02, [1]], [2.0, [2, 3]]]
        self.assertEqual(score_lib.nearest_attack(attacks, 1.015), 1)
        self.assertEqual(score_lib.nearest_attack(attacks, 1.98), 2)
        with self.assertRaises(ValueError):
            score_lib.nearest_attack(attacks, 1.5)

    def test_piece_from(self):
        aspect = 2944 / 1648
        for seed in range(50):
            for c in [(0.9, 0.1), (0.1, 0.8), (0.5, 0.6)]:
                dx, dy, rot, s = score_lib.piece_from(seed, c, aspect)
                self.assertTrue(0.03 - EPS <= math.hypot(dx, dy) <= 0.08 + EPS)
                self.assertTrue(-6 <= rot <= 6 and 1.08 <= s <= 1.20)
                out = ((c[0] - 0.5) * aspect, c[1] - 0.5)
                self.assertGreater(dx * out[0] + dy * out[1], 0)     # away from the centre
        self.assertEqual(score_lib.piece_from(7, (0.2, 0.2), aspect),
                         score_lib.piece_from(7, (0.2, 0.2), aspect))
        self.assertNotEqual(score_lib.piece_from(7, (0.2, 0.2), aspect),
                            score_lib.piece_from(8, (0.2, 0.2), aspect))


class CueErrorTest(unittest.TestCase):
    def test_wash_cue_with_an_unknown_group(self):
        """A wash cue naming a group regions.json does not have stops with the cue and the group."""
        inp = make_score.load_inputs()
        cues = dict(inp["cues"], washes=[{"attack_index": 1, "gain": 0.27, "groups": ["white_box", "no_such_group"]}])
        camera = make_score.make_camera(inp["music"], cues)
        with self.assertRaises(SystemExit) as cm:
            make_score.make_washes(inp["music"], inp["regions"], cues, camera, inp["ids"])
        msg = str(cm.exception)
        self.assertIn("wash 1", msg)
        self.assertIn("no_such_group", msg)


class ShakeTest(unittest.TestCase):
    def test_window_in_the_score(self):
        inp = make_score.load_inputs()
        self.assertEqual(make_score.compose(inp)[0]["shake"], {"from": 39.0, "to": 41.1})

    def test_window_past_the_glue_stops(self):
        """A shake that runs to within 0.1 s of the glue chord (or into it) stops the build."""
        inp = make_score.load_inputs()
        for window in ([39.0, 41.45], [41.1, 39.0], [39.0, 39.0]):
            bad = dict(inp, cues=dict(inp["cues"], shake=window))
            with self.assertRaises(SystemExit, msg=str(window)) as cm:
                make_score.compose(bad)
            self.assertIn("shake", str(cm.exception))

    def test_no_shake_cue_stops(self):
        """cues.json without its shake stops the build with a readable message, not a KeyError."""
        inp = make_score.load_inputs()
        cues = {k: v for k, v in inp["cues"].items() if k != "shake"}
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(inp, cues=cues))
        self.assertIn("shake", str(cm.exception))
        self.assertIn("data/cues.json", str(cm.exception))


class PipTest(unittest.TestCase):
    """The picture in picture (data/cues.json pip): the three glass rooms become windows on the piano
    attacks two, four and six bars into B."""

    @classmethod
    def setUpClass(cls):
        cls.inp = make_score.load_inputs()
        cls.score = make_score.compose(cls.inp)[0]

    def test_rows(self):
        pip = self.score["pip"]
        self.assertEqual(len(pip), 3)
        self.assertEqual([self.score["collage"]["blocks"][p["block"]]["name"] for p in pip],
                         ["glass_room", "blue_room", "red_room"])
        b0 = self.inp["music"]["sections"]["B"][0]
        attacks = [a[0] for a in self.inp["music"]["attacks"]]
        for k, (p, want) in enumerate(zip(pip, (19.3731, 23.0317, 26.7173)), 1):
            self.assertAlmostEqual(p["t"], b0 + 2 * k * BAR, delta=0.06)
            self.assertTrue(any(abs(p["t"] - a) <= EPS for a in attacks), p["t"])
            self.assertAlmostEqual(p["t"], want, delta=EPS)
            self.assertLess(p["t"], self.score["collage"]["blocks"][p["block"]]["stop"])
        self.assertEqual([p["t"] for p in pip], sorted(p["t"] for p in pip))
        accents = [self.inp["collage"]["blocks"][p["block"]]["accent"] for p in pip]
        self.assertEqual([p["accent"] for p in pip], accents)
        self.assertEqual(accents, [9, -1, 9])

    def test_no_pip_cue_stops(self):
        """cues.json without its pip stops the build with a readable message, not a KeyError."""
        cues = {k: v for k, v in self.inp["cues"].items() if k != "pip"}
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(self.inp, cues=cues))
        self.assertIn("pip", str(cm.exception))
        self.assertIn("data/cues.json", str(cm.exception))

    def test_unknown_block_stops(self):
        cues = copy.deepcopy(self.inp["cues"])
        cues["pip"][1]["block"] = "nope"
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(self.inp, cues=cues))
        self.assertIn("nope", str(cm.exception))

    def test_a_window_after_its_rooms_photo_stops(self):
        """The central room's photo comes at 34.08: a window on the 35.02 attack would never show."""
        cues = copy.deepcopy(self.inp["cues"])
        cues["pip"][0]["attack_t"] = 35.02
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(self.inp, cues=cues))
        self.assertIn("glass_room", str(cm.exception))

    def test_a_rooms_leaf_after_its_window_stops(self):
        """A room's later leaves are shown from its window's start (src/timeline.js pipCollage); one that
        arrives after the accent comes down on the window (a room without one: after its photo comes)
        would vanish when the window ends and come back at its own time. The collage check stops on it
        and names the room, the leaf and the two times."""
        inp, score = self.inp, self.score
        col = score["collage"]
        names = [b["name"] for b in col["blocks"]]
        pip = {names[p["block"]]: p for p in score["pip"]}

        def stops(name, t, end):
            last = max((r for r in col["leaves"] if r["block"] == pip[name]["block"]), key=lambda r: r["t"])
            s = copy.deepcopy(score)
            next(r for r in s["collage"]["leaves"] if r["leaf"] == last["leaf"])["t"] = t
            with self.assertRaises(SystemExit) as cm:
                make_score.check_collage(s, inp["music"], inp["regions"], inp["collage"], inp["cues"])
            for w in (name, f"leaf {last['leaf']}", f"{t}", f"{end}"):
                self.assertIn(w, str(cm.exception))

        glass = pip["glass_room"]
        accent = {k: next(e["t"] for e in ch["events"] if e["block"] == glass["block"] and e["to"] == glass["accent"]
                          and e["t"] >= glass["t"]) for k, ch in col["changes"].items()}
        late = round(max(accent.values()) + 0.5, 6)       # after the accent in every strength
        stops("glass_room", late, accent[next(iter(col["changes"]))])      # the first strength is checked first
        self.assertEqual(pip["blue_room"]["accent"], -1)
        stop = col["blocks"][pip["blue_room"]["block"]]["stop"]
        stops("blue_room", round(stop + 0.5, 6), stop)


class RegionMapTest(unittest.TestCase):
    def test_strokes_from_another_region_map(self):
        """Strokes made from another region map stop the score and name the tool to run again."""
        inp = make_score.load_inputs()
        other = "0123456789abcdef"
        self.assertNotEqual(inp["regions"].get("fingerprint"), other)
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(inp, strokes_regions=other))
        self.assertIn("make_strokes", str(cm.exception))

    def test_collage_from_another_region_map(self):
        """A collage list made from another region map stops the score and names make_collage."""
        inp = make_score.load_inputs()
        other = "0123456789abcdef"
        self.assertNotEqual(inp["regions"].get("fingerprint"), other)
        with self.assertRaises(SystemExit) as cm:
            make_score.compose(dict(inp, collage=dict(inp["collage"], regions=other)))
        self.assertIn("make_collage", str(cm.exception))


class CollageScheduleTest(unittest.TestCase):
    """score_lib.schedule_changes on made-up notes and blocks."""

    @staticmethod
    def notes(n, first=0, t0=20.0, dt=0.25):
        return [(first + i, t0 + i * dt) for i in range(n)]

    @staticmethod
    def block(on, off=99.0, area=0.05, stop=99.0, cuts=48, accent=-1):
        return {"leaves": [(on, off, area)], "stop": stop, "cuts": cuts, "accent": accent}

    @staticmethod
    def by_block(events):
        out = {}
        for e in events:
            out.setdefault(e["block"], []).append(e)
        return out

    def test_one_block_changes_every_three_to_five_notes(self):
        notes = self.notes(20)
        for seed in range(10):
            for mean in (2.0, 4.5, 8.0):
                start, ev = score_lib.schedule_changes(notes, [self.block(notes[0][1])], mean, seed, LIMITS)
                self.assertEqual(start, [0])
                self.assertGreaterEqual(len(ev), 3, (seed, mean))
                seen = [notes[0][0]] + [e["note"] for e in ev]      # it appears on the first note
                self.assertTrue(all(b - a in (3, 4, 5) for a, b in zip(seen, seen[1:])), (seed, mean, seen))

    def test_area_limit_and_gaps(self):
        notes = self.notes(40)
        for count, gap in ((8, 2), (4, 3)):
            for mean in (2.0, 4.5, 8.0):
                blocks = [self.block(notes[0][1]) for _ in range(count)]
                start, ev = score_lib.schedule_changes(notes, blocks, mean, 5, LIMITS)
                self.assertTrue(ev, (count, mean))
                per = {}
                for e in ev:
                    per[e["note"]] = per.get(e["note"], 0) + 1
                self.assertLessEqual(max(per.values()) * 0.05, 0.22 + 1e-9, (count, mean))
                self.assertLessEqual(max(per.values()), 4)
                if count == 8 and mean == 2.0:
                    self.assertEqual(max(per.values()), 4)               # the limit holds some back
                for b, mine in self.by_block(ev).items():
                    seen = [notes[0][0]] + [e["note"] for e in mine]
                    self.assertTrue(all(y - x >= gap for x, y in zip(seen, seen[1:])), (count, mean, b, seen))
                self.assertEqual([e["t"] for e in ev], sorted(e["t"] for e in ev))

    def test_a_block_out_of_cuts_stops(self):
        notes = self.notes(30)
        start, ev = score_lib.schedule_changes(notes, [self.block(notes[0][1], cuts=2)], 4.5, 1, LIMITS)
        self.assertEqual((start, [e["to"] for e in ev]), ([0], [1]))
        start, ev = score_lib.schedule_changes(notes, [self.block(notes[0][1], cuts=1)], 4.5, 1, LIMITS)
        self.assertEqual((start, ev), ([0], []))

    def test_accent(self):
        notes = self.notes(40)
        for seed in range(5):
            start, ev = score_lib.schedule_changes(notes, [self.block(notes[0][1], cuts=6, accent=2)], 4.5, seed, LIMITS)
            to = [e["to"] for e in ev]
            self.assertNotEqual(start[0], 2)
            self.assertTrue(to)
            self.assertEqual(to[-1], 2)
            self.assertNotIn(2, to[:-1])
            seq = start + to
            self.assertEqual(len(set(seq)), len(seq))
            # the smallest cut that is not the accent first, then on in order; the last change
            # goes to the accent instead (so the last cut, 5, is never shown)
            self.assertEqual(seq, [0, 1, 3, 4, 2])
        # an accent block that does not change shows its accent from the start
        brief = self.block(notes[0][1], stop=notes[2][1], cuts=6, accent=2)        # gone before its timer
        self.assertEqual(score_lib.schedule_changes(notes, [brief], 4.5, 1, LIMITS), ([2], []))
        only = self.block(notes[0][1], cuts=1, accent=0)                           # no other cut
        self.assertEqual(score_lib.schedule_changes(notes, [only], 4.5, 1, LIMITS), ([0], []))

    def test_accent_min(self):
        """With accent_min, an accent block's change to its accent is its last change up to
        stop - accent_min; its later changes go. Nothing else changes."""
        notes = self.notes(40)                                   # t 20.0 ... 29.75
        stop = notes[30][1]                                      # 27.5
        for seed in range(6):
            blocks = [self.block(notes[0][1], stop=stop, cuts=48, accent=2), self.block(notes[0][1], area=0.03)]
            s0, e0 = score_lib.schedule_changes(notes, blocks, 4.5, seed, LIMITS, accent_min=0.0)
            s1, e1 = score_lib.schedule_changes(notes, blocks, 4.5, seed, LIMITS, accent_min=2.0)
            mine0 = [e for e in e0 if e["block"] == 0]
            mine1 = [e for e in e1 if e["block"] == 0]
            self.assertTrue(mine1, seed)
            self.assertLess(len(mine1), len(mine0), seed)        # some changes fell in the last two seconds
            self.assertEqual(mine1[-1]["to"], 2, seed)
            self.assertLessEqual(mine1[-1]["t"], stop - 2.0, seed)
            self.assertTrue(all(e["t"] > stop - 2.0 for e in mine0[len(mine1):]), seed)   # the last one up to there
            seq = s1[:1] + [e["to"] for e in mine1]
            self.assertEqual(len(set(seq)), len(seq), (seed, seq))
            # the same changes up to the accent (same notes, same cuts), the other block untouched
            key = lambda e: (e["t"], e["note"], e["to"])  # noqa: E731
            self.assertEqual([key(e) for e in mine1[:-1]], [key(e) for e in mine0[:len(mine1) - 1]], seed)
            self.assertEqual(mine1[-1]["note"], mine0[len(mine1) - 1]["note"], seed)
            self.assertEqual([e for e in e1 if e["block"] == 1], [e for e in e0 if e["block"] == 1], seed)
            self.assertEqual(s1, s0, seed)
        # every change of the block falls in the last accent_min seconds: it starts on its accent
        late = self.block(notes[0][1], stop=notes[6][1], cuts=6, accent=2)        # changes from note 3 on
        self.assertTrue(score_lib.schedule_changes(notes, [late], 4.5, 1, LIMITS)[1])
        self.assertEqual(score_lib.schedule_changes(notes, [late], 4.5, 1, LIMITS, accent_min=1.0), ([2], []))

    def test_accent_min_zero_is_the_default(self):
        notes = self.notes(50, first=7)
        blocks = [self.block(notes[i][1], area=0.02 + 0.01 * i, stop=notes[40 - i][1], cuts=10,
                             accent=(3 if i % 3 == 0 else -1)) for i in range(9)]
        for seed in range(5):
            for mean in (2.0, 4.5, 8.0):
                self.assertEqual(score_lib.schedule_changes(notes, blocks, mean, seed, LIMITS),
                                 score_lib.schedule_changes(notes, blocks, mean, seed, LIMITS, accent_min=0.0))

    def test_nothing_before_on_or_from_stop(self):
        notes = self.notes(60)
        t = [x for _, x in notes]
        blocks = [{"leaves": [(t[10], t[50], 0.03), (t[15], t[55], 0.02)], "stop": t[40], "cuts": 48, "accent": -1},
                  {"leaves": [(t[0], t[30], 0.04)], "stop": 99.0, "cuts": 48, "accent": -1},   # off screen from t[30]
                  self.block(t[5])]
        for seed in range(5):
            for mean in (2.0, 4.5):
                start, ev = score_lib.schedule_changes(notes, blocks, mean, seed, LIMITS)
                got = self.by_block(ev)
                self.assertEqual(sorted(got), [0, 1, 2], (seed, mean))
                self.assertTrue(all(t[10] <= e["t"] < t[40] for e in got[0]), (seed, mean))
                self.assertTrue(all(e["t"] < t[30] for e in got[1]), (seed, mean))
                self.assertTrue(all(e["t"] >= t[5] for e in got[2]), (seed, mean))

    def test_same_arguments_same_result(self):
        notes = self.notes(50, first=7)
        blocks = [self.block(notes[i][1], area=0.02 + 0.01 * i, cuts=10, accent=(3 if i % 3 == 0 else -1))
                  for i in range(9)]
        keep = json.dumps([notes, blocks])
        a = score_lib.schedule_changes(notes, blocks, 4.5, 20261116, LIMITS)
        b = score_lib.schedule_changes(notes, blocks, 4.5, 20261116, LIMITS)
        self.assertEqual(a, b)
        self.assertEqual(json.dumps([notes, blocks]), keep)                  # the arguments are not changed
        self.assertNotEqual(a, score_lib.schedule_changes(notes, blocks, 4.5, 7, LIMITS))   # the seed counts


# ---------------------------------------------------------------- the score of the real material

class ScoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.score = make_score.build()
        cls.music = load("assets", "music.json")
        cls.regions = load("assets", "regions.json")
        cls.strokes = load("assets", "strokes.json")["strokes"]
        cls.cues = load("data", "cues.json")
        m = cls.music
        cls.cello, cls.piano, cls.attacks = m["cello"], m["piano"], m["attacks"]
        cls.sec = m["sections"]
        cls.leaves = {l["id"]: l for l in cls.regions["leaves"]}
        cls.k = cls.regions["h"] / cls.regions["w"]
        cls.chords_a = [a for a in cls.attacks if a[0] < 15.60]
        g0 = [e for e in cls.score["strokes"] if e["gen"] == 0]
        cls.g0_by_note = {}
        for e in g0:
            cls.g0_by_note.setdefault(e["note"], []).append(e)
        cls.pieces_by_note = {}
        for e in cls.score["pieces"]:
            cls.pieces_by_note.setdefault(e["note"], []).append(e)
        cls.piece_of_group = {}
        for e in cls.score["pieces"]:
            cls.piece_of_group.setdefault(cls.leaves[e["leaf"]]["group"], e)
        cls.area = {g: sum(cls.leaves[i]["area"] for i in ids) for g, ids in cls.regions["groups"].items()}
        cls.group_c = {g: (sum(cls.leaves[i]["area"] * cls.leaves[i]["c"][0] for i in ids) / cls.area[g],
                           sum(cls.leaves[i]["area"] * cls.leaves[i]["c"][1] for i in ids) / cls.area[g])
                       for g, ids in cls.regions["groups"].items()}
        cls.own = make_score.compose(make_score.load_inputs())[1]["own"]    # {note: its own group}

    # helpers
    def parent_group(self, name):
        """The group of the parent leaf of the group's largest leaf (None: no parent outside it)."""
        ls = [self.leaves[i] for i in self.regions["groups"][name]]
        big = max(ls, key=lambda l: (l["area"], -l["id"]))
        p = self.leaves.get(big["parent"])
        return p["group"] if p and p["group"] != name else None

    def kinds_of(self, name):
        return {self.leaves[i]["kind"] for i in self.regions["groups"][name]}

    def cutouts(self, t):
        """What arrives at the attack nearest t, read from the pieces events and the regions:
        {note: (host, [groups])}.

        A cut-out is the set of groups whose pieces share t, note, style and from (they move as
        one). Its host is the group cues.json names for that note, else its one group whose
        parent group is not in the cut-out. Every other group must be a rider of the host:
        its parent group is in the cut-out (it rides up the chain to the host), or it has no
        parent group and is medium-or-larger or massive (it rides with the nearest placed
        group)."""
        ai = score_lib.nearest_attack(self.attacks, t)
        notes = self.attacks[ai][1]
        times = [self.piano[i][0] for i in notes]
        cut, hosts = self.all_cutouts()
        aspect = self.regions["w"] / self.regions["h"]
        centre = lambda g: (self.group_c[g][0] * aspect, self.group_c[g][1])  # noqa: E731
        placed = sorted(h for k, h in hosts.items() if h and not 39.0 <= k[0] <= 41.1)
        out = {}
        for key, gs in cut.items():
            if not any(abs(key[0] - x) <= EPS for x in times):
                continue
            note = key[1]
            self.assertIn(note, notes, (t, gs))
            self.assertNotIn(note, out, (t, note, gs))           # one cut-out per note
            host = hosts[key]
            self.assertIsNotNone(host, (t, note, gs))
            for g in gs:
                if g == host or self.parent_group(g) in gs:
                    continue                                   # the host, or up the chain to it
                # a rider with no parent group: medium-or-larger or massive, and the host is
                # the nearest group placed outside the six high chords
                self.assertIsNone(self.parent_group(g), (t, g))
                self.assertTrue(self.area[g] >= make_score.A_MED or self.kinds_of(g) & MASSY, (t, g))
                near = min((h for h in placed if h != g), key=lambda h: (math.dist(centre(g), centre(h)), h))
                self.assertEqual(near, host, (t, g))
            out[note] = (host, sorted(gs))
        return out

    def all_cutouts(self):
        """Every cut-out of the score, {(t, note, style, from): [groups]}, and its host: the
        group cues.json names for that note, else its one group whose parent group is not in
        the cut-out (None when that is not unique)."""
        named = {}
        for pin in self.cues["pins"] + self.cues["develop"]:
            named.update(zip(self.attack_notes(pin["attack_t"]), pin["groups"]))
        cut = {}
        for g, e in self.piece_of_group.items():
            cut.setdefault((e["t"], e["note"], e["style"], tuple(e["from"])), []).append(g)
        hosts = {}
        for key, gs in cut.items():
            tops = [g for g in gs if self.parent_group(g) not in gs]
            hosts[key] = named.get(key[1]) if key[1] in named else (tops[0] if len(tops) == 1 else None)
        return cut, hosts

    def attack_notes(self, t):
        a = self.attacks[score_lib.nearest_attack(self.attacks, t)]
        return sorted(a[1], key=lambda i: (self.piano[i][2], i))

    def groups_of(self, events):
        return {self.leaves[e["leaf"]]["group"] for e in events}

    def group_height(self, name):
        ls = [self.leaves[i] for i in self.regions["groups"][name]]
        a = np.array([l["area"] for l in ls])
        y = np.array([l["c"][1] for l in ls])
        return 1.0 - float((a * y).sum() / a.sum())

    def stroke_height(self, sid):
        return 1.0 - float(arc_midpoint(self.strokes[sid]["pts"], self.k)[1])

    # strokes
    def test_one_gen0_stroke_per_cello_note(self):
        self.assertEqual(sorted(self.g0_by_note), list(range(len(self.cello))))
        self.assertTrue(all(len(v) == 1 for v in self.g0_by_note.values()))
        for e in self.score["strokes"]:
            self.assertEqual(e["gen"], self.strokes[e["s"]]["gen"])
            self.assertEqual(e["note"] >= 0, e["gen"] == 0)

    def test_every_stroke_once_and_done_by_the_end(self):
        ids = sorted(e["s"] for e in self.score["strokes"])
        self.assertEqual(ids, list(range(len(self.strokes))))
        for e in self.score["strokes"]:
            self.assertLessEqual(e["t"] + e["d"], END + EPS, e)
            self.assertGreater(e["d"], 0, e)

    def test_gen0_fields(self):
        for i, (t, d, pitch, vel) in enumerate(self.cello):
            e = self.g0_by_note[i][0]
            self.assertAlmostEqual(e["d"], min(d, END - t), delta=EPS)
            self.assertAlmostEqual(e["w"], vel / 127, delta=EPS)

    def test_ink_and_photo(self):
        for e in self.score["strokes"]:
            want = min(max((e["t"] - 24.9) / (28.6 - 24.9), 0.0), 1.0)
            self.assertAlmostEqual(e["ink"], want, delta=EPS)
            self.assertEqual(e["photo"], self.strokes[e["s"]]["kind"].startswith("wire"))

    def test_children_follow_their_parent(self):
        ev = {e["s"]: e for e in self.score["strokes"]}
        families = {}
        for s in self.strokes:
            if s["gen"] == 0:
                continue
            root = s
            while root["parent"] >= 0:
                root = self.strokes[root["parent"]]
            families.setdefault(root["id"], []).append(s["id"])
            e, p, r = ev[s["id"]], ev[s["parent"]], ev[root["id"]]
            self.assertGreater(e["t"], p["t"], s["id"])
            self.assertLessEqual(e["t"] + e["d"], r["t"] + 2 * BAR + EPS)
            self.assertAlmostEqual(e["w"], r["w"] * (0.6 if s["gen"] == 1 else 0.4), delta=2e-6)
        for rid, kids in families.items():
            ts = sorted([ev[rid]["t"]] + [ev[k]["t"] for k in kids])
            self.assertLessEqual(max(np.diff(ts)), BAR / 16 + EPS, rid)

    def test_wires(self):
        lo, hi = self.cues["solo_wires"]
        coda = self.sec["coda"]
        solo = [i for i, n in enumerate(self.cello) if lo <= n[0] < hi]
        tail = [i for i, n in enumerate(self.cello) if coda[0] <= n[0] < coda[1]]
        self.assertEqual((len(solo), len(tail)), (10, 12))
        for i in solo:
            self.assertEqual(self.strokes[self.g0_by_note[i][0]["s"]]["kind"], "wire_black")
        for i in tail:
            self.assertEqual(self.strokes[self.g0_by_note[i][0]["s"]]["kind"], "wire_red")
        for i, n in enumerate(self.cello):
            if not (lo <= n[0] < hi or coda[0] <= n[0] < coda[1]):
                self.assertFalse(self.strokes[self.g0_by_note[i][0]["s"]]["kind"].startswith("wire"))

    def test_last_stroke(self):
        e = self.g0_by_note[len(self.cello) - 1][0]
        self.assertTrue(self.strokes[e["s"]].get("last"))
        self.assertAlmostEqual(e["t"], 44.26, delta=0.01)
        self.assertAlmostEqual(e["d"], 0.61, delta=0.01)

    def test_section_a_strokes_lie_in_their_view_ring(self):
        cuts = [0.0] + [a[0] for a in self.chords_a[1:]] + [self.sec["A"][1]]
        frames = [score_lib.view_frame(z, self.cues["camera_center"]) for z in (8, 4, 2, 1)]
        for k in range(4):
            notes = [i for i, n in enumerate(self.cello) if cuts[k] <= n[0] < cuts[k + 1]]
            self.assertEqual(len(notes), [17, 15, 17, 16][k])
            pitch, height = [], []
            for i in notes:
                s = self.strokes[self.g0_by_note[i][0]["s"]]
                x, y = arc_midpoint(s["pts"], self.k)
                f = frames[k]
                self.assertTrue(f[0] <= x <= f[2] and f[1] <= y <= f[3], (k, i))
                if k:
                    g = frames[k - 1]
                    self.assertFalse(g[0] <= x <= g[2] and g[1] <= y <= g[3], (k, i))
                pitch.append(self.cello[i][2])
                height.append(1 - y)
            self.assertGreaterEqual(spearmanr(pitch, height)[0], 0.5, f"level {k}")

    # washes and camera
    def test_washes(self):
        w = self.score["washes"]
        self.assertEqual(len(w), 4)
        mp = {i for i, l in self.leaves.items() if l["kind"] in ("mass", "part")}
        white_box = set(self.regions["groups"]["white_box"])
        masses = {i for i, l in self.leaves.items() if l["kind"] == "mass"}
        # design 7: the room in view, the white room's shape, the blocks' shapes, the whole tower
        allowed = [mp, mp & white_box, masses, mp]
        for k, (a, zoom) in enumerate(zip(self.chords_a, (8, 4, 2, 1))):
            self.assertAlmostEqual(w[k]["t"], a[0], delta=EPS)
            self.assertAlmostEqual(w[k]["d"], max(self.piano[i][1] for i in a[1]), delta=EPS)
            self.assertAlmostEqual(w[k]["gain"], [0.20, 0.27, 0.34, 0.45][k])
            got = set(w[k]["leaves"])
            self.assertTrue(got, k)
            self.assertTrue(got <= allowed[k], k)
            f = score_lib.view_frame(zoom, self.cues["camera_center"])
            mx, my = 2 / self.regions["w"], 2 / self.regions["h"]      # 2 px inside the frame
            for i in allowed[k]:
                b = self.leaves[i]["bbox"]
                hits = b[0] < f[2] and b[2] > f[0] and b[1] < f[3] and b[3] > f[1]
                # an outline vertex well inside the frame: the leaf has pixels there
                inside = any(f[0] + mx < x < f[2] - mx and f[1] + my < y < f[3] - my
                             for ring in self.leaves[i]["polys"] for x, y in ring)
                if i in got:
                    self.assertTrue(hits, (k, i))
                if inside:
                    self.assertIn(i, got, (k, i))
        self.assertEqual(set(w[3]["leaves"]), mp)

    def test_camera(self):
        cam = self.score["camera"]
        self.assertEqual([e["t"] for e in cam], sorted(e["t"] for e in cam))
        cuts = [e for e in cam if "hold" not in e]
        self.assertEqual([e["zoom"] for e in cuts], [8, 4, 2, 1])
        self.assertEqual(cuts[0]["t"], 0)
        for e, a in zip(cuts[1:], self.chords_a[1:]):
            self.assertAlmostEqual(e["t"], a[0], delta=EPS)
        punch = [e for e in cam if "hold" in e]
        self.assertEqual(len(punch), 2)
        self.assertAlmostEqual(punch[0]["t"], self.attacks[score_lib.nearest_attack(self.attacks, 34.08)][0])
        self.assertEqual((punch[0]["zoom"], punch[0]["c"], punch[0]["hold"], punch[0]["ease"]),
                         (1.6, [0.5, 0.42], 0.10, 0.30))
        # the glue chord's small push-in (design 7), the last camera event
        last = cam[-1]
        self.assertIs(last, punch[1])
        self.assertAlmostEqual(last["t"], self.score["glue"], delta=EPS)
        self.assertEqual((last["zoom"], last["c"], last["hold"], last["ease"]), (1.04, [0.5, 0.5], 0, 0.3))

    # times
    def test_event_times_are_note_times(self):
        for e in self.score["strokes"]:
            if e["note"] >= 0:
                self.assertAlmostEqual(e["t"], self.cello[e["note"]][0], delta=EPS)
        for e in self.score["flats"] + self.score["pieces"] + self.score["collage"]["leaves"]:
            self.assertGreaterEqual(e["note"], 0)
            self.assertAlmostEqual(e["t"], self.piano[e["note"]][0], delta=EPS)

    def test_glue_and_end(self):
        self.assertEqual(self.score["end"], END)
        self.assertAlmostEqual(self.score["glue"], self.attacks[score_lib.nearest_attack(self.attacks, 41.49)][0])

    # flats
    def b_arrivals(self):
        """What arrives on the piano of B: the flats, and the collage rows of the leaves that are
        not flats (they arrive showing the collage), as (leaf, t, note)."""
        flat = {e["leaf"] for e in self.score["flats"]}
        rows = self.score["flats"] + [e for e in self.score["collage"]["leaves"] if e["leaf"] not in flat]
        return [{"leaf": e["leaf"], "t": e["t"], "note": e["note"]} for e in rows]

    def test_flats(self):
        notes = [i for i, p in enumerate(self.piano) if 15.60 <= p[0] < 30.30]
        self.assertEqual(len(notes), 128)
        self.assertIn(15.6433, [self.piano[i][0] for i in notes])
        self.assertIn(15.6913, [self.piano[i][0] for i in notes])
        arrivals = self.b_arrivals()
        by_note = {}
        for e in arrivals:
            by_note.setdefault(e["note"], []).append(e["leaf"])
        self.assertEqual(sorted(by_note), notes)
        cand = sorted(i for i, l in self.leaves.items() if l["kind"] in ("mass", "part") and l["size"] >= 1)
        self.assertEqual(len(cand), 134)
        self.assertEqual(sorted(e["leaf"] for e in arrivals), cand)
        for e in arrivals:
            self.assertNotIn(self.leaves[e["leaf"]]["kind"], ("sky", "back", "object"))
        # the flats are exactly the arrivals of the first two bars of B
        key = lambda e: (e["t"], e["note"], e["leaf"])  # noqa: E731
        early = [e for e in arrivals if e["t"] <= TWO_BARS_END]
        self.assertTrue(early)
        self.assertEqual(sorted(key(e) for e in self.score["flats"]), sorted(key(e) for e in early))
        h = lambda i: 1 - self.leaves[i]["c"][1]  # noqa: E731
        checked = 0
        for t, ix in self.attacks:
            if len(ix) == 2 and 15.60 <= t < 30.30 and all(len(by_note[i]) == 1 for i in ix):
                lo, hi = sorted(ix, key=lambda i: self.piano[i][2])
                self.assertGreater(h(by_note[hi][0]), h(by_note[lo][0]), t)
                checked += 1
        self.assertGreaterEqual(checked, 63 - 6)
        pitch = [self.piano[e["note"]][2] for e in arrivals]
        height = [h(e["leaf"]) for e in arrivals]
        self.assertGreaterEqual(spearmanr(pitch, height)[0], 0.5)

    # pieces
    def test_every_leaf_one_piece(self):
        ids = sorted(e["leaf"] for e in self.score["pieces"])
        self.assertEqual(ids, sorted(self.leaves))
        for e in self.score["pieces"]:
            self.assertLessEqual(e["t"], END)
            self.assertEqual(e["size"], self.leaves[e["leaf"]]["size"])
            self.assertIn(e["style"], ("slam", "slide", "develop", "bleed", "fold"))

    def test_a_group_arrives_together(self):
        by_leaf = {e["leaf"]: e for e in self.score["pieces"]}
        for name, ids in self.regions["groups"].items():
            first = by_leaf[ids[0]]
            for i in ids[1:]:
                e = by_leaf[i]
                self.assertEqual((e["t"], e["note"], e["style"], e["from"]),
                                 (first["t"], first["note"], first["style"], first["from"]), name)

    def test_every_late_piano_note_brings_its_own_group(self):
        notes = [i for i, p in enumerate(self.piano) if p[0] >= 30.30]
        self.assertEqual(len(notes), 87)
        self.assertEqual(sorted(self.pieces_by_note), notes)
        self.assertEqual(sorted(self.own), notes)
        self.assertEqual(len(set(self.own.values())), 87)
        for i in notes:
            self.assertIn(self.own[i], self.groups_of(self.pieces_by_note[i]), i)   # riders are extra

    def test_pins_lowest_note_first(self):
        for pin in self.cues["pins"] + self.cues["develop"]:
            notes = self.attack_notes(pin["attack_t"])
            cut = self.cutouts(pin["attack_t"])
            for i, g in zip(notes, pin["groups"]):
                self.assertEqual(cut[i][0], g, pin)
                want = pin.get("style", "develop" if pin in self.cues["develop"] else None)
                e = self.piece_of_group[g]
                self.assertEqual(e["style"], want or ("develop" if self.piano[i][1] >= 1 else "slam"), pin)

    def test_star_arrivals(self):
        """At each star attack, what arrives is one cut-out per note (a host and its riders)."""
        climb = [a for a in self.attacks if 34.37 - 0.03 <= a[0] <= 37.09 + 0.03]
        self.assertEqual(len(climb), 12)                      # 35.24 (the rooms) is one of them
        stars = [(30.32, 1), (34.08, 5), (37.81, 7), (41.49, 6)] + [(a[0], len(a[1])) for a in climb]
        for t, k in stars:
            cut = self.cutouts(t)
            self.assertEqual(len(cut), k, t)
            self.assertEqual(len({host for host, _ in cut.values()}), k, t)
            self.assertEqual(sorted(cut), sorted(self.attack_notes(t)), t)
        self.assertEqual([g for _, gs in self.cutouts(30.32).values() for g in gs], ["sky"])

    def test_star_moments(self):
        hosts = lambda t: {h for h, _ in self.cutouts(t).values()}  # noqa: E731
        arrived = lambda t: [g for _, gs in self.cutouts(t).values() for g in gs]  # noqa: E731
        self.assertEqual(hosts(30.32), {"sky"})
        self.assertEqual(self.piece_of_group["sky"]["style"], "slide")
        self.assertEqual(hosts(34.08), {"white_box", "glass_room", "grand_piano", "room_plant", "room_figure"})
        blocks = {"red_block_left", "blue_block", "red_block_top"}
        self.assertTrue(blocks <= hosts(37.81))
        self.assertTrue(all(self.piece_of_group[g]["style"] == "fold" for g in arrived(37.81)))
        self.assertTrue({"base_houses", "pole_left", "wall_coral"} <= hosts(41.49))
        self.assertEqual(hosts(35.24), {"blue_room", "red_room"})
        self.assertTrue(all(self.piece_of_group[g]["style"] == "develop" for g in arrived(35.24)))

    def test_the_climb(self):
        steps = [a for a in self.attacks if 34.37 - 0.03 <= a[0] <= 37.09 + 0.03]
        self.assertEqual(len(steps), 12)
        host = {}
        for a in steps:
            host.update({i: h for i, (h, _) in self.cutouts(a[0]).items()})
        notes = sorted((i for a in steps for i in a[1]), key=lambda i: (self.piano[i][0], i))
        self.assertEqual(len(notes), 13)
        heights = [self.group_height(host[i]) for i in notes]
        self.assertGreaterEqual(spearmanr(range(13), heights)[0], 0.8, heights)
        pinned = [a for a in steps if len(a[1]) == 1]
        self.assertEqual(len(pinned), 11)
        pin_ts = [p["attack_t"] for p in self.cues["pins"]]
        h = []
        for a in pinned:
            self.assertTrue(any(abs(a[0] - t) <= 0.03 for t in pin_ts), a[0])
            h.append(self.group_height(host[a[1][0]]))
        self.assertTrue(all(x < y for x, y in zip(h, h[1:])), h)

    def test_block_pins(self):
        blocks = {"red_block_left", "blue_block", "red_block_top"}
        upper = self.attack_notes(37.81)[3:]
        self.assertEqual(len(upper), 4)
        cut = self.cutouts(37.81)
        hit = set()
        for i in upper:
            g = cut[i][0]
            parents = {self.leaves[self.leaves[l]["parent"]]["group"] for l in self.regions["groups"][g]
                       if self.leaves[l]["parent"] in self.leaves}
            self.assertTrue(parents & blocks, g)
            hit |= parents & blocks
            self.assertEqual(self.piece_of_group[g]["style"], "fold")
        self.assertEqual(hit, blocks)

    def test_the_run(self):
        lo, hi = self.cues["run"]
        notes = [i for i, p in enumerate(self.piano) if lo <= p[0] < hi]
        self.assertEqual(len(notes), 12)
        for i in notes:
            self.assertGreaterEqual(self.area[self.own[i]], make_score.A_MED, i)
        rho = spearmanr([self.piano[i][2] for i in notes], [self.group_height(self.own[i]) for i in notes])[0]
        self.assertGreaterEqual(rho, 0.8)

    def test_the_six_high_chords(self):
        pinned = {n for pin in self.cues["pins"] + self.cues["develop"] for n in pin["groups"]}
        for g, e in self.piece_of_group.items():
            if not 39.0 <= e["t"] <= 41.1:
                continue
            self.assertFalse(self.kinds_of(g) & {"mass", "back", "sky"}, g)
            if self.area[g] >= make_score.A_MED and g not in pinned:
                p = self.parent_group(g)
                self.assertIsNotNone(p, g)
                self.assertEqual((self.piece_of_group[p]["t"], self.piece_of_group[p]["note"]), (e["t"], e["note"]), g)

    def test_rule_pools(self):
        pinned = {i for pin in self.cues["pins"] + self.cues["develop"]
                  for i in self.attack_notes(pin["attack_t"])[:len(pin["groups"])]}
        chords = {i for a in self.attacks if 39.02 - 0.03 <= a[0] <= 41.05 + 0.03 for i in a[1]}
        self.assertEqual(len(chords), 33)
        rule = sorted((i for i in self.own if i not in pinned), key=lambda i: (self.piano[i][0], i))
        owned = set(self.own.values())
        pinned_groups = {n for pin in self.cues["pins"] + self.cues["develop"] for n in pin["groups"]}
        top = {g for g in self.regions["groups"] if g not in pinned_groups
               and self.area[g] >= make_score.A_MED and self.parent_group(g) is None}
        outer = [i for i in rule if i not in chords]
        kids = [i for i in outer if self.own[i] not in top]
        # children (groups with a parent group) only once the top-level pool has run out ...
        self.assertEqual(len(kids), max(0, len(outer) - len(top)), kids)
        if kids:
            self.assertTrue(top <= owned, sorted(top - owned))
            # ... and only for the last notes served (no top-level group goes to a later attack)
            last = min(self.piano[i][0] for i in kids)
            self.assertFalse([i for i in outer if self.own[i] in top and self.piano[i][0] > last + 0.03])
        for k, i in enumerate(rule):
            g = self.own[i]
            if i in chords:
                self.assertLess(self.area[g], make_score.A_MED, g)
                self.assertFalse(self.kinds_of(g) & {"mass", "back", "sky"}, g)
                continue
            self.assertGreaterEqual(self.area[g], make_score.A_MED, g)
            if self.piano[i][2] < 48:            # the largest medium-or-larger group still free
                later = {self.own[j] for j in rule[k + 1:]} | (set(self.regions["groups"]) - owned)
                self.assertTrue(all(self.area[g] >= self.area[x] for x in later), g)

    def test_riders(self):
        """A group no note took arrives with its parent group; with no parent, a small one rides
        on one of the six high chords and a medium-or-larger one with the nearest group placed
        outside them."""
        owned = set(self.own.values())
        chords = {i for a in self.attacks if 39.02 - 0.03 <= a[0] <= 41.05 + 0.03 for i in a[1]}
        key = lambda e: (e["t"], e["note"], e["style"], e["from"])  # noqa: E731
        aspect = self.regions["w"] / self.regions["h"]
        centre = {}
        for g, ids in self.regions["groups"].items():
            ls = [self.leaves[i] for i in ids]
            centre[g] = (sum(l["area"] * l["c"][0] for l in ls) / self.area[g] * aspect,
                         sum(l["area"] * l["c"][1] for l in ls) / self.area[g])
        outside = [g for g in owned if not 39.0 <= self.piece_of_group[g]["t"] <= 41.1]
        for g in sorted(set(self.regions["groups"]) - owned):
            e = self.piece_of_group[g]
            p = self.parent_group(g)
            if p is not None:
                self.assertEqual(key(e), key(self.piece_of_group[p]), g)
            elif self.area[g] < make_score.A_MED and not self.kinds_of(g) & {"mass", "back", "sky"}:
                self.assertIn(e["note"], chords, g)
            else:
                near = min(outside, key=lambda o: (math.dist(centre[g], centre[o]), o))
                self.assertEqual(key(e), key(self.piece_of_group[near]), g)

    def test_piece_from(self):
        aspect = self.regions["w"] / self.regions["h"]
        for e in self.score["pieces"]:
            dx, dy, rot, s = e["from"]
            self.assertTrue(0.03 - EPS <= math.hypot(dx, dy) <= 0.08 + EPS, e)
            self.assertTrue(-6 <= rot <= 6 and 1.08 <= s <= 1.20, e)
            g = self.leaves[e["leaf"]]["group"]
            ls = [self.leaves[i] for i in self.regions["groups"][g]]
            a = sum(l["area"] for l in ls)
            cx = sum(l["area"] * l["c"][0] for l in ls) / a
            cy = sum(l["area"] * l["c"][1] for l in ls) / a
            self.assertGreater(dx * (cx - 0.5) * aspect + dy * (cy - 0.5), 0, e)

    # the file
    def test_made_from_this_region_map(self):
        self.assertEqual(self.score["regions"], self.regions["fingerprint"])

    def test_same_bytes_every_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            outs = []
            for seed in ("0", "4242"):
                out = os.path.join(tmp, f"score_{seed}.json")
                env = dict(os.environ, PYTHONHASHSEED=seed)
                subprocess.run([sys.executable, os.path.join(HERE, "make_score.py"), "--out", out,
                                "--table", os.path.join(tmp, f"table_{seed}.txt")],
                               check=True, env=env, capture_output=True)
                with open(out, "rb") as f:
                    outs.append(f.read())
        self.assertEqual(outs[0], outs[1])
        self.assertNotIn(b"\r", outs[0])
        self.assertEqual(outs[0], make_score.dumps(self.score).encode("utf-8"))

    def test_committed_score_is_current(self):
        with open(os.path.join(ROOT, "assets", "score.json"), "rb") as f:
            self.assertEqual(f.read(), make_score.dumps(self.score).encode("utf-8"))


class CollageScoreTest(unittest.TestCase):
    """The collage of the score, checked against assets/collage.json, the music and the pieces."""

    @classmethod
    def setUpClass(cls):
        cls.score = make_score.build()
        cls.col = cls.score["collage"]
        cls.manifest = load("assets", "collage.json")
        cls.music = load("assets", "music.json")
        cls.regions = load("assets", "regions.json")
        cls.cues = load("data", "cues.json")
        cls.cello, cls.piano, cls.attacks = cls.music["cello"], cls.music["piano"], cls.music["attacks"]
        cls.glue = cls.score["glue"]
        cls.area = {l["id"]: l["area"] for l in cls.regions["leaves"]}
        cls.on_off = {}                                        # block row -> [(t, off, area)]
        for e in cls.col["leaves"]:
            cls.on_off.setdefault(e["block"], []).append((e["t"], e["off"], cls.area[e["leaf"]]))
        lo, hi = cls.cues["solo_wires"]
        cls.changeable = [i for i, c in enumerate(cls.cello) if c[0] < cls.glue and not lo <= c[0] < hi]

    def on_screen(self, t):
        """{block row: area of its leaves showing the collage at t} for the blocks on screen at t."""
        out = {}
        for b, ls in self.on_off.items():
            if any(on <= t < off for on, off, _ in ls):
                out[b] = sum(a for on, off, a in ls if on <= t < off)
        return out

    def events(self, k):
        return self.col["changes"][k]["events"]

    def test_shape(self):
        self.assertEqual(list(self.col["changes"]), list(STRENGTHS))
        self.assertEqual(self.col["default"], "high")
        self.assertEqual(self.col["limits"], LIMITS)
        self.assertAlmostEqual(self.col["two_bars_end"], TWO_BARS_END, delta=EPS)
        self.assertEqual([b["name"] for b in self.col["blocks"]], [b["name"] for b in self.manifest["blocks"]])
        rows = self.col["leaves"]
        self.assertEqual(len(rows), 134)
        self.assertEqual(rows, sorted(rows, key=lambda e: (e["t"], e["leaf"])))
        block_of = {i: b for b, mb in enumerate(self.manifest["blocks"]) for i in mb["leaves"]}
        self.assertEqual(sorted(e["leaf"] for e in rows), sorted(block_of))
        for e in rows:
            self.assertEqual(e["block"], block_of[e["leaf"]], e)
        for k in STRENGTHS:
            self.assertEqual(len(self.col["changes"][k]["start"]), len(self.manifest["blocks"]))
            ev = self.events(k)
            self.assertEqual([e["t"] for e in ev], sorted(e["t"] for e in ev), k)

    def test_flats_are_covered(self):
        limit = TWO_BARS_END + 2 * BAR
        self.assertAlmostEqual(self.col["cover_by"], max(a[0] for a in self.attacks if a[0] < limit), delta=EPS)
        self.assertLess(self.col["cover_by"], 23.08)
        row = {e["leaf"]: e for e in self.col["leaves"]}
        flat = {e["leaf"] for e in self.score["flats"]}
        later = {}                                     # block -> its first arrival after the two bars
        for e in self.col["leaves"]:
            if e["leaf"] not in flat:
                later[e["block"]] = min(later.get(e["block"], 99.0), e["t"])
        for e in self.score["flats"]:
            self.assertLessEqual(e["until"], self.col["cover_by"] + EPS, e)
            self.assertLess(e["until"], 30.30, e)
            r = row[e["leaf"]]
            self.assertAlmostEqual(e["until"], min(later.get(r["block"], 99.0), self.col["cover_by"]), delta=EPS)
            # the collage takes over at until, on the lowest-numbered piano note of that time
            self.assertAlmostEqual(r["t"], e["until"], delta=EPS)
            self.assertEqual(r["note"], min(i for i, p in enumerate(self.piano) if abs(p[0] - r["t"]) <= EPS))

    def test_first_and_stop(self):
        piece = {e["leaf"]: e for e in self.score["pieces"]}
        for b, (row, mb) in enumerate(zip(self.col["blocks"], self.manifest["blocks"])):
            self.assertAlmostEqual(row["first"], min(t for t, _, _ in self.on_off[b]), delta=EPS)
            big = max(mb["leaves"], key=lambda i: (self.area[i], -i))
            self.assertAlmostEqual(row["stop"], min(self.glue, piece[big]["t"]), delta=EPS, msg=mb["name"])

    def test_off_and_tear(self):
        piece = {e["leaf"]: e for e in self.score["pieces"]}
        biggest = {}
        for e in self.score["pieces"]:
            biggest[e["t"], e["note"]] = max(biggest.get((e["t"], e["note"]), 0), e["size"])
        for e in self.col["leaves"]:
            p = piece[e["leaf"]]
            self.assertEqual(e["off"], p["t"], e)
            want = biggest[p["t"], p["note"]] >= make_score.TEAR_MIN_SIZE and p["style"] in ("slam", "fold", "slide") \
                and e["off"] < self.glue
            self.assertEqual(e["tear"], want, e)
        self.assertEqual(make_score.TEAR_MIN_SIZE, 3)
        self.assertTrue(any(e["tear"] for e in self.col["leaves"]))
        self.assertFalse(all(e["tear"] for e in self.col["leaves"]))

    def test_what_is_left_after_the_glue_chord(self):
        chord = self.attacks[score_lib.nearest_attack(self.attacks, 41.49)]
        last = max(self.piano[i][0] for i in chord[1])
        left = sorted(e["leaf"] for e in self.col["leaves"] if e["off"] > last)
        groups = ["coral_tree_%d" % k for k in range(1, 6)] + ["white_square_a", "white_square_b"]
        self.assertEqual(left, sorted(i for g in groups for i in self.regions["groups"][g]))
        times = [self.piano[i][0] for t in (42.59, 43.02, 43.46, 43.86)
                 for i in self.attacks[score_lib.nearest_attack(self.attacks, t)][1]]
        for e in self.col["leaves"]:
            if e["off"] > last:
                self.assertTrue(any(abs(e["off"] - x) <= EPS for x in times), e)

    def test_when_images_change(self):
        self.assertEqual(self.cues["solo_wires"], [31.75, 34.05])
        for k in STRENGTHS:
            for e in self.events(k):
                self.assertFalse(31.75 <= e["t"] < 34.05, (k, e))
                self.assertLess(e["t"], self.glue, (k, e))
                self.assertAlmostEqual(e["t"], self.cello[e["note"]][0], delta=EPS)

    def test_area_per_note(self):
        for k in STRENGTHS:
            per = {}
            for e in self.events(k):
                screen = self.on_screen(e["t"])
                self.assertIn(e["block"], screen, (k, e))
                per[e["note"]] = per.get(e["note"], 0.0) + screen[e["block"]]
            self.assertTrue(per, k)
            self.assertLessEqual(max(per.values()), 0.22 + 1e-9, k)

    def test_gaps(self):
        for k in STRENGTHS:
            last = {}
            for e in self.events(k):
                b = e["block"]
                if b in last:
                    gap = 3 if len(self.on_screen(e["t"])) < 6 else 2
                    self.assertGreaterEqual(e["note"] - last[b], gap, (k, e, last[b]))
                last[b] = e["note"]

    def test_cuts_within_first_and_stop(self):
        for k in STRENGTHS:
            ch = self.col["changes"][k]
            for b, (row, mb) in enumerate(zip(self.col["blocks"], self.manifest["blocks"])):
                mine = [e for e in ch["events"] if e["block"] == b]
                for e in mine:
                    self.assertTrue(row["first"] <= e["t"] < row["stop"], (k, mb["name"], e))
                seq = [ch["start"][b]] + [e["to"] for e in mine]
                self.assertEqual(len(set(seq)), len(seq), (k, mb["name"], seq))
                self.assertTrue(all(0 <= x < len(mb["cuts"]) for x in seq), (k, mb["name"]))

    def test_accent_shown_at_stop(self):
        accents = [b for b, mb in enumerate(self.manifest["blocks"]) if mb["accent"] >= 0]
        self.assertEqual(len(accents), 5)
        for k in STRENGTHS:
            ch = self.col["changes"][k]
            for b in accents:
                mine = [e for e in ch["events"] if e["block"] == b]
                shown = mine[-1]["to"] if mine else ch["start"][b]
                self.assertEqual(shown, self.manifest["blocks"][b]["accent"], (k, b))

    def test_accent_seen_before_stop(self):
        """Every accent is on screen for at least ACCENT_MIN before its block's stop: from the
        change to it, or from the block's first when it is the start cut."""
        self.assertEqual(make_score.ACCENT_MIN, 1.0)
        for k in STRENGTHS:
            ch = self.col["changes"][k]
            for b, mb in enumerate(self.manifest["blocks"]):
                if mb["accent"] < 0:
                    continue
                row = self.col["blocks"][b]
                mine = [e for e in ch["events"] if e["block"] == b]
                if mine:
                    self.assertEqual(mine[-1]["to"], mb["accent"], (k, mb["name"]))
                else:
                    self.assertEqual(ch["start"][b], mb["accent"], (k, mb["name"]))
                since = mine[-1]["t"] if mine else row["first"]
                self.assertGreaterEqual(row["stop"] - since, make_score.ACCENT_MIN - 1e-6, (k, mb["name"], since))

    def test_make_score_stops_on_a_broken_collage(self):
        """make_score checks the collage (design 10.4) before it writes anything."""
        inp = make_score.load_inputs()

        def stops(change, *words):
            s = copy.deepcopy(self.score)
            change(s)
            with self.assertRaises(SystemExit) as cm:
                make_score.check_collage(s, inp["music"], inp["regions"], inp["collage"], inp["cues"])
            for w in words:
                self.assertIn(w, str(cm.exception))

        make_score.check_collage(copy.deepcopy(self.score), inp["music"], inp["regions"], inp["collage"], inp["cues"])
        stops(lambda s: s["flats"][0].update(until=25.0), "flat", "covered")
        accent = next(b for b, mb in enumerate(self.manifest["blocks"]) if mb["accent"] >= 0)
        last = lambda s: [e for e in s["collage"]["changes"]["calm"]["events"] if e["block"] == accent][-1]  # noqa: E731
        stops(lambda s: last(s).update(to=47), "calm", "accent")
        first = lambda s: next(e for e in s["collage"]["changes"]["mid"]["events"] if e["block"] == 3)  # noqa: E731
        stops(lambda s: first(s).update(to=s["collage"]["changes"]["mid"]["start"][3]), "mid", "twice")
        solo = next(i for i, c in enumerate(self.cello) if 31.75 <= c[0] < 34.05)

        def in_solo(s):
            ev = s["collage"]["changes"]["high"]["events"]
            ev.append({"t": self.cello[solo][0], "note": solo, "block": 3, "to": 47})
            ev.sort(key=lambda e: e["t"])
        stops(in_solo, "high", "cello note")
        stops(lambda s: s["collage"]["leaves"][0].update(off=s["collage"]["leaves"][0]["off"] + 1.0), "leaf")

        def accent_late(s):          # the block's photo comes half a second after its accent
            s["collage"]["blocks"][accent]["stop"] = round(last(s)["t"] + 0.5, 6)
        stops(accent_late, "calm", "accent", "before")

    def test_strengths(self):
        dense = [i for i in self.changeable if len(self.on_screen(self.cello[i][0])) >= 20]
        self.assertGreaterEqual(len(dense), 10)
        screen = np.mean([len(self.on_screen(self.cello[i][0])) for i in dense])
        got = {}
        for k in STRENGTHS:
            count, area = {i: 0 for i in dense}, {i: 0.0 for i in dense}
            for e in self.events(k):
                if e["note"] in count:
                    count[e["note"]] += 1
                    area[e["note"]] += self.on_screen(e["t"])[e["block"]]
            got[k] = (np.mean(list(count.values())), np.mean(list(area.values())))
        self.assertTrue(2 <= got["calm"][0] <= 4, got)
        self.assertGreaterEqual(got["high"][1], 0.18, got)
        self.assertTrue(0.3 <= got["high"][0] / screen <= 0.6, (got, screen))
        n = {k: len(self.events(k)) for k in STRENGTHS}
        self.assertTrue(n["calm"] < n["mid"] < n["high"], n)


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import strokes_lib  # noqa: E402


def seg_dist(p, a, b):
    """Distance from point p to segment ab (all 2-vectors)."""
    p, a, b = (np.asarray(v, float) for v in (p, a, b))
    ab = b - a
    t = np.clip((p - a) @ ab / (ab @ ab), 0.0, 1.0)
    return float(np.hypot(*(p - (a + t * ab))))


def length(pts):
    p = np.asarray(pts, float)
    return float(np.hypot(*np.diff(p, axis=0).T).sum())


class RingsToStrokesTest(unittest.TestCase):
    def test_rectangle_gives_four_sides(self):
        # a rectangle with extra points along its sides (as region rings have)
        ring = [[0.1, 0.1], [0.3, 0.1], [0.5, 0.1], [0.5, 0.2], [0.5, 0.3],
                [0.3, 0.3], [0.1, 0.3], [0.1, 0.2]]
        strokes = strokes_lib.rings_to_strokes([ring])
        self.assertEqual(len(strokes), 4)
        corners = {(0.1, 0.1), (0.5, 0.1), (0.5, 0.3), (0.1, 0.3)}
        for s in strokes:
            ends = {tuple(np.round(s[0], 9)), tuple(np.round(s[-1], 9))}
            self.assertTrue(ends <= corners, ends)
        self.assertAlmostEqual(sum(length(s) for s in strokes), 2 * (0.4 + 0.2))

    def test_near_circle_gives_one_closed_stroke(self):
        rng = np.random.default_rng(0)
        a = np.linspace(0, 2 * np.pi, 72, endpoint=False)
        r = 0.2 * (1 + 0.01 * rng.standard_normal(len(a)))
        ring = np.stack([0.5 + r * np.cos(a), 0.5 + r * np.sin(a)], 1).tolist()
        strokes = strokes_lib.rings_to_strokes([ring])
        self.assertEqual(len(strokes), 1)
        s = np.asarray(strokes[0])
        self.assertTrue(np.allclose(s[0], s[-1]))           # closed
        self.assertEqual(len(s), len(ring) + 1)

    def test_each_ring_is_split_on_its_own(self):
        square = [[0, 0], [1, 0], [1, 1], [0, 1]]
        hole = [[0.4, 0.4], [0.4, 0.6], [0.6, 0.6], [0.6, 0.4]]
        self.assertEqual(len(strokes_lib.rings_to_strokes([square, hole])), 8)


class BoundaryRunsTest(unittest.TestCase):
    LEFT = {"id": 1, "polys": [[[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]]}
    RIGHT = {"id": 2, "polys": [[[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]]]}

    def runs_of(self, runs, leaf):
        return {(nb, tuple(map(tuple, pts))) for lid, nb, pts, closed in runs if lid == leaf}

    def test_shared_and_border_runs(self):
        runs = strokes_lib.boundary_runs([self.LEFT, self.RIGHT])
        left = self.runs_of(runs, 1)
        self.assertIn((2, ((0.5, 0.0), (0.5, 1.0))), left)
        self.assertEqual({nb for nb, _ in left}, {2, strokes_lib.BORDER})
        border = [pts for nb, pts in left if nb == strokes_lib.BORDER]
        self.assertEqual(sum(len(p) - 1 for p in border), 3)     # three sides on the frame

    def test_unmatched_stretch_is_not_border(self):
        # the right leaf has an extra vertex on the shared side: its segments have no reverse
        right = {"id": 2, "polys": [[[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0], [0.5, 0.5]]]}
        runs = strokes_lib.boundary_runs([self.LEFT, right])
        self.assertIn((strokes_lib.UNMATCHED, ((0.5, 0.0), (0.5, 1.0))), self.runs_of(runs, 1))
        self.assertIn((strokes_lib.UNMATCHED, ((0.5, 1.0), (0.5, 0.5), (0.5, 0.0))),
                      self.runs_of(runs, 2))

    def test_unmatched_stretch_stays_a_stroke(self):
        import make_strokes
        right = {"id": 2, "polys": [[[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0], [0.5, 0.5]]]}
        leaves = [dict(self.LEFT, name="a", group="a", area=0.5, bbox=[0, 0, 0.5, 1]),
                  dict(right, name="b", group="b", area=0.5, bbox=[0.5, 0, 1, 1])]
        out, unmatched = make_strokes.edge_strokes(leaves, make_strokes.Space(100, 100))
        self.assertEqual(unmatched, 3)                       # 1 segment of a, 2 of b
        self.assertEqual(sorted(s["leaf"] for s in out), [1, 2])
        self.assertTrue(all("leaf2" not in s for s in out))


class ClipTest(unittest.TestCase):
    BOX = (0.0, 0.0, 1.0, 1.0)

    def test_overshoot_is_cut_at_the_frame(self):
        out = strokes_lib.clip_polyline([[-0.1, 0.5], [1.2, 0.5]], self.BOX)
        self.assertEqual(out, [[[0.0, 0.5], [1.0, 0.5]]])

    def test_oblique_line_stays_on_its_line(self):
        a, b = np.array([-0.2, 0.1]), np.array([0.8, 0.6])
        (piece,) = strokes_lib.clip_polyline([a.tolist(), b.tolist()], self.BOX)
        np.testing.assert_allclose(piece, [[0.0, 0.2], [0.8, 0.6]])
        d = b - a
        for p in piece:                                       # on the original line
            q = np.asarray(p) - a
            self.assertAlmostEqual(float(q[0] * d[1] - q[1] * d[0]), 0.0)

    def test_out_and_back_gives_two_pieces_and_outside_gives_none(self):
        out = strokes_lib.clip_polyline([[0.5, 0.5], [1.5, 0.5], [1.5, 0.7], [0.5, 0.7]], self.BOX)
        self.assertEqual(out, [[[0.5, 0.5], [1.0, 0.5]], [[1.0, 0.7], [0.5, 0.7]]])
        self.assertEqual(strokes_lib.clip_polyline([[1.1, 0.1], [1.3, 0.9]], self.BOX), [])

    def test_inside_is_unchanged(self):
        pts = [[0.1, 0.1], [0.2, 0.3], [0.9, 0.95]]
        self.assertEqual(strokes_lib.clip_polyline(pts, self.BOX), [pts])


class StraightenTest(unittest.TestCase):
    def test_wobbly_line_becomes_two_points(self):
        rng = np.random.default_rng(1)
        t = np.linspace(0, 1, 40)
        pts = np.stack([0.1 + 0.6 * t, 0.2 + 0.3 * t], 1)
        pts[1:-1] += rng.uniform(-0.0007, 0.0007, (38, 2))
        out = strokes_lib.straighten(pts.tolist())
        self.assertEqual(len(out), 2)
        np.testing.assert_allclose(out, [pts[0], pts[-1]])

    def test_corner_shape_stays(self):
        pts = [[0.1, 0.1], [0.2, 0.1], [0.3, 0.1], [0.3, 0.2], [0.3, 0.3]]
        self.assertEqual(strokes_lib.straighten(pts), pts)


class OvershootTest(unittest.TestCase):
    def test_ends_go_out_along_the_line(self):
        a, b = np.array([0.2, 0.3]), np.array([0.5, 0.7])       # length 0.5
        out = np.asarray(strokes_lib.overshoot([a.tolist(), b.tolist()], 0.1, seed=7))
        self.assertEqual(out.shape, (2, 2))
        u = (b - a) / 0.5
        for p, end, sign in ((out[0], a, -1), (out[1], b, 1)):
            d = p - end
            self.assertAlmostEqual(float(d[0] * u[1] - d[1] * u[0]), 0.0)   # on the line
            along = sign * float(d @ u)                                      # outward
            self.assertGreaterEqual(along, 0.5 * 0.1 * 0.5 - 1e-12)
            self.assertLessEqual(along, 1.5 * 0.1 * 0.5 + 1e-12)

    def test_frac_is_the_mean_overshoot(self):
        a, b = [0.0, 0.0], [1.0, 0.0]
        ext = [(-strokes_lib.overshoot([a, b], 0.05, seed=s)[0][0],
                strokes_lib.overshoot([a, b], 0.05, seed=s)[1][0] - 1.0) for s in range(400)]
        self.assertAlmostEqual(float(np.mean(ext)), 0.05, delta=0.003)

    def test_same_seed_same_result(self):
        pts = [[0.1, 0.1], [0.4, 0.2]]
        self.assertEqual(strokes_lib.overshoot(pts, 0.08, seed=3),
                         strokes_lib.overshoot(pts, 0.08, seed=3))
        self.assertNotEqual(strokes_lib.overshoot(pts, 0.08, seed=3),
                            strokes_lib.overshoot(pts, 0.08, seed=4))

    def test_curved_stroke_is_left_alone(self):
        pts = [[0.1, 0.1], [0.2, 0.15], [0.3, 0.1]]
        self.assertEqual(strokes_lib.overshoot(pts, 0.1, seed=1), pts)

    def test_extend_adds_a_point_beyond_each_end(self):
        pts = [[0.0, 0.0], [0.5, 0.01], [10.0, 0.0], [20.0, 0.0]]   # a small hook at the start
        out = np.asarray(strokes_lib.extend(pts, 3.0, span=8.0))
        self.assertEqual(len(out), 6)
        np.testing.assert_allclose(out[-1], [23.0, 0.0])
        self.assertAlmostEqual(float(np.hypot(*(out[0] - out[1]))), 3.0)
        self.assertLess(out[0][0], -2.9)                 # along the line, not the hook


class TraceWiresTest(unittest.TestCase):
    def check_line(self, thickness):
        mask = np.zeros((140, 220), np.uint8)
        p0, p1 = (15, 20), (200, 110)                      # (x, y) pixel indices
        cv2.line(mask, p0, p1, 1, thickness)
        lines = strokes_lib.trace_wires(mask.astype(bool))
        self.assertEqual(len(lines), 1)
        a, b = np.add(p0, 0.5), np.add(p1, 0.5)            # pixel centres
        pts = np.asarray(lines[0])
        for p in pts:
            self.assertLessEqual(seg_dist(p, a, b), 1.0)
        ends = sorted([pts[0].tolist(), pts[-1].tolist()])
        self.assertLessEqual(np.hypot(*(np.asarray(ends[0]) - a)), 1.5)
        self.assertLessEqual(np.hypot(*(np.asarray(ends[1]) - b)), 1.5)

    def test_diagonal_comes_back_within_one_pixel(self):
        self.check_line(1)

    def test_thick_diagonal_comes_back_within_one_pixel(self):
        self.check_line(3)

    def test_crossing_lines_stay_two_lines(self):
        mask = np.zeros((200, 200), np.uint8)
        cv2.line(mask, (10, 30), (190, 170), 1, 3)
        cv2.line(mask, (10, 160), (190, 40), 1, 3)
        lines = strokes_lib.trace_wires(mask.astype(bool))
        self.assertEqual(len(lines), 2)
        for line in lines:
            p = np.asarray(line)
            self.assertGreater(length(p), 200)
            chord = (p[0], p[-1])
            self.assertLess(max(seg_dist(q, *chord) for q in p), 2.0)   # straight through


class JoinPiecesTest(unittest.TestCase):
    def test_collinear_pieces_join_and_others_do_not(self):
        a = [[0.0, 0.0], [10.0, 1.0], [20.0, 2.0]]
        b = [[45.0, 4.5], [30.0, 3.0]]                 # same line, reversed, 10 apart
        c = [[22.0, 12.0], [40.0, 30.0]]               # near, but at 45 degrees
        d = [[100.0, 10.0], [120.0, 12.0]]             # same line, too far
        out = strokes_lib.join_pieces([a, b, c, d], max_gap=20)
        self.assertEqual(len(out), 3)
        joined = [p for p in out if len(p) == 5][0]
        self.assertEqual(sorted([joined[0], joined[-1]]), [[0.0, 0.0], [45.0, 4.5]])
        self.assertTrue(np.all(np.diff(np.asarray(joined)[:, 0]) > 0))   # one direction

    def test_chain_along_orders_pieces(self):
        guide = [[0.0, 0.0], [100.0, 0.0]]
        pieces = [[[70.0, 1.0], [90.0, 1.0]], [[30.0, -1.0], [10.0, -1.0]]]
        out = strokes_lib.chain_along(pieces, guide)
        self.assertEqual(out, [[10.0, -1.0], [30.0, -1.0], [70.0, 1.0], [90.0, 1.0]])


class AssignGenerationsTest(unittest.TestCase):
    def square(self, x0, y0, s, sx=None):
        sx = s if sx is None else sx
        c = [[x0, y0], [x0 + sx, y0], [x0 + sx, y0 + s], [x0, y0 + s]]
        box = [x0, y0, x0 + sx, y0 + s]
        region = (x0, y0)
        return [{"pts": [c[i], c[(i + 1) % 4]], "box": box, "region": region} for i in range(4)]

    def test_sides_of_one_region_are_siblings(self):
        big = self.square(0.1, 0.1, 0.3, sx=0.6)       # a long rectangle: unequal sides
        small = self.square(0.3, 0.2, 0.05)
        out = strokes_lib.assign_generations(big + small)
        self.assertEqual([s["gen"] for s in out], [0] * 4 + [1] * 4)

    def test_square_in_square(self):
        big = self.square(0.1, 0.1, 0.6)
        small = self.square(0.3, 0.3, 0.1)
        out = strokes_lib.assign_generations(small + big)
        self.assertEqual([s["gen"] for s in out[4:]], [0, 0, 0, 0])
        self.assertTrue(all(s["parent"] == -1 for s in out[4:]))
        for s in out[:4]:
            self.assertEqual(s["gen"], 1)
            self.assertIn(s["parent"], [4, 5, 6, 7])

    def test_third_level_and_zones(self):
        big = self.square(0.0, 0.0, 0.8)
        mid = self.square(0.1, 0.1, 0.3)
        tiny = self.square(0.15, 0.15, 0.05)
        other = self.square(0.5, 0.5, 0.1)
        for s in other:
            s["zone"] = 1                     # another zone: never a child of the big square
        out = strokes_lib.assign_generations(big + mid + tiny + other)
        self.assertEqual([s["gen"] for s in out], [0] * 4 + [1] * 4 + [2] * 4 + [0] * 4)
        for s in out[8:12]:
            self.assertIn(s["parent"], [4, 5, 6, 7])

    def test_not_a_container_and_never_gen0(self):
        wire = {"pts": [[0.0, 0.5], [1.0, 0.5]], "box": None, "family": "wire"}  # contains nothing
        line = {"pts": [[0.4, 0.49], [0.6, 0.49]]}
        mark = {"pts": [[0.9, 0.9], [0.92, 0.92]], "gen0": False}
        out = strokes_lib.assign_generations([wire, line, mark])
        self.assertEqual([s["gen"] for s in out], [0, 0, 1])
        self.assertEqual(out[2]["parent"], 1)          # nearest line of its family

    def test_demote_keeps_a_tree(self):
        big = self.square(0.1, 0.1, 0.6)
        inner = self.square(0.2, 0.2, 0.1)
        far = self.square(0.85, 0.85, 0.05)
        out = strokes_lib.assign_generations(big + inner + far)
        self.assertEqual([s["gen"] for s in out], [0] * 4 + [1] * 4 + [0] * 4)
        # keep one side of the big square and nothing else
        dem = strokes_lib.demote(out, keep={0})
        self.assertEqual(dem[0]["gen"], 0)
        for i in (1, 2, 3):                          # same region -> under the kept side
            self.assertEqual((dem[i]["gen"], dem[i]["parent"]), (1, 0))
        for i in range(8, 12):                        # nowhere inside -> nearest kept stroke
            self.assertEqual((dem[i]["gen"], dem[i]["parent"]), (1, 0))
        for s in dem:
            if s["gen"] > 0:
                self.assertEqual(dem[s["parent"]]["gen"], s["gen"] - 1)
        # the inner square's sides had a big side as parent: still a child, never gen 0
        self.assertTrue(all(dem[i]["gen"] in (1, 2) for i in range(4, 8)))

    def test_demote_pushes_children_down(self):
        big = self.square(0.1, 0.1, 0.6)
        inner = self.square(0.2, 0.2, 0.1)
        tiny = self.square(0.22, 0.22, 0.02)
        other = self.square(0.75, 0.75, 0.2)
        out = strokes_lib.assign_generations(big + inner + tiny + other)
        self.assertEqual([s["gen"] for s in out], [0] * 4 + [1] * 4 + [2] * 4 + [0] * 4)
        dem = strokes_lib.demote(out, keep={12, 13, 14, 15})
        self.assertEqual([s["gen"] for s in dem[:4]], [1] * 4)
        self.assertEqual([s["gen"] for s in dem[4:12]], [2] * 8)
        for s in dem:
            if s["gen"] > 0:
                self.assertEqual(dem[s["parent"]]["gen"], s["gen"] - 1)

    def test_promote_lifts_a_subtree(self):
        big = self.square(0.1, 0.1, 0.6)
        inner = self.square(0.2, 0.2, 0.1)
        tiny = self.square(0.22, 0.22, 0.02)
        out = strokes_lib.assign_generations(big + inner + tiny)
        under = [i for i in range(8, 12) if out[i]["parent"] == 4]
        pro = strokes_lib.promote(out, {4})
        self.assertEqual((pro[4]["gen"], pro[4]["parent"]), (0, -1))
        for i in range(8, 12):
            self.assertEqual(pro[i]["gen"], 1 if i in under else 2)
        for s in pro:
            if s["gen"] > 0:
                self.assertEqual(pro[s["parent"]]["gen"], s["gen"] - 1)

    def test_balance_moves_extra_children_down(self):
        strokes = [{"pts": [[0.0, 0.5], [1.0, 0.5]], "gen": 0, "parent": -1}]
        for k in range(10):                               # childless children, lengths 0.01..0.1
            x = 0.1 * k
            strokes.append({"pts": [[x, 0.6], [x + 0.01 * (k + 1), 0.6]], "gen": 1, "parent": 0})
        out = strokes_lib.balance(strokes, 3)
        self.assertEqual([s["gen"] for s in out[1:]], [2] * 7 + [1] * 3)
        for s in out[1:8]:
            self.assertIn(s["parent"], [8, 9, 10])
        self.assertEqual(out[7]["parent"], 8)             # nearest kept sibling

    def test_families_do_not_mix(self):
        big = self.square(0.1, 0.1, 0.6)
        small = self.square(0.3, 0.3, 0.1)
        for s in small:
            s["family"] = "wire"
        out = strokes_lib.assign_generations(big + small)
        self.assertEqual([s["gen"] for s in out], [0] * 8)


if __name__ == "__main__":
    unittest.main()

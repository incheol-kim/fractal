import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import flat_lib  # noqa: E402

PAPER = (241, 233, 216)
INKS = [
    (217, 72, 43),    # 0 vermilion
    (47, 95, 174),    # 1 cobalt
    (227, 169, 47),   # 2 yellow
    (185, 180, 168),  # 3 concrete
    (27, 26, 24),     # 4 black
]


class InkTest(unittest.TestCase):
    def test_vermilion(self):
        self.assertEqual(flat_lib.nearest_ink((216, 67, 43), INKS), 0)

    def test_cobalt(self):
        self.assertEqual(flat_lib.nearest_ink((47, 95, 174), INKS), 1)

    def test_paper_is_light_tone(self):
        self.assertGreater(flat_lib.tone((240, 232, 215), INKS[3], PAPER), 0.9)

    def test_ink_itself_is_dark_tone(self):
        for ink in INKS:
            self.assertLess(flat_lib.tone(ink, ink, PAPER), 0.05)

    def test_tone_clamped(self):
        t = flat_lib.tone((255, 255, 255), INKS[1], PAPER)
        self.assertTrue(0.0 <= t <= 1.0)
        t = flat_lib.tone((0, 0, 0), INKS[2], PAPER)
        self.assertTrue(0.0 <= t <= 1.0)

    def test_shadowed_blue_stays_cobalt(self):
        self.assertEqual(flat_lib.choose_ink((45, 75, 88), INKS), 1)

    def test_grey_uses_plain_distance(self):
        self.assertEqual(flat_lib.choose_ink((30, 29, 27), INKS), 4)


class HandInkTest(unittest.TestCase):
    NAMES = ["vermilion", "cobalt", "yellow", "concrete", "black", "coral"]
    HAND = {"hand_only": ["coral"], "ink_by_leaf": {"coral_tree_1": "coral", "sign": "black"}}

    def test_listed_leaf_gets_its_ink(self):
        self.assertEqual(flat_lib.forced_ink("coral_tree_1", self.HAND, self.NAMES), 5)
        self.assertEqual(flat_lib.forced_ink("sign", self.HAND, self.NAMES), 4)

    def test_unlisted_leaf_is_left_to_the_automatic_choice(self):
        self.assertIsNone(flat_lib.forced_ink("red_block_left", self.HAND, self.NAMES))

    def test_unknown_ink_name_is_an_error(self):
        with self.assertRaises(ValueError):
            flat_lib.forced_ink("x", {"ink_by_leaf": {"x": "pink"}}, self.NAMES)

    def test_hand_only_inks_are_not_chosen_automatically(self):
        self.assertEqual(flat_lib.auto_inks(self.HAND, self.NAMES), [0, 1, 2, 3, 4])
        self.assertEqual(flat_lib.auto_inks({}, self.NAMES), [0, 1, 2, 3, 4, 5])

    def test_unknown_hand_only_name_is_an_error(self):
        with self.assertRaises(ValueError):
            flat_lib.auto_inks({"hand_only": ["pink"]}, self.NAMES)


if __name__ == "__main__":
    unittest.main()

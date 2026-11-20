"""tools/public_tree.py: the public tree's mark, and the skip of a test that needs a file the public tree has not."""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import public_tree  # noqa: E402


class PublicTreeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "docs", "review"))
        with open(os.path.join(self.root, "docs", "review", "here.json"), "w") as f:
            f.write("{}")

    def tearDown(self):
        shutil.rmtree(self.root)

    def mark(self):
        with open(os.path.join(self.root, public_tree.MARKER), "w") as f:
            f.write("generated\n")

    def test_the_mark_is_a_file_at_the_root(self):
        self.assertEqual(public_tree.MARKER, "PUBLIC_TREE")
        self.assertFalse(public_tree.is_public_tree(self.root))
        self.mark()
        self.assertTrue(public_tree.is_public_tree(self.root))

    def test_no_skip_without_the_mark(self):
        # the test goes on (and fails on the missing file): a skip must not hide a damaged tree
        public_tree.skip_unpublished("docs/review/gone.json", "the sheet", self.root)

    def test_skips_in_the_public_tree_saying_what_is_missing(self):
        self.mark()
        with self.assertRaises(unittest.SkipTest) as cm:
            public_tree.skip_unpublished("docs/review/gone.json", "the candidate sheet", self.root)
        why = str(cm.exception)
        self.assertIn("docs/review/gone.json", why)
        self.assertIn("PUBLIC_TREE", why)
        self.assertIn("the candidate sheet", why)

    def test_what_the_public_tree_has_runs_there(self):
        self.mark()
        public_tree.skip_unpublished("docs/review/here.json", "x", self.root)

    def test_this_repository_has_no_mark_while_it_has_docs(self):
        root = os.path.dirname(HERE)
        self.assertFalse(public_tree.is_public_tree(root) and os.path.isdir(os.path.join(root, "docs")),
                         "%s and docs/ together: the private repository marked as the public tree" % public_tree.MARKER)


if __name__ == "__main__":
    unittest.main()

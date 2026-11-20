"""The public tree's mark, read in one place by the Python tests (test/public_tree.js is the JavaScript side).

The public repository is generated from a private source repository without what it does not publish,
among them docs/, prompts/, the reference originals (resources/midjourney_images/), the DAW project
(resources/*.song), the mixes, the final WAV among them (resources/Mixdown/), the original collage pieces
(assets/collage/) and the tooling that generates it. The generated tree has a file PUBLIC_TREE at its root.
A test that needs one of those files skips there, saying what is missing, and only there: in the source
repository the same absence is a failure, so a skip never hides a damaged tree.
"""
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKER = "PUBLIC_TREE"


def is_public_tree(root=ROOT):
    """Whether root is the public tree (its marker at the root)."""
    return os.path.exists(os.path.join(root, MARKER))


def skip_unpublished(rel, what, root=ROOT):
    """For a test that needs rel (a path from the root, '/' between folders): in the public tree without rel,
    unittest.SkipTest naming rel, the marker and `what` (the words saying what rel is); anywhere else nothing,
    and the test goes on (and fails if rel is missing)."""
    if is_public_tree(root) and not os.path.exists(os.path.join(root, *rel.split("/"))):
        raise unittest.SkipTest("%s is not in the public tree (%s): %s" % (rel, MARKER, what))

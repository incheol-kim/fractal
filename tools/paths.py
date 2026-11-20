"""Where everything that is not on GitHub lives (see "저장소에 올라가지 않는 것" in tools/README.md).

The tools take their folders from here and never spell a folder name themselves. The JavaScript twin
is tools/paths.mjs; tools/test_paths.py checks that the two name the same folders.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "local-only"
TEMP = LOCAL / "temp"  # everything that can be made again; may be deleted at any time
VIDEO = LOCAL / "video"  # the exported videos (test exports in video/tests/)
MODELS = LOCAL / "models"  # downloaded model weights
LOSSLESS = LOCAL / "review-lossless"  # the lossless copy of a review bundle
PUBLIC = LOCAL / "public"  # the public tree (public/fractal/, the public repository's checkout) and its file list, written by the publication tooling (not part of the published copy)
EDGE_PROFILES = TEMP / "edge"  # headless Edge's profiles (browser.mjs; one a killed tool left behind may be removed)


def in_temp(p):
    """Is p (relative paths are taken from ROOT) strictly inside TEMP? A path that leaves it by '..' is not."""
    q = Path(os.path.normpath(ROOT / p))
    return q != TEMP and TEMP in q.parents

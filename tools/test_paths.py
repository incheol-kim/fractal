import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import paths  # noqa: E402

DECL = re.compile(r"^export const (\w+) = path\.join\((\w+), '([^']+)'\);", re.M)


def mjs_values():
    """The folders paths.mjs names, read from the file: NAME -> path relative to ROOT."""
    with open(os.path.join(HERE, "paths.mjs"), encoding="utf-8") as f:
        text = f.read()
    rel = {"ROOT": ""}
    for name, parent, leaf in DECL.findall(text):
        rel[name] = os.path.join(rel[parent], leaf)
    return rel


class PathsCase(unittest.TestCase):
    def test_same_folders_as_the_javascript_twin(self):
        rel = mjs_values()
        for name in ("LOCAL", "TEMP", "VIDEO", "MODELS", "LOSSLESS", "PUBLIC", "EDGE_PROFILES"):
            self.assertIn(name, rel)
            self.assertEqual(getattr(paths, name), paths.ROOT / rel[name], name)

    def test_root_is_the_repository(self):
        self.assertTrue((paths.ROOT / "package.json").is_file())

    def test_in_temp(self):
        T = paths.TEMP
        self.assertTrue(paths.in_temp(T / "shots"))
        self.assertTrue(paths.in_temp(os.path.join("local-only", "temp", "x", "y.png")))
        self.assertFalse(paths.in_temp(T))
        self.assertFalse(paths.in_temp(paths.LOCAL))
        self.assertFalse(paths.in_temp(paths.VIDEO / "tests"))
        self.assertFalse(paths.in_temp(T / ".." / "video"))
        self.assertFalse(paths.in_temp(paths.ROOT / "local-only" / "temp-not"))


if __name__ == "__main__":
    unittest.main()

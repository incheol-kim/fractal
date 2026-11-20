"""data/collage_picks.json + the candidate sheet -> data/collage.json.

The picks file names the sheet and the fingerprint of the region map that sheet was made for
("regions"); the tool stops when that is not assets/regions.json's, or when a block of the sheet
does not fit the map (collage_lib.check_sheet_map): after a change of the map a new sheet is
needed. A sheet made before the reference images got their plain names (2026-11-20) names them by their
old names: the picks file then names the table of old and new names ("names",
docs/2026-11-20-reference-image-names.md, in the private repository only, like the sheets), and every image
of the sheet is read through it (an image the table has not stops the tool). A mistake in the picks file
stops it with a message naming the block; nothing is written.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import collage_lib  # noqa: E402


def _load(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError as e:
            raise collage_lib.PickError("%s is not valid JSON (%s)" % (rel, e))


def _text(root, rel):
    try:
        with open(os.path.join(root, *rel.split("/")), encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        raise collage_lib.PickError("%s, named by data/collage_picks.json, cannot be read (%s)" % (rel, e))


def build(root=ROOT):
    return _build(root)[0]


def _build(root):
    picks = _load(root, "data/collage_picks.json")
    sheet_path = collage_lib.picks_sheet(picks)
    sheet = _load(root, sheet_path)
    names = collage_lib.picks_names(picks)
    if names:
        sheet = collage_lib.renamed_sheet(sheet, collage_lib.read_name_table(_text(root, names)), names)
    regions = _load(root, "assets/regions.json")
    collage_lib.check_sheet_map(sheet, picks, regions)
    blocks, notes = collage_lib.apply_picks(sheet, picks)
    data = {"sheet": sheet_path, "regions": regions["fingerprint"],
            "look": sheet["look"], "blocks": blocks}
    return data, notes


def dumps(data):
    return json.dumps(data, ensure_ascii=False, indent=1) + "\n"


def main(root=ROOT):
    try:
        data, notes = _build(root)
    except collage_lib.PickError as e:
        raise SystemExit("tools/pick_collage.py stopped, data/collage.json not written: %s" % e)
    with open(os.path.join(root, "data", "collage.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(data))
    for n in notes:
        print(n)
    print("%d blocks, %d images" % (len(data["blocks"]), sum(len(b["images"]) for b in data["blocks"])))


if __name__ == "__main__":
    main()

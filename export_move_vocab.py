#!/usr/bin/env python3
"""
Export the Maia2 move vocabulary (UCI list) used during training/inference
to a JSON file. Host this JSON on a CDN and point the browser userscript to it.

Output: maia2_models/move_vocab.json
"""

import json
import os
import sys

# Ensure local maia2 package is importable (repo layout: ./maia2/maia2)
REPO_DIR = os.path.dirname(__file__)
PKG_PARENT = os.path.join(REPO_DIR, "maia2")
if PKG_PARENT not in sys.path:
    sys.path.insert(0, PKG_PARENT)

from maia2.utils import get_all_possible_moves


def main():
    moves = get_all_possible_moves()
    print(f"Total moves: {len(moves)}")
    out_path = "maia2_models/move_vocab.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(moves, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()

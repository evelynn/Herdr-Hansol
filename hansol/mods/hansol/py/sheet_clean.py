#!/usr/bin/env python3
"""Hard edges for a generated sheet (pixel art): alpha below 128 -> 0, the rest -> 255.
Image models leave a faint glow round each sprite; in --check that glow joins pieces into one.
    python sheet_clean.py <sheet.png> [...]
"""
import sys

import numpy as np
from PIL import Image

for path in sys.argv[1:]:
    rgba = np.asarray(Image.open(path).convert('RGBA')).copy()
    rgba[..., 3] = np.where(rgba[..., 3] < 128, 0, 255).astype(np.uint8)
    rgba[rgba[..., 3] == 0, :3] = 0                    # no colour left under clear pixels (it bled into the edges when scaled)
    Image.fromarray(rgba).save(path)
    print(path)

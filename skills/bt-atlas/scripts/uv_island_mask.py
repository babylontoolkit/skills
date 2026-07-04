#!/usr/bin/env python3
"""Build a binary UV-island footprint mask from a UV wireframe layout image.

General purpose: makes NO assumption about where the islands sit in the texture
(top/bottom/left/right). It thresholds the wireframe, optionally strips an outer
white border frame, morphologically closes the triangles into solid island blobs,
fills interior holes (position-independent flood from a padded border), then erodes
back to the original boundary.

Usage:
  python3 uv_island_mask.py <uv_layout.png> <out_mask.png> \
      [--size 2048] [--radius 9] [--thresh 35]

Tune --radius up if islands have large internal triangles that don't merge;
tune --thresh if the wireframe is faint (lower) or the background is noisy (higher).
"""
import argparse


def _ensure_deps():
    """Auto-install Pillow/numpy on first run so users only need Python itself."""
    import importlib
    import subprocess
    import sys
    for mod, pkg in (("PIL", "pillow"), ("numpy", "numpy")):
        try:
            importlib.import_module(mod)
        except ImportError:
            print(f"[skin] installing missing dependency: {pkg} ...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "--quiet", pkg])


_ensure_deps()

import numpy as np
from PIL import Image, ImageFilter, ImageDraw, ImageOps


def build_mask(uv_path, size=2048, radius=9, thresh=35):
    uv = Image.open(uv_path).convert("L").resize((size, size), Image.BILINEAR)
    a = np.array(uv)
    fg = a > thresh  # wireframe lines

    # Auto-strip a white border frame if the image edge is mostly foreground
    # (common in exported UV layout images). Harmless if no frame exists.
    border = max(4, size // 170)
    edge = np.concatenate([fg[0], fg[-1], fg[:, 0], fg[:, -1]])
    if edge.mean() > 0.5:
        fg[:border] = False
        fg[-border:] = False
        fg[:, :border] = False
        fg[:, -border:] = False

    m = Image.fromarray((fg.astype(np.uint8)) * 255)

    # Close: dilate to merge wireframe triangles into solid island blobs
    m = m.filter(ImageFilter.MaxFilter(2 * radius + 1))

    # Fill interior holes, position-independent: flood the background starting
    # from a 1px padded border, anything unreached is an interior hole.
    inv = ImageOps.invert(m)              # background bright
    padded = ImageOps.expand(inv, 1, fill=255)
    ImageDraw.floodfill(padded, (0, 0), 128, thresh=10)
    parr = np.array(padded)[1:-1, 1:-1]
    holes = parr == 255                   # background not reached -> hole
    filled = (np.array(m) > 127) | holes
    mask = Image.fromarray((filled.astype(np.uint8)) * 255)

    # Erode back to restore the original boundary size (undo the dilation),
    # then a small safety dilation so island edges are not clipped.
    mask = mask.filter(ImageFilter.MinFilter(2 * radius + 1))
    mask = mask.filter(ImageFilter.MaxFilter(5))
    return mask


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("uv")
    p.add_argument("out")
    p.add_argument("--size", type=int, default=2048)
    p.add_argument("--radius", type=int, default=9)
    p.add_argument("--thresh", type=int, default=35)
    args = p.parse_args()
    mk = build_mask(args.uv, args.size, args.radius, args.thresh)
    mk.save(args.out)
    cov = 100.0 * (np.array(mk) > 127).mean()
    print(f"saved {args.out} ({mk.size[0]}x{mk.size[1]}), island coverage {cov:.1f}%")

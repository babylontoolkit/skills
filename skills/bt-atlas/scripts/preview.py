#!/usr/bin/env python3
"""Verification helpers for the skin generation workflow.

mask-overlay : tint the base texture red where the island mask is active, so you
               can confirm the mask covers the intended islands and nothing else.
sheet        : build a contact sheet of several images for quick visual review.

Usage:
  python3 preview.py mask-overlay <base.png> <mask.png> <out.png>
  python3 preview.py sheet <out.png> <img1> <img2> ... [--cols 5] [--cell 300]
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
from PIL import Image


def mask_overlay(base_path, mask_path, out_path):
    base = Image.open(base_path).convert("RGB")
    size = base.size
    mask = Image.open(mask_path).convert("L").resize(size)
    ba = np.array(base, dtype=np.float32)
    mm = (np.array(mask, dtype=np.float32) / 255.0)[..., None]
    red = np.zeros_like(ba)
    red[..., 0] = 255
    ov = ba * (1 - 0.45 * mm) + red * (0.45 * mm)
    Image.fromarray(ov.astype(np.uint8)).save(out_path)
    print("wrote", out_path)


def sheet(out_path, imgs, cols=5, cell=300):
    rows = (len(imgs) + cols - 1) // cols
    s = Image.new("RGB", (cols * cell, rows * cell), (20, 20, 20))
    for i, pth in enumerate(imgs):
        im = Image.open(pth).convert("RGB").resize((cell, cell))
        s.paste(im, ((i % cols) * cell, (i // cols) * cell))
    s.save(out_path)
    print("wrote", out_path)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("mask-overlay")
    a.add_argument("base"); a.add_argument("mask"); a.add_argument("out")
    b = sub.add_parser("sheet")
    b.add_argument("out"); b.add_argument("imgs", nargs="+")
    b.add_argument("--cols", type=int, default=5)
    b.add_argument("--cell", type=int, default=300)
    args = p.parse_args()
    if args.cmd == "mask-overlay":
        mask_overlay(args.base, args.mask, args.out)
    else:
        sheet(args.out, args.imgs, args.cols, args.cell)

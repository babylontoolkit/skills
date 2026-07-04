#!/usr/bin/env python3
"""Composite a generated skin onto the base texture through a UV-island mask.

Keeps ONLY the pixels INSIDE the UV-island mask from the generated image and
takes everything else verbatim from the base texture. This guarantees the
generated skin can never alter the UV layout / dead space, so it stays a valid
drop-in skin swap for the same model geometry & UVs.

Usage:
  python3 composite_skin.py <base.png> <mask.png> <generated.png> <out.png> [--feather 1.0]
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
from PIL import Image, ImageFilter


def composite(base_path, mask_path, gen_path, out_path, feather=1.0):
    base = Image.open(base_path).convert("RGB")
    size = base.size
    mask = Image.open(mask_path).convert("L").resize(size)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))  # avoid hard seams
    gen = Image.open(gen_path).convert("RGB").resize(size)

    ba = np.array(base, dtype=np.float32)
    ga = np.array(gen, dtype=np.float32)
    ma = (np.array(mask, dtype=np.float32) / 255.0)[..., None]
    out = ga * ma + ba * (1.0 - ma)
    Image.fromarray(out.astype(np.uint8)).save(out_path)
    print("wrote", out_path)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("base")
    p.add_argument("mask")
    p.add_argument("gen")
    p.add_argument("out")
    p.add_argument("--feather", type=float, default=1.0)
    args = p.parse_args()
    composite(args.base, args.mask, args.gen, args.out, args.feather)

#!/usr/bin/env python3
"""Bundled stdin/stdout adapter for the `rembg` Python package.

Reads an image (PNG/JPEG) from stdin, removes the background with the
configured rembg model, and writes a PNG with an alpha channel to stdout.

Using the stable `rembg` Python API directly (instead of the `rembg` CLI)
keeps this working across rembg 1.x/2.x, whose CLI flags changed.

Model is chosen via the REMBG_MODEL env var (default "u2net").

Install:  pip install "rembg[cpu,cli]" onnxruntime
          (or: pip install rembg onnxruntime)
"""
import os
import sys


def main() -> int:
    try:
        from rembg import new_session, remove
    except ImportError as exc:
        sys.stderr.write(f"rembg package not importable: {exc}\n")
        return 2
    model = os.environ.get("REMBG_MODEL", "u2net")
    data = sys.stdin.buffer.read()
    if not data:
        sys.stderr.write("no input on stdin\n")
        return 2
    try:
        session = new_session(model)
        out = remove(data, session=session)
    except Exception as exc:  # surface model/download errors verbatim
        sys.stderr.write(f"rembg failed (model={model}): {exc}\n")
        return 1
    sys.stdout.buffer.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

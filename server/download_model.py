#!/usr/bin/env python3
"""Download the YuNet face-detection model (yunet.onnx) for Passport Studio.

The model file is not stored in git (binary). Run this once after cloning:
    python3 server/download_model.py
It saves the model to server/yunet.onnx (~230KB).
Source: OpenCV Zoo (official YuNet face detection model).
"""
import os
import sys
import urllib.request

MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/master/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yunet.onnx")


def main() -> None:
    if os.path.exists(DEST):
        print(f"Already exists: {DEST}")
        return
    print(f"Downloading YuNet model (~230KB)...")
    try:
        urllib.request.urlretrieve(MODEL_URL, DEST)
    except Exception as exc:  # noqa: BLE001
        print(f"Download failed: {exc}", file=sys.stderr)
        print("Please download it manually and save as server/yunet.onnx", file=sys.stderr)
        sys.exit(1)
    size = os.path.getsize(DEST)
    print(f"Saved {DEST} ({size // 1024}KB)")


if __name__ == "__main__":
    main()

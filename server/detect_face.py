"""Face detection helper: reads an image on stdin, writes detected faces as JSON
on stdout: {"faces": [{"x":..,"y":..,"w":..,"h":..,"score":0..1}, ...]}
(largest first; score = YuNet detection confidence) or {"faces": []}.
Uses OpenCV YuNet (bundled yunet.onnx, ~230KB, CPU)."""
import json
import os
import sys

import cv2
import numpy as np

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yunet.onnx")


def main() -> None:
    data = sys.stdin.buffer.read()
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(json.dumps({"faces": [], "error": "could not decode image"}))
        return
    h, w = img.shape[:2]
    try:
        detector = cv2.FaceDetectorYN_create(MODEL, "", (w, h))
        _, faces = detector.detect(img)
    except Exception as e:  # noqa: BLE001 — model/backend issues -> graceful fallback
        print(json.dumps({"faces": [], "error": str(e)[:120]}))
        return
    if faces is None or len(faces) == 0:
        print(json.dumps({"faces": []}))
        return
    # return all faces, largest first (with YuNet detection confidence 0..1)
    out = []
    for f in sorted(faces, key=lambda b: b[2] * b[3], reverse=True):
        x, y, bw, bh = (int(v) for v in f[:4])
        score = float(f[14]) if len(f) > 14 else 1.0
        out.append({"x": x, "y": y, "w": bw, "h": bh, "score": round(score, 3)})
    print(json.dumps({"faces": out}))


if __name__ == "__main__":
    main()

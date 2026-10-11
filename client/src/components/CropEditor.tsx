import { useEffect, useRef, useState } from "react";
import { useLang } from "../App";
import { photoUrl, type CropBox } from "../api";

interface CropEditorProps {
  photoId: string;
  filename: string;
  origWidth: number;
  origHeight: number;
  initial?: CropBox;
  onSave: (photoId: string, box: CropBox) => void;
  onClose: () => void;
}

interface DispBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

export default function CropEditor({
  photoId,
  filename,
  origWidth,
  initial,
  onSave,
  onClose,
}: CropEditorProps) {
  const { t } = useLang();
  const imgRef = useRef<HTMLImageElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [box, setBox] = useState<DispBox | null>(null);
  const drag = useRef<{ mode: Exclude<DragMode, null>; sx: number; sy: number; start: DispBox } | null>(null);

  // Initialize the crop box once the image has laid out at its display size.
  useEffect(() => {
    if (!loaded) return;
    const img = imgRef.current;
    if (!img || box) return;
    const dw = img.clientWidth;
    const dh = img.clientHeight;
    if (dw === 0 || dh === 0) return;
    if (initial && origWidth > 0) {
      const scale = dw / origWidth;
      setBox({ x: initial.x * scale, y: initial.y * scale, w: initial.w * scale, h: initial.h * scale });
    } else {
      const w = dw * 0.6;
      const h = dh * 0.6;
      setBox({ x: (dw - w) / 2, y: (dh - h) / 2, w, h });
    }
  }, [loaded, initial, origWidth, box]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const beginDrag = (e: React.PointerEvent, mode: Exclude<DragMode, null>) => {
    if (!box || !layerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: { ...box } };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const layer = layerRef.current;
    if (!d || !layer) return;
    const rect = layer.getBoundingClientRect();
    const dx = ((e.clientX - d.sx) / rect.width) * layer.clientWidth;
    const dy = ((e.clientY - d.sy) / rect.height) * layer.clientHeight;
    const s = d.start;
    const min = 24;
    let next: DispBox = { ...s };

    if (d.mode === "move") {
      next.x = Math.min(Math.max(0, s.x + dx), layer.clientWidth - s.w);
      next.y = Math.min(Math.max(0, s.y + dy), layer.clientHeight - s.h);
    } else {
      let { x, y, w, h } = s;
      if (d.mode.includes("e")) w = Math.max(min, s.w + dx);
      if (d.mode.includes("s")) h = Math.max(min, s.h + dy);
      if (d.mode.includes("w")) {
        const nx = Math.min(s.x + dx, s.x + s.w - min);
        w = s.w - (nx - s.x);
        x = nx;
      }
      if (d.mode.includes("n")) {
        const ny = Math.min(s.y + dy, s.y + s.h - min);
        h = s.h - (ny - s.y);
        y = ny;
      }
      x = Math.max(0, x);
      y = Math.max(0, y);
      w = Math.min(w, layer.clientWidth - x);
      h = Math.min(h, layer.clientHeight - y);
      next = { x, y, w, h };
    }
    setBox(next);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const handleSave = () => {
    const img = imgRef.current;
    if (!img || !box || img.clientWidth === 0 || origWidth === 0) return;
    const scale = origWidth / img.clientWidth;
    onSave(photoId, {
      x: Math.round(box.x * scale),
      y: Math.round(box.y * scale),
      w: Math.round(box.w * scale),
      h: Math.round(box.h * scale),
    });
  };

  const handles: { mode: "nw" | "ne" | "sw" | "se"; cls: string }[] = [
    { mode: "nw", cls: "-left-2 -top-2 cursor-nwse-resize" },
    { mode: "ne", cls: "-right-2 -top-2 cursor-nesw-resize" },
    { mode: "sw", cls: "-bottom-2 -left-2 cursor-nesw-resize" },
    { mode: "se", cls: "-bottom-2 -right-2 cursor-nwse-resize" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t.cropTitle}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="font-semibold text-slate-900">
            {t.cropTitle} — <span className="font-normal text-slate-500">{filename}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xl leading-none text-slate-500 hover:bg-slate-100"
            aria-label={t.cropCancel}
          >
            ×
          </button>
        </div>
        <div className="p-4">
          <div
            ref={layerRef}
            className="relative mx-auto w-full max-w-lg touch-none select-none overflow-hidden rounded-lg bg-slate-900"
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img
              ref={imgRef}
              src={photoUrl(photoId, "original")}
              alt={filename}
              draggable={false}
              onLoad={() => setLoaded(true)}
              className="block w-full"
            />
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
                {t.cropLoading}
              </div>
            )}
            {box && (
              <>
                <div className="pointer-events-none absolute inset-0 bg-black/50" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${box.x}px ${box.y}px, ${box.x}px ${box.y + box.h}px, ${box.x + box.w}px ${box.y + box.h}px, ${box.x + box.w}px ${box.y}px, ${box.x}px ${box.y}px)` }} />
                <div
                  className="absolute cursor-move border-2 border-indigo-400"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  onPointerDown={(e) => beginDrag(e, "move")}
                >
                  {handles.map((h) => (
                    <span
                      key={h.mode}
                      onPointerDown={(e) => beginDrag(e, h.mode)}
                      className={`absolute h-4 w-4 rounded-full border-2 border-indigo-400 bg-white ${h.cls}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-500">{t.cropNote}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            {t.cropCancel}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!box}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t.cropSave}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { useLang } from "../App";
import { photoUrl, type MarginsMm } from "../api";
import { fmt } from "../i18n";

// Same layout math as the backend PDF renderer (points).
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const PHOTO_W = 115.2;
const PHOTO_H = 144;
const COLS = 4;
const ROWS = 5;
const PER_PAGE = COLS * ROWS;
const MM_TO_PT = 2.83465;

interface SheetPreviewProps {
  photoIds: string[];
  copiesPerPhoto: number;
  marginsMm: MarginsMm;
  width?: number;
  bust?: Record<string, number>;
}

export default function SheetPreview({ photoIds, copiesPerPhoto, marginsMm, width = 200, bust }: SheetPreviewProps) {
  const { t } = useLang();

  const layout = useMemo(() => {
    const mL = marginsMm.left * MM_TO_PT;
    const mR = marginsMm.right * MM_TO_PT;
    const mT = marginsMm.top * MM_TO_PT;
    const mB = marginsMm.bottom * MM_TO_PT;
    const availW = PAGE_W - mL - mR;
    const availH = PAGE_H - mT - mB;
    const gapX = (availW - COLS * PHOTO_W) / (COLS - 1);
    const gapY = (availH - ROWS * PHOTO_H) / (ROWS - 1);
    const gridW = COLS * PHOTO_W + (COLS - 1) * gapX;
    const gridH = ROWS * PHOTO_H + (ROWS - 1) * gapY;
    const startX = mL + (availW - gridW) / 2;
    const startY = mT + (availH - gridH) / 2;
    return { gapX, gapY, startX, startY };
  }, [marginsMm]);

  const tiles = useMemo(() => {
    const list: string[] = [];
    for (const id of photoIds) {
      for (let c = 0; c < copiesPerPhoto; c++) list.push(id);
    }
    return list;
  }, [photoIds, copiesPerPhoto]);

  const pages: string[][] = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < tiles.length; i += PER_PAGE) out.push(tiles.slice(i, i + PER_PAGE));
    return out;
  }, [tiles]);

  if (pages.length === 0) {
    return <p className="py-4 text-center text-sm text-slate-400">{t.sheetEmpty}</p>;
  }

  const scale = width / PAGE_W;
  const pageH = PAGE_H * scale;
  const gapWarn = layout.gapX < 4 || layout.gapY < 4;

  return (
    <div>
      {gapWarn && (
        <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {t.marginWarn}
        </p>
      )}
      <div className="flex flex-wrap gap-6">
        {pages.map((page, pi) => (
          <figure key={pi} className="shrink-0">
            <div
              className="relative overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-slate-300"
              style={{ width, height: pageH }}
            >
              {page.map((id, ti) => {
                const col = ti % COLS;
                const row = Math.floor(ti / COLS);
                const left = (layout.startX + col * (PHOTO_W + layout.gapX)) * scale;
                const top = (layout.startY + row * (PHOTO_H + layout.gapY)) * scale;
                return (
                  <div
                    key={`${id}-${ti}`}
                    className="absolute bg-slate-100 bg-cover bg-center ring-1 ring-slate-200"
                    style={{
                      left,
                      top,
                      width: PHOTO_W * scale,
                      height: PHOTO_H * scale,
                      backgroundImage: `url("${photoUrl(id, "processed")}${bust?.[id] ? `&t=${bust[id]}` : ""}")`,
                    }}
                  />
                );
              })}
            </div>
            <figcaption className="mt-2 text-center text-xs text-slate-500">
              {fmt(t.pageLabel, { i: pi + 1, n: pages.length, c: page.length })}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

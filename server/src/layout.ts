import { PDFDocument, rgb } from "pdf-lib";

export const A4 = { w: 595.28, h: 841.89 }; // PDF points
export const PHOTO = { w: 115.2, h: 144 }; // pt (1.6x2 in at 72 pt/in)
export const COLS = 4;
export const ROWS = 5;
export const PER_PAGE = COLS * ROWS; // 20
export const PT_PER_MM = 2.83465;

export interface MarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_MARGINS_MM: MarginsMm = { top: 10, right: 10, bottom: 10, left: 10 };

export interface PlacedPhoto {
  page: number;
  x: number;
  y: number; // bottom-left origin (pdf-lib)
  w: number;
  h: number;
}

interface GridMetrics {
  mL: number;
  mT: number;
  mR: number;
  mB: number;
  gapX: number;
  gapY: number;
}

function computeMetrics(marginsMm: MarginsMm): GridMetrics {
  const mT = marginsMm.top * PT_PER_MM;
  const mR = marginsMm.right * PT_PER_MM;
  const mB = marginsMm.bottom * PT_PER_MM;
  const mL = marginsMm.left * PT_PER_MM;
  const availW = A4.w - mL - mR;
  const availH = A4.h - mT - mB;
  const gapX = (availW - COLS * PHOTO.w) / (COLS - 1);
  const gapY = (availH - ROWS * PHOTO.h) / (ROWS - 1);
  if (gapX < 4 || gapY < 4) throw new Error("margins too large for 20-up layout");
  return { mL, mT, mR, mB, gapX, gapY };
}

export function layoutPositions(count: number, marginsMm: MarginsMm): PlacedPhoto[] {
  const { mL, mT, gapX, gapY } = computeMetrics(marginsMm);
  const out: PlacedPhoto[] = [];
  for (let i = 0; i < count; i++) {
    const page = Math.floor(i / PER_PAGE);
    const idx = i % PER_PAGE;
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    const x = mL + col * (PHOTO.w + gapX);
    const yTopFromTop = mT + row * (PHOTO.h + gapY);
    const y = A4.h - yTopFromTop - PHOTO.h; // pdf-lib bottom-left origin
    out.push({ page, x, y, w: PHOTO.w, h: PHOTO.h });
  }
  return out;
}

/** Draw 6pt cut-mark ticks at each photo corner, offset 3pt outside the rect, 0.5pt gray stroke. */
function drawCutMarks(page: { drawLine: (opts: any) => void }, x: number, y: number, w: number, h: number): void {
  const LEN = 6;
  const OFF = 3;
  const color = rgb(0.5, 0.5, 0.5);
  const thickness = 0.5;
  const lines: Array<[[number, number], [number, number]]> = [
    // top-left corner: left tick above, top tick to the left
    [[x - OFF, y + h + OFF], [x - OFF, y + h + OFF + LEN]],
    [[x - OFF, y + h + OFF], [x - OFF - LEN, y + h + OFF]],
    // top-right corner
    [[x + w + OFF, y + h + OFF], [x + w + OFF, y + h + OFF + LEN]],
    [[x + w + OFF, y + h + OFF], [x + w + OFF + LEN, y + h + OFF]],
    // bottom-left corner
    [[x - OFF, y - OFF], [x - OFF, y - OFF - LEN]],
    [[x - OFF, y - OFF], [x - OFF - LEN, y - OFF]],
    // bottom-right corner
    [[x + w + OFF, y - OFF], [x + w + OFF, y - OFF - LEN]],
    [[x + w + OFF, y - OFF], [x + w + OFF + LEN, y - OFF]],
  ];
  // Clamp endpoints to the page so marks never draw outside it.
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  for (const [[sx, sy], [ex, ey]] of lines) {
    page.drawLine({
      start: { x: clamp(sx, 0, A4.w), y: clamp(sy, 0, A4.h) },
      end: { x: clamp(ex, 0, A4.w), y: clamp(ey, 0, A4.h) },
      thickness,
      color,
    });
  }
}

export async function buildPdf(
  images: Buffer[],
  opts: { marginsMm: MarginsMm; cutMarks: boolean }
): Promise<Buffer> {
  if (images.length === 0) throw new Error("no images to place in PDF");
  const positions = layoutPositions(images.length, opts.marginsMm);
  const pageCount = Math.floor((images.length - 1) / PER_PAGE) + 1;

  const pdf = await PDFDocument.create();
  const pages: Array<ReturnType<PDFDocument["addPage"]>> = [];
  for (let p = 0; p < pageCount; p++) pages.push(pdf.addPage([A4.w, A4.h]));

  for (let i = 0; i < images.length; i++) {
    const embedded = await pdf.embedPng(images[i]);
    const pos = positions[i];
    pages[pos.page].drawImage(embedded, { x: pos.x, y: pos.y, width: pos.w, height: pos.h });
    if (opts.cutMarks) drawCutMarks(pages[pos.page] as any, pos.x, pos.y, pos.w, pos.h);
  }

  return Buffer.from(await pdf.save());
}

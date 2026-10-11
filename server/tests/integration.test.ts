import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream, PDFArray, type PDFPage } from "pdf-lib";
import { inflateSync } from "node:zlib";
import type { BgProvider } from "../src/providers";
import {
  PHOTO_H,
  PHOTO_W,
  resolveBackgroundColor,
  type ProcessOptions,
} from "../src/pipeline";
import { A4, layoutPositions, buildPdf } from "../src/layout";

/**
 * Full sheet pipeline: 45 synthetic portraits -> stub bg-removal pipeline ->
 * 45 processed 480x600 PNGs -> buildPdf -> verify the PDF with pdf-lib.
 *
 * SEAM NOTE: same as pipeline.test.ts — processPhoto() has no provider
 * injection, so the documented pipeline order is replicated with sharp and a
 * local chroma-key stub. buildPdf() IS the real src code under test.
 */

const M10 = { top: 10, right: 10, bottom: 10, left: 10 };
const SUBJECT_HEX = "#2c3e50";

class ChromaKeyStubProvider implements BgProvider {
  name = "none" as const;
  constructor(
    private bg: { r: number; g: number; b: number },
    private tolerance = 8
  ) {}
  async removeBackground(input: Buffer): Promise<Buffer> {
    const { data, info } = await sharp(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { r, g, b } = this.bg;
    const t = this.tolerance;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - r) <= t &&
        Math.abs(data[i + 1] - g) <= t &&
        Math.abs(data[i + 2] - b) <= t
      ) {
        data[i + 3] = 0;
      }
    }
    return sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }
}

async function runTestPipeline(
  input: Buffer,
  opts: ProcessOptions,
  provider: BgProvider
): Promise<Buffer> {
  const bgColor = resolveBackgroundColor(opts.background);
  let subject: Buffer;
  try {
    subject = await sharp(await provider.removeBackground(input))
      .trim({ threshold: 10 })
      .toBuffer();
  } catch {
    subject = await provider.removeBackground(input);
  }
  const fitted = await sharp(subject)
    .resize(440, 520, { fit: "inside", withoutEnlargement: false })
    .toBuffer();
  const fm = await sharp(fitted).metadata();
  const sw = fm.width ?? 440;
  const sh = fm.height ?? 520;
  const left = Math.max(0, Math.round((PHOTO_W - sw) / 2));
  const top = Math.max(0, Math.min(40, PHOTO_H - sh));
  let out = await sharp({
    create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: bgColor },
  })
    .composite([{ input: fitted, left, top }])
    .png()
    .toBuffer();
  const info = await sharp(out).metadata();
  if (info.width !== PHOTO_W || info.height !== PHOTO_H) {
    out = await sharp(out).resize(PHOTO_W, PHOTO_H, { fit: "fill" }).png().toBuffer();
  }
  return out;
}

function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

async function makePortrait(w: number, h: number, bgHex: string): Promise<Buffer> {
  const svg =
    `<svg width="${w}" height="${h}">` +
    `<ellipse cx="${w / 2}" cy="${Math.round(h * 0.38)}" rx="${Math.round(w * 0.19)}" ry="${Math.round(h * 0.2)}" fill="${SUBJECT_HEX}"/>` +
    `</svg>`;
  return sharp({ create: { width: w, height: h, channels: 3, background: bgHex } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

interface DrawnRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pageStreamText(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const obj = doc.context.lookup(ref);
      if (obj instanceof PDFRawStream) streams.push(obj);
    }
  }
  let text = "";
  for (const s of streams) {
    let bytes = Buffer.from(s.getContents());
    const filter = s.dict.lookup(PDFName.of("Filter"));
    const names =
      filter instanceof PDFArray
        ? filter.asArray().map(String)
        : filter
          ? [String(filter)]
          : [];
    if (names.includes("/FlateDecode")) bytes = inflateSync(bytes);
    text += bytes.toString("latin1");
  }
  return text;
}

/**
 * Parse image-draw `cm` matrix ops from a decoded content stream.
 * pdf-lib 1.17.1 drawImage emits per image (verified in node_modules):
 *   translate(x,y) -> "1 0 0 1 x y cm"
 *   rotate(0)      -> "1 0 0 1 0 0 cm"   (identity)
 *   scale(w,h)     -> "w 0 0 h 0 0 cm"
 *   skew(0,0)      -> "1 0 0 1 0 0 cm"   (identity)
 * Pairing rule: a scale op (a!=1 or d!=1) belongs to the most recent
 * non-identity translate. Cut-mark drawLine ops emit m/l/S, never cm.
 */
function parseDrawnRects(streamText: string): DrawnRect[] {
  const re = /(\d+(?:\.\d+)?)\s+0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+cm/g;
  const rects: DrawnRect[] = [];
  let pending: { x: number; y: number } | null = null;
  for (const m of streamText.matchAll(re)) {
    const a = Number(m[1]);
    const d = Number(m[2]);
    const e = Number(m[3]);
    const f = Number(m[4]);
    if (a === 1 && d === 1) {
      if (e !== 0 || f !== 0) pending = { x: e, y: f }; // real translate; identity -> ignore
    } else {
      assert.ok(pending, "scale cm op without a preceding translate");
      rects.push({ x: pending.x, y: pending.y, w: a, h: d });
    }
  }
  return rects;
}

const SIZES: Array<[number, number]> = [
  [800, 1000],
  [640, 800],
  [900, 1200],
  [700, 900],
  [1024, 1024],
];
const BG_COLORS = ["#3a7bd5", "#e74c3c", "#27ae60", "#f1c40f", "#8e44ad"];

describe("full sheet pipeline (45 photos)", () => {
  it("builds a 3-page A4 PDF with 20/20/5 placed 115.2x144 images", { timeout: 180000 }, async () => {
    // 1. 45 synthetic portraits, varying bg colors and sizes.
    const portraits = await Promise.all(
      Array.from({ length: 45 }, (_, i) => {
        const [w, h] = SIZES[i % SIZES.length];
        return makePortrait(w, h, BG_COLORS[i % BG_COLORS.length]);
      })
    );

    // 2. Each through the stub-bg pipeline -> 480x600 PNG.
    const processed = await Promise.all(
      portraits.map(async (p, i) => {
        const stub = new ChromaKeyStubProvider(hexToRgb(BG_COLORS[i % BG_COLORS.length]));
        const out = await runTestPipeline(
          p,
          { background: { preset: "white" }, enhance: false },
          stub
        );
        const meta = await sharp(out).metadata();
        assert.equal(meta.width, 480, `photo ${i} width`);
        assert.equal(meta.height, 600, `photo ${i} height`);
        return out;
      })
    );
    assert.equal(processed.length, 45);

    // 3. Real buildPdf.
    const pdfBytes = await buildPdf(processed, { marginsMm: M10, cutMarks: true });
    assert.ok(pdfBytes.length > 1000);

    // 4. Load with pdf-lib: 3 pages, each exactly A4.
    const doc = await PDFDocument.load(pdfBytes);
    assert.equal(doc.getPageCount(), 3);
    const pages = doc.getPages();
    for (const [idx, page] of pages.entries()) {
      const size = page.getSize();
      assert.ok(Math.abs(size.width - 595.28) <= 0.5, `page ${idx} width ${size.width}`);
      assert.ok(Math.abs(size.height - 841.89) <= 0.5, `page ${idx} height ${size.height}`);
    }

    // 5. Parse image-draw cm ops per page.
    const expected = layoutPositions(45, M10);
    const perPageCounts = [20, 20, 5];
    for (const [pageIdx, page] of pages.entries()) {
      const rects = parseDrawnRects(pageStreamText(doc, page));
      assert.equal(
        rects.length,
        perPageCounts[pageIdx],
        `page ${pageIdx}: expected ${perPageCounts[pageIdx]} draws, got ${rects.length}`
      );

      const expectedOnPage = expected.filter((p) => p.page === pageIdx);
      for (const [i, r] of rects.entries()) {
        // drawn scale factors are the photo size
        assert.ok(Math.abs(r.w - 115.2) <= 0.5, `page ${pageIdx} draw ${i} w=${r.w}`);
        assert.ok(Math.abs(r.h - 144) <= 0.5, `page ${pageIdx} draw ${i} h=${r.h}`);
        // drawn position matches layoutPositions within 0.5pt
        const e = expectedOnPage[i];
        assert.ok(Math.abs(r.x - e.x) <= 0.5, `page ${pageIdx} draw ${i} x: ${r.x} vs ${e.x}`);
        assert.ok(Math.abs(r.y - e.y) <= 0.5, `page ${pageIdx} draw ${i} y: ${r.y} vs ${e.y}`);
        // inside the page
        assert.ok(r.x >= -0.01 && r.x + r.w <= A4.w + 0.01, `draw ${i} x out of page`);
        assert.ok(r.y >= -0.01 && r.y + r.h <= A4.h + 0.01, `draw ${i} y out of page`);
      }

      // no two drawn rects overlap
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          assert.ok(ox <= 0.01 || oy <= 0.01, `drawn rects ${i}/${j} overlap on page ${pageIdx}`);
        }
      }
    }
  });
});

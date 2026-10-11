import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { BgProvider } from "../src/providers";
import {
  PASSPORT_BLUE,
  PHOTO_H,
  PHOTO_W,
  isSaneFace,
  resolveBackgroundColor,
  type FaceBox,
  type ProcessOptions,
  type SubjectBbox,
} from "../src/pipeline";

/**
 * SEAM NOTE: src/pipeline.ts `processPhoto()` does NOT accept provider injection —
 * it calls the module-local `getProvider()` (bound to BG_PROVIDER at import time).
 * Verified empirically that monkey-patching the providers module does not take
 * effect under tsx, so these tests replicate the documented pipeline order
 * (manual crop -> bg-remove -> subject fit -> compose on bg color -> enhance)
 * step-for-step with sharp, using ChromaKeyStubProvider as the test double for
 * the BgProvider seam. Note the replication intentionally omits the YuNet
 * face-crop branch (needs python+opencv); the real processPhoto + provider
 * wiring IS exercised in validation.test.ts (job items fail with "Background
 * removal not configured" when BG_PROVIDER=none). Face-box sanity logic
 * (isSaneFace) is unit-tested directly below since it is exported.
 */

/** Honest LOCAL chroma-key test double for the BgProvider seam — no network, ever. */
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
        data[i + 3] = 0; // background -> transparent
      }
    }
    return sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }
}

/** Replicates the pipeline steps documented in pipeline.ts, with an injectable provider. */
async function runTestPipeline(
  input: Buffer,
  opts: ProcessOptions,
  provider: BgProvider
): Promise<Buffer> {
  const bgColor = resolveBackgroundColor(opts.background);

  // 1. Crop override first (original image px), clamped to bounds.
  let buf = input;
  if (opts.cropOverride) {
    const meta = await sharp(input).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (imgW > 0 && imgH > 0) {
      const r = opts.cropOverride;
      const left = Math.max(0, Math.min(Math.floor(r.x), imgW - 1));
      const top = Math.max(0, Math.min(Math.floor(r.y), imgH - 1));
      const width = Math.max(1, Math.min(Math.floor(r.w), imgW - left));
      const height = Math.max(1, Math.min(Math.floor(r.h), imgH - top));
      buf = await sharp(input).extract({ left, top, width, height }).toBuffer();
    }
  }

  // 2. Background removal -> RGBA.
  const rgba = await provider.removeBackground(buf);

  // 3. Fit subject to fill 480x600 (matches pipeline.ts: 4:5 subject fills
  //    the frame exactly, no white margins), composite on bg color.
  let subject: Buffer;
  try {
    subject = await sharp(rgba).trim({ threshold: 10 }).toBuffer();
  } catch {
    subject = rgba;
  }
  const fitted = await sharp(subject)
    .resize(PHOTO_W, PHOTO_H, { fit: "inside", withoutEnlargement: false })
    .toBuffer();
  const fittedMeta = await sharp(fitted).metadata();
  const sw = fittedMeta.width ?? PHOTO_W;
  const sh = fittedMeta.height ?? PHOTO_H;
  const left = Math.max(0, Math.round((PHOTO_W - sw) / 2));
  const top = Math.max(0, Math.round((PHOTO_H - sh) / 2));

  let canvas = sharp({
    create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: bgColor },
  }).composite([{ input: fitted, left, top }]);

  // 4. Optional tonal enhance.
  if (opts.enhance) {
    canvas = canvas
      .normalize()
      .modulate({ brightness: 1.04, saturation: 1.02 })
      .sharpen({ sigma: 1, m1: 0.5, m2: 0.3 });
  }

  // 5. Final guard: exactly 480x600.
  let out = await canvas.png().toBuffer();
  const info = await sharp(out).metadata();
  if (info.width !== PHOTO_W || info.height !== PHOTO_H) {
    out = await sharp(out).resize(PHOTO_W, PHOTO_H, { fit: "fill" }).png().toBuffer();
  }
  return out;
}

const BG_HEX = "#3a7bd5"; // (58, 123, 213) — synthetic backdrop
const BG_RGB = { r: 0x3a, g: 0x7b, b: 0xd5 };
const SUBJECT_HEX = "#2c3e50"; // (44, 62, 80) — darker "head/shoulders" subject

/** 800x1000 synthetic portrait: solid bg + darker filled ellipse, centered-upper. */
async function makePortrait(): Promise<Buffer> {
  const w = 800;
  const h = 1000;
  const svg =
    `<svg width="${w}" height="${h}">` +
    `<ellipse cx="${w / 2}" cy="${Math.round(h * 0.38)}" rx="${Math.round(w * 0.19)}" ry="${Math.round(h * 0.2)}" fill="${SUBJECT_HEX}"/>` +
    `</svg>`;
  return sharp({ create: { width: w, height: h, channels: 3, background: BG_HEX } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

async function pixelAt(
  buf: Buffer,
  x: number,
  y: number
): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

function colorDist(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** Count pixels in a central box that clearly differ from the bg color (the subject). */
async function countSubjectPixels(buf: Buffer, bg: { r: number; g: number; b: number }) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let y = 180; y < 420; y++) {
    for (let x = 180; x < 300; x++) {
      const i = (y * info.width + x) * info.channels;
      const d = Math.max(
        Math.abs(data[i] - bg.r),
        Math.abs(data[i + 1] - bg.g),
        Math.abs(data[i + 2] - bg.b)
      );
      if (d > 40) n++;
    }
  }
  return n;
}

async function assertCornersAre(buf: Buffer, hex: string, tolerance = 10) {
  const bg = hexToRgb(hex);
  const corners = [
    await pixelAt(buf, 5, 5),
    await pixelAt(buf, PHOTO_W - 6, 5),
    await pixelAt(buf, 5, PHOTO_H - 6),
    await pixelAt(buf, PHOTO_W - 6, PHOTO_H - 6),
  ];
  for (const c of corners) {
    assert.ok(
      colorDist(c, bg) <= tolerance,
      `corner pixel ${JSON.stringify(c)} not within ${tolerance} of ${hex}`
    );
  }
}

describe("pipeline (stub bg-removal)", () => {
  it("white preset: output exactly 480x600, white corners, subject present", async () => {
    const stub = new ChromaKeyStubProvider(BG_RGB);
    const out = await runTestPipeline(await makePortrait(), {
      background: { preset: "white" },
      enhance: false,
    }, stub);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 600);
    assert.equal(meta.format, "png");
    await assertCornersAre(out, "#FFFFFF");
    const subjectPx = await countSubjectPixels(out, hexToRgb("#FFFFFF"));
    assert.ok(subjectPx > 2000, `expected subject pixels, got ${subjectPx}`);
  });

  it("blue preset: corners are #2b6cb0", async () => {
    assert.equal(PASSPORT_BLUE, "#2b6cb0");
    const stub = new ChromaKeyStubProvider(BG_RGB);
    const out = await runTestPipeline(await makePortrait(), {
      background: { preset: "blue" },
      enhance: false,
    }, stub);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 600);
    await assertCornersAre(out, "#2b6cb0");
    const subjectPx = await countSubjectPixels(out, hexToRgb("#2b6cb0"));
    assert.ok(subjectPx > 2000, `expected subject pixels, got ${subjectPx}`);
  });

  it("custom hex background: corners match the custom color", async () => {
    const stub = new ChromaKeyStubProvider(BG_RGB);
    const out = await runTestPipeline(await makePortrait(), {
      background: { preset: "custom", color: "#c0392b" },
      enhance: false,
    }, stub);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 600);
    await assertCornersAre(out, "#c0392b");
  });

  it("cropOverride path: output still exactly 480x600", async () => {
    const stub = new ChromaKeyStubProvider(BG_RGB);
    const out = await runTestPipeline(
      await makePortrait(),
      {
        background: { preset: "white" },
        enhance: false,
        cropOverride: { x: 100, y: 100, w: 400, h: 500 },
      },
      stub
    );
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 600);
    await assertCornersAre(out, "#FFFFFF");
    const subjectPx = await countSubjectPixels(out, hexToRgb("#FFFFFF"));
    assert.ok(subjectPx > 500, `expected subject pixels after crop, got ${subjectPx}`);
  });

  it("enhance=true: output still exactly 480x600 with white corners", async () => {
    const stub = new ChromaKeyStubProvider(BG_RGB);
    const out = await runTestPipeline(await makePortrait(), {
      background: { preset: "white" },
      enhance: true,
    }, stub);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 480);
    assert.equal(meta.height, 600);
    // normalize() keeps maxed-out white at white; allow a wider tolerance.
    await assertCornersAre(out, "#FFFFFF", 20);
    const subjectPx = await countSubjectPixels(out, hexToRgb("#FFFFFF"));
    assert.ok(subjectPx > 2000, `expected subject pixels, got ${subjectPx}`);
  });

  it("invalid custom color throws", () => {
    assert.throws(
      () => resolveBackgroundColor({ preset: "custom", color: "not-a-color" }),
      /Invalid custom background color/
    );
    assert.throws(
      () => resolveBackgroundColor({ preset: "custom" }),
      /Invalid custom background color/
    );
  });

  it("stub provider never touches the network and implements BgProvider", async () => {
    const stub: BgProvider = new ChromaKeyStubProvider(BG_RGB);
    assert.equal(stub.name, "none");
    const rgba = await stub.removeBackground(await makePortrait());
    const meta = await sharp(rgba).metadata();
    assert.ok((meta.channels ?? 0) >= 4, "stub must return an alpha channel");
    // background pixel became transparent, subject pixel stayed opaque
    const { data, info } = await sharp(rgba).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bgAlpha = data[(10 * info.width + 10) * 4 + 3];
    const subjAlpha = data[(380 * info.width + 400) * 4 + 3];
    assert.equal(bgAlpha, 0);
    assert.equal(subjAlpha, 255);
  });
});

describe("isSaneFace (face-box sanity check)", () => {
  // Headshot subject: head+shoulders, 300x500.
  const headshot: SubjectBbox = { minX: 100, minY: 50, maxX: 399, maxY: 549 };

  it("accepts a normal headshot face", () => {
    const face: FaceBox = { x: 150, y: 100, w: 180, h: 220, score: 0.95 };
    assert.equal(isSaneFace(face, headshot), true);
  });

  it("rejects a forehead-only partial detection (the reported bug)", () => {
    // YuNet caught only forehead+eyes under a cap: box ends too high,
    // chin missing -> must fall back to the subject-bbox heuristic.
    const partial: FaceBox = { x: 160, y: 80, w: 150, h: 110, score: 0.7 };
    assert.equal(isSaneFace(partial, headshot), false);
  });

  it("rejects low-confidence detections", () => {
    const face: FaceBox = { x: 150, y: 100, w: 180, h: 220, score: 0.4 };
    assert.equal(isSaneFace(face, headshot), false);
  });

  it("rejects a face far smaller than the subject (likely a fragment)", () => {
    const tiny: FaceBox = { x: 200, y: 200, w: 30, h: 30, score: 0.9 };
    assert.equal(isSaneFace(tiny, headshot), false);
  });

  it("rejects a face whose center lies outside the subject", () => {
    const off: FaceBox = { x: 500, y: 100, w: 180, h: 220, score: 0.9 };
    assert.equal(isSaneFace(off, headshot), false);
  });

  it("rejects a full-body face for the face-crop path (falls back to head-and-shoulders)", () => {
    // Full-body subject: face is small and high; face-centered crop would be
    // wrong, the tall-subject heuristic must take over instead.
    const fullBody: SubjectBbox = { minX: 200, minY: 0, maxX: 399, maxY: 999 };
    const face: FaceBox = { x: 250, y: 30, w: 100, h: 120, score: 0.9 };
    assert.equal(isSaneFace(face, fullBody), false);
  });

  it("accepts a face without a score (older helper output)", () => {
    const face: FaceBox = { x: 150, y: 100, w: 180, h: 220 };
    assert.equal(isSaneFace(face, headshot), true);
  });
});

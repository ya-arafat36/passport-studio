import path from "path";
import { spawn } from "child_process";
import sharp from "sharp";
import { BgProvider, getProvider } from "./providers";

export const PASSPORT_BLUE = "#2b6cb0"; // calm official blue for the "blue" preset
export const PHOTO_W = 480;
export const PHOTO_H = 600;

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProcessOptions {
  background: { preset: "white" | "blue" | "custom"; color?: string };
  enhance: boolean;
  cropOverride?: CropRect;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function resolveBackgroundColor(bg: ProcessOptions["background"]): string {
  if (bg.preset === "white") return "#FFFFFF";
  if (bg.preset === "blue") return PASSPORT_BLUE;
  // custom
  if (bg.color && HEX_COLOR.test(bg.color)) return bg.color;
  throw new Error(`Invalid custom background color: ${JSON.stringify(bg.color)} (expected #rrggbb)`);
}

function clampCrop(rect: CropRect, imgW: number, imgH: number): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(Math.floor(rect.x), imgW - 1));
  const top = Math.max(0, Math.min(Math.floor(rect.y), imgH - 1));
  const width = Math.max(1, Math.min(Math.floor(rect.w), imgW - left));
  const height = Math.max(1, Math.min(Math.floor(rect.h), imgH - top));
  return { left, top, width, height };
}

export interface FaceBox { x: number; y: number; w: number; h: number; score?: number; }

export interface SubjectBbox { minX: number; minY: number; maxX: number; maxY: number; }

/** Bounding box of opaque (subject) pixels from the alpha channel. Null if none. */
async function subjectBbox(rgba: Buffer, imgW: number, imgH: number): Promise<SubjectBbox | null> {
  const { data: raw } = await sharp(rgba).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = imgW, minY = imgH, maxX = -1, maxY = -1;
  for (let y = 0; y < imgH; y++) {
    const rowBase = y * imgW * 4;
    for (let x = 0; x < imgW; x++) {
      if (raw[rowBase + x * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

/**
 * Sanity-check a detected face box against the subject bbox. YuNet sometimes
 * returns partial/wrong boxes (forehead-only under a cap, profile fragments);
 * blindly trusting the largest box is what produced "forehead-only" passport
 * crops. A sane face: confident detection, centered inside the subject,
 * plausible size, and extending a reasonable way down (chin, not just eyes).
 *
 * Exported for unit testing.
 */
export function isSaneFace(f: FaceBox, bbox: SubjectBbox): boolean {
  if ((f.score ?? 1) < 0.65) return false;
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  if (bw <= 0 || bh <= 0 || f.w <= 0 || f.h <= 0) return false;
  const fcx = f.x + f.w / 2;
  const fcy = f.y + f.h / 2;
  // face center must lie inside the subject (small margin allowed)
  if (fcx < bbox.minX - bw * 0.1 || fcx > bbox.maxX + bw * 0.1) return false;
  if (fcy < bbox.minY - bh * 0.1 || fcy > bbox.maxY + bh * 0.1) return false;
  // face height plausible relative to the subject
  if (f.h < bh * 0.1 || f.h > bh) return false;
  // the detected "face" must reach a reasonable way down the subject —
  // a forehead-only partial box ends too high (eyes, not chin)
  if (f.y + f.h - bbox.minY < bh * 0.35) return false;
  // and must not start below the subject's middle
  if (f.y - bbox.minY > bh * 0.5) return false;
  return true;
}

/**
 * Detect faces via the bundled YuNet helper (detect_face.py). Returns all
 * detected faces, largest first. Never throws — returns [] on any failure
 * so the pipeline can fall back to the bbox heuristic.
 */
async function detectFaces(image: Buffer): Promise<FaceBox[]> {
  return new Promise((resolve) => {
    const helper = path.join(__dirname, "..", "detect_face.py");
    const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (faces: FaceBox[]) => {
      if (!settled) { settled = true; resolve(faces); }
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } done([]); }, 30000);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", () => { clearTimeout(timer); done([]); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const faces = Array.isArray(parsed.faces) ? parsed.faces : [];
        done(faces.filter((f: any) =>
          f && Number.isFinite(f.x) && Number.isFinite(f.y) &&
          Number.isFinite(f.w) && Number.isFinite(f.h) && f.w > 0 && f.h > 0
        ).map((f: any) => ({
          x: f.x, y: f.y, w: f.w, h: f.h,
          ...(Number.isFinite(f.score) ? { score: f.score } : {}),
        })));
      } catch {
        done([]);
      }
    });
    child.stdin.on("error", () => { clearTimeout(timer); done([]); });
    child.stdin.end(image);
  });
}

/**
 * Full per-photo pipeline. Returns a PNG buffer that is EXACTLY 480x600.
 * 1. cropOverride (in original image px) via sharp extract, clamped to bounds.
 *    A manual crop is FINAL — no auto-crop runs after it ("what you draw is
 *    what you get").
 * 2. provider.removeBackground → RGBA PNG
 * 3. smart auto-crop (skipped for manual crops):
 *    a) sane face detected → 4:5 crop centered on the largest face
 *       (passport standard: face ~70% of frame height, eyes above middle;
 *       for groups, the closest/largest face wins)
 *    b) no (sane) face → subject-bbox heuristic: tall subjects get an
 *       automatic head-and-shoulders crop; others get a 4:5 box containing
 *       the full subject so the photo fills the frame
 * 4. resize subject to fill the 480x600 frame, composite on a 480x600 canvas
 *    filled with the chosen background color (no stretching ever; a 4:5
 *    subject fills the frame exactly with zero white margins)
 * 5. optional tonal enhance (normalize, slight brightness/saturation, sharpen)
 * 6. output PNG 480x600 exactly (final guard resize if anything drifted)
 */
export async function processPhoto(input: Buffer, opts: ProcessOptions): Promise<Buffer> {
  const bgColor = resolveBackgroundColor(opts.background);
  const provider: BgProvider = getProvider();

  // 1. Manual crop override first (in ORIGINAL image px). Final — see above.
  const manualCrop = !!opts.cropOverride;
  let buf = input;
  if (manualCrop) {
    const meta = await sharp(input).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (imgW > 0 && imgH > 0) {
      const region = clampCrop(opts.cropOverride!, imgW, imgH);
      buf = await sharp(input).extract(region).toBuffer();
    }
  }

  // 2. Background removal → RGBA PNG with alpha.
  const rgba = await provider.removeBackground(buf);
  const rgbaMeta = await sharp(rgba).metadata();
  const imgW = rgbaMeta.width ?? 0;
  const imgH = rgbaMeta.height ?? 0;

  // 3. Smart auto-crop (skipped entirely for manual crops).
  let subject: Buffer;
  if (manualCrop || imgW <= 0 || imgH <= 0) {
    subject = rgba;
  } else {
    const bbox = await subjectBbox(rgba, imgW, imgH);
    const faces = await detectFaces(rgba);
    const face = faces.length >= 1 ? faces[0] : null; // largest first
    if (face && bbox && isSaneFace(face, bbox)) {
      const fcx = face.x + face.w / 2;
      const fcy = face.y + face.h / 2;
      const h = Math.round(face.h / 0.7);
      const w = Math.round(h * 0.8);
      let left = Math.round(fcx - w / 2);
      let top = Math.round(fcy - h * 0.45);
      left = Math.max(0, Math.min(left, imgW - w));
      top = Math.max(0, Math.min(top, imgH - h));
      const cw = Math.min(w, imgW - left);
      const ch = Math.min(h, imgH - top);
      subject = await sharp(rgba).extract({ left, top, width: cw, height: ch }).toBuffer();
    } else if (bbox) {
      const bw = bbox.maxX - bbox.minX + 1;
      const bh = bbox.maxY - bbox.minY + 1;
      let left: number;
      let top: number;
      let w: number;
      let h: number;
      if (bh / bw > 1.5) {
        // Tall subject → head-and-shoulders: top 30% of subject height,
        // 4:5 aspect, centered horizontally on the subject.
        h = Math.round(bh * 0.3);
        w = Math.round(h * 0.8);
        const cx = bbox.minX + bw / 2;
        left = Math.round(cx - w / 2);
        top = bbox.minY;
      } else {
        // Other subjects (headshots, groups) → 4:5 box containing the
        // whole bbox, centered on it, so the photo always fills the frame
        // (no tiny subject floating in white space).
        if (bw / bh > 0.8) {
          w = bw;
          h = Math.round(w / 0.8);
        } else {
          h = bh;
          w = Math.round(h * 0.8);
        }
        left = Math.round(bbox.minX + bw / 2 - w / 2);
        top = Math.round(bbox.minY + bh / 2 - h / 2);
      }
      left = Math.max(0, Math.min(left, imgW - w));
      top = Math.max(0, Math.min(top, imgH - h));
      w = Math.min(w, imgW - left);
      h = Math.min(h, imgH - top);
      subject = await sharp(rgba).extract({ left, top, width: w, height: h }).toBuffer();
    } else {
      subject = rgba; // no opaque pixels found; fall back to whole frame
    }
  }

  // Resize subject to fill the 480x600 frame exactly (aspect preserved, no
  // stretching). Auto-crops are always 4:5 = same aspect as the output, so
  // this fills the frame with NO white margins — the photo must fill the
  // frame, not float small inside it.
  const fitted = await sharp(subject)
    .resize(PHOTO_W, PHOTO_H, { fit: "inside", withoutEnlargement: false })
    .toBuffer();
  const fittedMeta = await sharp(fitted).metadata();
  const sw = fittedMeta.width ?? PHOTO_W;
  const sh = fittedMeta.height ?? PHOTO_H;

  // Composite on 480x600 canvas (4:5 subject fills it exactly — left/top are
  // 0; kept as math for the rare non-4:5 fallback where thin bars beat a stretch).
  const left = Math.max(0, Math.round((PHOTO_W - sw) / 2));
  const top = Math.max(0, Math.round((PHOTO_H - sh) / 2));

  let canvas = sharp({
    create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: bgColor },
  }).composite([{ input: fitted, left, top }]);

  // 4. Optional tonal enhance AFTER background replacement (local Sharp only, no morphing).
  if (opts.enhance) {
    canvas = canvas
      .normalize() // auto levels
      .modulate({ brightness: 1.04, saturation: 1.02 })
      .sharpen({ sigma: 1, m1: 0.5, m2: 0.3 });
  }

  // 5. Final output: PNG, exactly 480x600.
  let out = await canvas.png().toBuffer();
  const info = await sharp(out).metadata();
  if (info.width !== PHOTO_W || info.height !== PHOTO_H) {
    // Guard: aspect is already correct (subject inside a 480x600 box), so this is a no-op safeguard.
    out = await sharp(out).resize(PHOTO_W, PHOTO_H, { fit: "fill" }).png().toBuffer();
  }
  return out;
}

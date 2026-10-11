import fs from "fs";
import path from "path";
import { Router, Request, Response, NextFunction } from "express";
import multer, { MulterError } from "multer";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream } from "pdf-lib";
import { config } from "./config";
import {
  deletePhoto,
  findPhotoByHash,
  getJob,
  getPhoto,
  newId,
  paths,
  persistPhoto,
  sha256,
} from "./store";
import { buildPdf } from "./layout";
import { getProvider } from "./providers";
import { processPhoto } from "./pipeline";
import { createJobWithPhotos, startJobProcessing, validateJobBody } from "./jobWorker";

const router = Router();
const startedAt = Date.now();

/* ---------------- upload setup ---------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileMB * 1024 * 1024,
    files: config.maxFiles,
  },
});

function multerErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: `file exceeds the ${config.maxFileMB} MB limit` });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      res.status(400).json({ error: `too many files (max ${config.maxFiles} per upload)` });
      return;
    }
    res.status(400).json({ error: `upload error: ${err.message}` });
    return;
  }
  next(err);
}

/* ---------------- file sniffing ---------------- */

/** Verify image type by reading actual file bytes via sharp (magic bytes), not the extension. */
async function sniffImage(buf: Buffer): Promise<{ width: number; height: number; format: string } | null> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.format || !meta.width || !meta.height) return null;
    if (!["jpeg", "png", "webp"].includes(meta.format)) return null;
    return { width: meta.width, height: meta.height, format: meta.format };
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of EMBEDDED raster images from a PDF.
 *
 * LIMITATION (documented): only images embedded with DCTDecode (JPEG) or
 * JPXDecode (JPEG2000, converted to JPEG via sharp) are recovered. Other
 * encodings (e.g. FlateDecode raw pixels) and vector-only pages yield no
 * images, in which case the upload record is marked "failed" with error
 * "no embedded raster images found in PDF".
 */
async function extractPdfImages(buf: Buffer): Promise<Buffer[]> {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  const images: Array<{ bytes: Buffer; area: number }> = [];

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    if (!resources) continue;
    let xObjects: unknown;
    try {
      xObjects = resources.lookup(PDFName.of("XObject"));
    } catch {
      continue;
    }
    if (!(xObjects instanceof PDFDict)) continue;

    for (const [, ref] of xObjects.entries()) {
      const obj = doc.context.lookup(ref);
      const stream = obj instanceof PDFRawStream || obj instanceof PDFStream ? obj : null;
      if (!stream) continue;
      const dict = stream.dict;
      if (String(dict.lookup(PDFName.of("Subtype"))) !== "/Image") continue;

      const filter = dict.lookup(PDFName.of("Filter"));
      const filterNames: string[] = [];
      if (filter instanceof PDFArray) {
        for (const f of filter.asArray()) filterNames.push(String(f));
      } else if (filter) {
        filterNames.push(String(filter));
      }
      const isJpeg = filterNames.some((n) => n === "/DCTDecode" || n === "/JPXDecode");
      if (!isJpeg) continue;

      // PDFRawStream.getContents() returns the raw encoded bytes (JPEG already).
      const raw = stream instanceof PDFRawStream ? stream.getContents() : null;
      if (!raw) continue;
      let bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      if (filterNames.includes("/JPXDecode")) {
        try {
          bytes = await sharp(bytes).jpeg().toBuffer(); // JPEG2000 → real JPEG bytes
        } catch {
          continue;
        }
      }
      const w = Number(dict.lookup(PDFName.of("Width")) ?? 0);
      const h = Number(dict.lookup(PDFName.of("Height")) ?? 0);
      images.push({ bytes, area: w * h });
    }
  }

  // Prefer the largest embedded raster (best-effort heuristic for the "main" image).
  images.sort((a, b) => b.area - a.area);
  return images.map((i) => i.bytes);
}

/* ---------------- health / config ---------------- */

router.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

router.get("/config", (_req, res) => {
  // NO secrets here — API keys never leave the server.
  res.json({
    bgProvider: getProvider().name,
    maxFiles: config.maxFiles,
    maxFileSizeMB: config.maxFileMB,
    photo: {
      inches: [1.6, 2],
      mm: [40.64, 50.8],
      px: [480, 600],
      dpi: 300,
    },
  });
});

/* ---------------- upload ---------------- */

interface PhotoResponse {
  id: string;
  filename: string;
  width: number;
  height: number;
  status: "uploaded" | "duplicate" | "failed";
  error?: string;
}

router.post("/upload", upload.array("files"), multerErrorHandler, async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "no files uploaded (multipart field name must be 'files')" });
    return;
  }

  const results: PhotoResponse[] = [];

  for (const file of files) {
    const filename = file.originalname || "unnamed";
    const isPdf = /\.pdf$/i.test(filename) || file.mimetype === "application/pdf";

    try {
      let imageBytes: Buffer;
      let width = 0;
      let height = 0;

      if (isPdf) {
        const extracted = await extractPdfImages(file.buffer);
        if (extracted.length === 0) {
          results.push({
            id: newId(),
            filename,
            width: 0,
            height: 0,
            status: "failed",
            error: "no embedded raster images found in PDF",
          });
          continue;
        }
        imageBytes = extracted[0];
        const sniffed = await sniffImage(imageBytes);
        if (!sniffed) {
          results.push({
            id: newId(),
            filename,
            width: 0,
            height: 0,
            status: "failed",
            error: "no embedded raster images found in PDF",
          });
          continue;
        }
        ({ width, height } = sniffed);
      } else {
        const sniffed = await sniffImage(file.buffer);
        if (!sniffed) {
          results.push({
            id: newId(),
            filename,
            width: 0,
            height: 0,
            status: "failed",
            error: "unsupported file type (not a valid jpg/jpeg/png/webp image)",
          });
          continue;
        }
        imageBytes = file.buffer;
        ({ width, height } = sniffed);
      }

      // Dedupe by SHA-256 of file bytes (same batch and previous uploads):
      // duplicates are NOT stored twice; their record shares the original's id.
      const hash = sha256(imageBytes);
      const existing = findPhotoByHash(hash);
      if (existing) {
        results.push({
          id: existing.id,
          filename,
          width: existing.width,
          height: existing.height,
          status: "duplicate",
        });
        continue;
      }

      const id = newId();
      const png = await sharp(imageBytes).png().toBuffer();
      await fs.promises.writeFile(path.join(paths.ORIGINALS, `${id}.png`), png);

      persistPhoto({ id, filename, width, height, status: "uploaded", hash, createdAt: Date.now() });
      results.push({ id, filename, width, height, status: "uploaded" });
    } catch (err) {
      results.push({
        id: newId(),
        filename,
        width: 0,
        height: 0,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json({ photos: results });
});

/* ---------------- photos ---------------- */

router.delete("/photos/:id", (req: Request, res: Response) => {
  const ok = deletePhoto(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "photo not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/photos/:id", async (req: Request, res: Response) => {
  const variant = typeof req.query.variant === "string" ? req.query.variant : "original";
  const photo = getPhoto(req.params.id);
  if (!photo) {
    res.status(404).json({ error: "photo not found" });
    return;
  }

  try {
    if (variant === "processed") {
      const p = path.join(paths.PROCESSED, `${req.params.id}.png`);
      if (!fs.existsSync(p)) {
        res.status(404).json({ error: "processed image not found" });
        return;
      }
      res.type("image/png").send(await fs.promises.readFile(p));
      return;
    }

    if (variant === "preview") {
      // Fast UI preview: max 480px-wide JPEG. Prefer the processed image, fall back to original.
      const processedPath = path.join(paths.PROCESSED, `${req.params.id}.png`);
      const originalPath = path.join(paths.ORIGINALS, `${req.params.id}.png`);
      const src = fs.existsSync(processedPath) ? processedPath : originalPath;
      if (!fs.existsSync(src)) {
        res.status(404).json({ error: "image not found" });
        return;
      }
      const jpeg = await sharp(src)
        .resize({ width: 480, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      res.type("image/jpeg").send(jpeg);
      return;
    }

    // default: original (stored as PNG)
    const p = path.join(paths.ORIGINALS, `${req.params.id}.png`);
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: "original image not found" });
      return;
    }
    res.type("image/png").send(await fs.promises.readFile(p));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/* ---------------- jobs ---------------- */

/**
 * Reprocess a single photo with a (new/updated) manual crop, without touching
 * any job. Used by the "Adjust crop" flow: the user draws a box on an already
 * processed photo and expects the preview to update immediately.
 *
 * Body: { cropOverride?: {x,y,w,h}, background: {preset, color?}, enhance: boolean }
 * Overwrites PROCESSED/:id.png in place, so the current job's sheet preview
 * and PDF export pick up the new image automatically.
 */
router.post("/photos/:id/reprocess", async (req: Request, res: Response) => {
  const photo = getPhoto(req.params.id);
  if (!photo) {
    res.status(404).json({ error: "photo not found" });
    return;
  }
  const originalPath = path.join(paths.ORIGINALS, `${req.params.id}.png`);
  if (!fs.existsSync(originalPath)) {
    res.status(404).json({ error: "original image not found" });
    return;
  }

  const body = req.body as any;
  const { cropOverride, background, enhance } = body ?? {};

  if (!background || typeof background !== "object") {
    res.status(400).json({ error: "background is required" });
    return;
  }
  if (!["white", "blue", "custom"].includes(background.preset)) {
    res.status(400).json({ error: 'background.preset must be "white", "blue" or "custom"' });
    return;
  }
  if (
    background.preset === "custom" &&
    !/^#[0-9a-fA-F]{6}$/.test(background.color ?? "")
  ) {
    res.status(400).json({ error: 'background.color is required for "custom" and must be #rrggbb' });
    return;
  }
  if (typeof enhance !== "boolean") {
    res.status(400).json({ error: "enhance must be a boolean" });
    return;
  }
  if (cropOverride !== undefined) {
    const r = cropOverride;
    if (!r || typeof r !== "object") {
      res.status(400).json({ error: "cropOverride must be {x,y,w,h}" });
      return;
    }
    for (const k of ["x", "y", "w", "h"] as const) {
      const v = r[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: `cropOverride.${k} must be a non-negative number` });
        return;
      }
    }
    if (r.w <= 0 || r.h <= 0) {
      res.status(400).json({ error: "cropOverride.w/h must be positive" });
      return;
    }
  }

  try {
    const original = await fs.promises.readFile(originalPath);
    const processed = await processPhoto(original, {
      background: { preset: background.preset, color: background.color },
      enhance,
      cropOverride,
    });
    await fs.promises.writeFile(path.join(paths.PROCESSED, `${req.params.id}.png`), processed);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function jobSummary(job: NonNullable<ReturnType<typeof getJob>>) {
  const total = job.items.length;
  const processed = job.items.filter((i) => i.status === "done").length;
  const failed = job.items.filter((i) => i.status === "failed").length;
  const remaining = total - processed - failed;
  return {
    id: job.id,
    status: job.status,
    total,
    processed,
    failed,
    remaining,
    items: job.items.map((i) => ({
      id: i.id,
      photoId: i.photoId,
      filename: i.filename,
      status: i.status,
      ...(i.error ? { error: i.error } : {}),
    })),
  };
}

router.post("/jobs", (req: Request, res: Response) => {
  const validation = validateJobBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { photoIds, ...rest } = req.body as { photoIds: string[] };
  void rest;
  const job = createJobWithPhotos(photoIds, validation.options);
  startJobProcessing(job.id); // background; do NOT await in the request
  res.json({ id: job.id, status: "queued" });
});

router.get("/jobs/:id", (req: Request, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(jobSummary(job));
});

function pdfFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `passport-sheet-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.pdf`;
}

router.post("/jobs/:id/pdf", async (req: Request, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ error: "job is not done yet" });
    return;
  }

  // Lay out the done items in order (copies were expanded consecutively at creation).
  const doneItems = job.items.filter((i) => i.status === "done");
  const buffers: Buffer[] = [];
  for (const item of doneItems) {
    const p = path.join(paths.PROCESSED, `${item.photoId}.png`);
    if (fs.existsSync(p)) buffers.push(await fs.promises.readFile(p));
  }
  if (buffers.length === 0) {
    res.status(400).json({ error: "no processed photos available in this job" });
    return;
  }

  try {
    const pdf = await buildPdf(buffers, {
      marginsMm: job.options.marginsMm,
      cutMarks: job.options.cutMarks,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdfFilename()}"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;

import fs from "fs";
import path from "path";
import {
  JobItem,
  JobOptions,
  JobRecord,
  getJob,
  getPhoto,
  newId,
  paths,
  persistJob,
} from "./store";
import { layoutPositions } from "./layout";
import { processPhoto } from "./pipeline";

const CONCURRENCY = 3;

/** Simple promise pool with fixed concurrency. */
async function runPool<T>(tasks: T[], concurrency: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      const t = tasks[i];
      i++;
      await fn(t);
    }
  });
  await Promise.all(workers);
}

export function validateJobBody(body: any): { ok: true; options: JobOptions } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "request body must be JSON" };

  const { photoIds, background, enhance, copiesPerPhoto, marginsMm, cutMarks, cropOverrides } = body;

  if (!Array.isArray(photoIds) || photoIds.length === 0 || !photoIds.every((p) => typeof p === "string")) {
    return { ok: false, error: "photoIds must be a non-empty array of strings" };
  }
  const missing = photoIds.filter((id) => !getPhoto(id));
  if (missing.length > 0) return { ok: false, error: `unknown photoIds: ${missing.join(", ")}` };

  if (!background || typeof background !== "object") return { ok: false, error: "background is required" };
  if (!["white", "blue", "custom"].includes(background.preset)) {
    return { ok: false, error: 'background.preset must be "white", "blue" or "custom"' };
  }
  if (background.preset === "custom" && !/^#[0-9a-fA-F]{6}$/.test(background.color ?? "")) {
    return { ok: false, error: 'background.color is required for "custom" and must be #rrggbb' };
  }

  if (typeof enhance !== "boolean") return { ok: false, error: "enhance must be a boolean" };

  if (!Number.isInteger(copiesPerPhoto) || copiesPerPhoto < 1 || copiesPerPhoto > 10) {
    return { ok: false, error: "copiesPerPhoto must be an integer from 1 to 10" };
  }

  if (!marginsMm || typeof marginsMm !== "object") return { ok: false, error: "marginsMm is required" };
  for (const k of ["top", "right", "bottom", "left"] as const) {
    const v = marginsMm[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: `marginsMm.${k} must be a non-negative number` };
    }
  }
  try {
    layoutPositions(1, marginsMm); // throws if margins too large for 20-up layout
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid margins" };
  }

  if (typeof cutMarks !== "boolean") return { ok: false, error: "cutMarks must be a boolean" };

  if (cropOverrides !== undefined) {
    if (!cropOverrides || typeof cropOverrides !== "object" || Array.isArray(cropOverrides)) {
      return { ok: false, error: "cropOverrides must be an object keyed by photoId" };
    }
    for (const [pid, r] of Object.entries(cropOverrides as Record<string, any>)) {
      if (!getPhoto(pid)) return { ok: false, error: `cropOverrides references unknown photoId: ${pid}` };
      if (!r || typeof r !== "object") return { ok: false, error: `cropOverrides[${pid}] must be {x,y,w,h}` };
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = r[k];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          return { ok: false, error: `cropOverrides[${pid}].${k} must be a non-negative number` };
        }
      }
      if (r.w <= 0 || r.h <= 0) return { ok: false, error: `cropOverrides[${pid}].w/h must be positive` };
    }
  }

  const options: JobOptions = {
    background: { preset: background.preset, color: background.color },
    enhance,
    copiesPerPhoto,
    marginsMm: { top: marginsMm.top, right: marginsMm.right, bottom: marginsMm.bottom, left: marginsMm.left },
    cutMarks,
    cropOverrides,
  };
  return { ok: true, options };
}

/** Build a job whose items expand copiesPerPhoto by repeating photo entries. */
export function createJobWithPhotos(photoIds: string[], options: JobOptions): JobRecord {
  const items: JobItem[] = [];
  for (const photoId of photoIds) {
    const photo = getPhoto(photoId)!;
    for (let c = 0; c < options.copiesPerPhoto; c++) {
      items.push({
        id: newId(),
        photoId,
        filename: photo.filename,
        status: "queued",
      });
    }
  }
  const job: JobRecord = { id: newId(), status: "queued", options, items, createdAt: Date.now() };
  persistJob(job);
  return job;
}

/**
 * Start background processing for a job (fire-and-forget; never awaited by the request).
 * Concurrency 3 across unique photos; copies share the same processed image.
 * Job ends "done" when every item is terminal — even if some items failed.
 */
export function startJobProcessing(jobId: string): void {
  void processJob(jobId).catch((err) => {
    // Catastrophic failure (should be rare): mark the whole job failed.
    const job = getJob(jobId);
    if (job && job.status !== "done") {
      job.status = "failed";
      job.finishedAt = Date.now();
      for (const item of job.items) {
        if (item.status === "queued" || item.status === "processing") {
          item.status = "failed";
          item.error = err instanceof Error ? err.message : String(err);
        }
      }
      persistJob(job);
    }
  });
}

async function processJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.status !== "queued") return;
  job.status = "processing";
  persistJob(job);

  const uniquePhotoIds = [...new Set(job.items.map((i) => i.photoId))];

  await runPool(uniquePhotoIds, CONCURRENCY, async (photoId) => {
    for (const item of job.items) {
      if (item.photoId === photoId) item.status = "processing";
    }
    persistJob(job);
    try {
      const originalPath = path.join(paths.ORIGINALS, `${photoId}.png`);
      const original = await fs.promises.readFile(originalPath);
      const processed = await processPhoto(original, {
        background: job.options.background,
        enhance: job.options.enhance,
        cropOverride: job.options.cropOverrides?.[photoId],
      });
      await fs.promises.writeFile(path.join(paths.PROCESSED, `${photoId}.png`), processed);
      for (const item of job.items) {
        if (item.photoId === photoId) {
          item.status = "done";
          delete item.error;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const item of job.items) {
        if (item.photoId === photoId) {
          item.status = "failed";
          item.error = message;
        }
      }
    }
    persistJob(job); // update job JSON + in-memory after each photo
  });

  job.status = "done"; // all items terminal now, even if some failed
  job.finishedAt = Date.now();
  persistJob(job);
}

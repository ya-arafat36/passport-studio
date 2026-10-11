import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Persistent + in-memory storage for photo records, files, and job records.
 *
 * Layout under server/.tmp/:
 *   originals/<id>.png  - converted original uploads (normalized to PNG)
 *   processed/<id>.png  - final 480x600 processed passport photos
 *   jobs/<jobId>.json   - job records
 *   meta.json           - photo records keyed by id
 */

export interface PhotoRecord {
  id: string;
  filename: string;
  width: number;
  height: number;
  status: "uploaded" | "duplicate" | "failed";
  error?: string;
  /** sha256 of the stored original bytes (for dedupe) */
  hash?: string;
  createdAt: number;
}

export interface JobItem {
  id: string;
  photoId: string;
  filename: string;
  status: "queued" | "processing" | "done" | "failed";
  error?: string;
}

export interface JobOptions {
  background: { preset: "white" | "blue" | "custom"; color?: string };
  enhance: boolean;
  copiesPerPhoto: number;
  marginsMm: { top: number; right: number; bottom: number; left: number };
  cutMarks: boolean;
  cropOverrides?: { [photoId: string]: { x: number; y: number; w: number; h: number } };
}

export interface JobRecord {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  options: JobOptions;
  items: JobItem[];
  createdAt: number;
  finishedAt?: number;
  /** PDF bytes cached after generation via POST /api/jobs/:id/pdf */
  pdfReady?: boolean;
}

const BASE = path.join(__dirname, "..", ".tmp");
const ORIGINALS = path.join(BASE, "originals");
const PROCESSED = path.join(BASE, "processed");
const JOBS = path.join(BASE, "jobs");
const META = path.join(BASE, "meta.json");

for (const d of [BASE, ORIGINALS, PROCESSED, JOBS]) fs.mkdirSync(d, { recursive: true });

export const photos = new Map<string, PhotoRecord>();
export const jobs = new Map<string, JobRecord>();
const hashIndex = new Map<string, string>(); // sha256 → photo id

function loadMeta(): void {
  try {
    const raw = fs.readFileSync(META, "utf8");
    const obj = JSON.parse(raw) as Record<string, PhotoRecord>;
    for (const [id, rec] of Object.entries(obj)) {
      photos.set(id, rec);
      if (rec.hash) hashIndex.set(rec.hash, id);
    }
  } catch {
    // first boot or corrupt file — start fresh
  }
}

function saveMeta(): void {
  const obj: Record<string, PhotoRecord> = {};
  for (const [id, rec] of photos) obj[id] = rec;
  fs.writeFileSync(META, JSON.stringify(obj), "utf8");
}

export function persistPhoto(rec: PhotoRecord): void {
  photos.set(rec.id, rec);
  if (rec.hash) hashIndex.set(rec.hash, rec.id);
  saveMeta();
}

export function findPhotoByHash(hash: string): PhotoRecord | undefined {
  const id = hashIndex.get(hash);
  return id ? photos.get(id) : undefined;
}

export function deletePhoto(id: string): boolean {
  const rec = photos.get(id);
  if (!rec) return false;
  photos.delete(id);
  if (rec.hash && hashIndex.get(rec.hash) === id) hashIndex.delete(rec.hash);
  saveMeta();
  for (const p of [path.join(ORIGINALS, `${id}.png`), path.join(PROCESSED, `${id}.png`)]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone — fine
    }
  }
  return true;
}

export function getPhoto(id: string): PhotoRecord | undefined {
  return photos.get(id);
}

export function persistJob(job: JobRecord): void {
  jobs.set(job.id, job);
  try {
    fs.writeFileSync(path.join(JOBS, `${job.id}.json`), JSON.stringify(job), "utf8");
  } catch {
    // best-effort persistence
  }
}

export function getJob(id: string): JobRecord | undefined {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const raw = fs.readFileSync(path.join(JOBS, `${id}.json`), "utf8");
    const job = JSON.parse(raw) as JobRecord;
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

export const newId = (): string => crypto.randomUUID();

export const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

export const paths = { BASE, ORIGINALS, PROCESSED, JOBS, META };

loadMeta();

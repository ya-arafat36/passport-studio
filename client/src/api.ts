// API client for the Smart Passport Photo Studio backend (runs on :4000,
// proxied via /api in dev). Matches the backend contract exactly — no mocks.

const BASE = "/api";

async function readJson(res: Response) {
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return JSON.parse(text);
}

export type BgProvider = "removebg" | "rembg-local" | "none";
export type UploadStatus = "uploaded" | "duplicate" | "failed";
export type PhotoVariant = "original" | "processed" | "preview";
export type JobStatusName = "queued" | "processing" | "done" | "failed";
export type BgPreset = "white" | "blue" | "custom";

export interface HealthResp {
  ok: boolean;
  uptime: number;
}

export interface ConfigResp {
  bgProvider: BgProvider;
  maxFiles: number;
  maxFileSizeMB: number;
  photo: {
    inches: [number, number];
    mm: [number, number];
    px: [number, number];
    dpi: number;
  };
}

export interface UploadPhoto {
  id: string;
  filename: string;
  width: number;
  height: number;
  status: UploadStatus;
  error?: string;
}

export interface JobItem {
  id: string;
  photoId: string;
  filename: string;
  status: string;
  error?: string;
}

export interface JobStatus {
  id: string;
  status: JobStatusName;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  items: JobItem[];
}

export interface MarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface JobPayload {
  photoIds: string[];
  background: { preset: BgPreset; color?: string };
  enhance: boolean;
  copiesPerPhoto: number;
  marginsMm: MarginsMm;
  cutMarks: boolean;
  cropOverrides?: Record<string, CropBox>;
}

export interface CreateJobResp {
  id: string;
  status: string;
}

export async function getHealth(): Promise<HealthResp> {
  const res = await fetch(`${BASE}/health`);
  return readJson(res) as Promise<HealthResp>;
}

export async function getConfig(): Promise<ConfigResp> {
  const res = await fetch(`${BASE}/config`);
  return readJson(res) as Promise<ConfigResp>;
}

export async function uploadFiles(files: File[] | FileList): Promise<{ photos: UploadPhoto[] }> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  return readJson(res) as Promise<{ photos: UploadPhoto[] }>;
}

export async function deletePhoto(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/photos/${encodeURIComponent(id)}`, { method: "DELETE" });
  return readJson(res) as Promise<{ ok: boolean }>;
}

export async function createJob(payload: JobPayload): Promise<CreateJobResp> {
  const res = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson(res) as Promise<CreateJobResp>;
}

export async function getJob(id: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`);
  return readJson(res) as Promise<JobStatus>;
}

export interface ReprocessPayload {
  cropOverride?: CropBox;
  background: { preset: BgPreset; color?: string };
  enhance: boolean;
}

/** Reprocess one photo in place (used by Adjust crop) — no job involved. */
export async function reprocessPhoto(id: string, payload: ReprocessPayload): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/photos/${encodeURIComponent(id)}/reprocess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson(res) as Promise<{ ok: boolean }>;
}

export function photoUrl(id: string, variant: PhotoVariant): string {
  return `${BASE}/photos/${encodeURIComponent(id)}?variant=${variant}`;
}

export async function exportPdf(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/pdf`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 200) || `PDF export failed (${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(cd);
  const filename = match ? decodeURIComponent(match[1].replace(/"/g, "")) : `passport-photos-${jobId}.pdf`;
  return { blob, filename };
}

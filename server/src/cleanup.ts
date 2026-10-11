import fs from "fs";
import path from "path";
import { config } from "./config";
import { deletePhoto, getJob, jobs, paths, persistJob, photos } from "./store";

/**
 * Every 30 minutes, delete stored files/records older than CLEANUP_HOURS
 * (default 24) based on file mtime.
 */
export function startCleanup(): void {
  void runCleanup().catch(() => {});
  setInterval(() => {
    void runCleanup().catch(() => {});
  }, 30 * 60 * 1000).unref();
}

async function runCleanup(): Promise<void> {
  const cutoff = Date.now() - config.cleanupHours * 60 * 60 * 1000;

  // Photo files + records: drive off originals/<id>.png mtime.
  for (const rec of [...photos.values()]) {
    const originalPath = path.join(paths.ORIGINALS, `${rec.id}.png`);
    let mtime = 0;
    try {
      mtime = fs.statSync(originalPath).mtimeMs;
    } catch {
      // File already gone (e.g. replaced by an earlier partial cleanup) —
      // drop the orphaned record.
      deletePhoto(rec.id);
      continue;
    }
    if (mtime < cutoff) deletePhoto(rec.id);
  }

  // Stray processed files whose record is gone.
  try {
    for (const f of fs.readdirSync(paths.PROCESSED)) {
      const id = f.replace(/\.png$/i, "");
      if (!photos.has(id)) {
        try {
          fs.unlinkSync(path.join(paths.PROCESSED, f));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  // Job records older than the cutoff (based on json mtime).
  for (const [id, job] of [...jobs.entries()]) {
    const jsonPath = path.join(paths.JOBS, `${id}.json`);
    let mtime = 0;
    try {
      mtime = fs.statSync(jsonPath).mtimeMs;
    } catch {
      jobs.delete(id);
      continue;
    }
    if (mtime < cutoff) {
      jobs.delete(id);
      try {
        fs.unlinkSync(jsonPath);
      } catch {
        // ignore
      }
    } else if (!job.finishedAt && job.status !== "processing") {
      // keep queued/processing jobs warm in memory
      void getJob(id);
    }
  }

  // Best-effort persistence of job map state.
  for (const job of jobs.values()) {
    try {
      persistJob(job);
    } catch {
      // ignore
    }
  }
}

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

/**
 * HTTP integration tests against a REAL server child process:
 *   PORT=45721 BG_PROVIDER=none node --import tsx src/index.ts
 * No network beyond localhost; no real API keys.
 *
 * SPEC DEVIATION (verified against the real code): POST /api/upload with a
 * non-image file does NOT return 400 — multer accepts it and the route returns
 * HTTP 200 with a per-file record of status "failed". The test asserts the real
 * contract below.
 */

const PORT = 45721;
const BASE = `http://127.0.0.1:${PORT}/api`;
const SERVER_DIR = path.join(__dirname, "..");

let child: ChildProcess | null = null;
let childStderr = "";

async function waitForHealth(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`server did not become healthy in time. stderr:\n${childStderr.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), BG_PROVIDER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => {
    childStderr += d.toString("utf8");
  });
  child.on("error", (err) => {
    childStderr += `\nspawn error: ${err.message}`;
  });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const exited = new Promise<void>((resolve) => {
      child!.on("exit", () => resolve());
      setTimeout(() => {
        try {
          child!.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 5000).unref?.();
    });
    await exited;
  }
  child = null;
});

/** Deterministic-ish unique PNG per run (avoids cross-run dedupe noise). */
async function uniquePng(seed = 1): Promise<Buffer> {
  const n = (Date.now() + seed * 7919) % 256;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: n, g: (n * 7) % 256, b: (n * 13) % 256 } },
  })
    .png()
    .toBuffer();
}

async function uploadFiles(
  files: Array<{ buffer: Buffer; filename: string; type: string }>
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([new Uint8Array(f.buffer)], { type: f.type }), f.filename);
  }
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitForJobDone(jobId: string, timeoutMs = 20000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/jobs/${jobId}`);
    assert.equal(res.status, 200);
    const job = await res.json();
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} not terminal in time`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("health & config", () => {
  it("GET /api/health -> ok:true", async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.uptime === "number");
  });

  it('GET /api/config -> bgProvider "none", no secret fields', async () => {
    const res = await fetch(`${BASE}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bgProvider, "none");
    assert.equal(body.maxFiles, 100);
    assert.equal(body.maxFileSizeMB, 15);
    const dumped = JSON.stringify(body);
    assert.ok(
      !/removebgApiKey|REMOVEBG_API_KEY|api[_-]?key|secret|token|password/i.test(dumped),
      `config leaks a secret-looking field: ${dumped}`
    );
  });
});

describe("upload validation", () => {
  it("rejects a .txt file (per-file 'failed' record; HTTP 200 by design)", async () => {
    // NOTE: the real contract is HTTP 200 with status:"failed" per file,
    // not HTTP 400 — the route sniffs bytes and reports per-file outcomes.
    const { status, body } = await uploadFiles([
      { buffer: Buffer.from("hello, not an image"), filename: "note.txt", type: "text/plain" },
    ]);
    assert.equal(status, 200);
    assert.equal(body.photos.length, 1);
    assert.equal(body.photos[0].status, "failed");
    assert.match(body.photos[0].error, /unsupported file type/);
  });

  it("rejects a 16 MB file with 400 (limit is 15 MB)", async () => {
    const { status, body } = await uploadFiles([
      { buffer: Buffer.alloc(16 * 1024 * 1024, 0), filename: "big.png", type: "image/png" },
    ]);
    assert.equal(status, 400);
    assert.match(body.error, /15 MB/);
  });

  it("rejects 101 files with 400 (limit is 100)", async () => {
    const tiny = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const files = Array.from({ length: 101 }, (_, i) => ({
      buffer: tiny,
      filename: `t${i}.png`,
      type: "image/png",
    }));
    const { status, body } = await uploadFiles(files);
    assert.equal(status, 400);
    assert.match(body.error, /too many files|max 100/);
  });

  it("dedupe: same PNG bytes twice -> second is 'duplicate' with the SAME id", async () => {
    const png = await uniquePng(11);
    const first = await uploadFiles([{ buffer: png, filename: "a.png", type: "image/png" }]);
    assert.equal(first.status, 200);
    assert.equal(first.body.photos[0].status, "uploaded");

    const second = await uploadFiles([{ buffer: png, filename: "b.png", type: "image/png" }]);
    assert.equal(second.status, 200);
    assert.equal(second.body.photos[0].status, "duplicate");
    assert.equal(second.body.photos[0].id, first.body.photos[0].id);
  });
});

describe("photo delete", () => {
  it("DELETE /api/photos/:id -> ok; repeat and unknown -> 404", async () => {
    const png = await uniquePng(22);
    const up = await uploadFiles([{ buffer: png, filename: "del.png", type: "image/png" }]);
    const id = up.body.photos[0].id as string;

    const del1 = await fetch(`${BASE}/photos/${id}`, { method: "DELETE" });
    assert.equal(del1.status, 200);
    assert.equal((await del1.json()).ok, true);

    const del2 = await fetch(`${BASE}/photos/${id}`, { method: "DELETE" });
    assert.equal(del2.status, 404);

    const del3 = await fetch(`${BASE}/photos/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
    });
    assert.equal(del3.status, 404);
  });
});

describe("jobs with BG_PROVIDER=none", () => {
  it("rejects an invalid job body with 400", async () => {
    const res = await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("job reaches 'done' with items failed: 'Background removal not configured'", async () => {
    const png = await uniquePng(33);
    const up = await uploadFiles([{ buffer: png, filename: "job.png", type: "image/png" }]);
    assert.equal(up.status, 200);
    const photoId = up.body.photos[0].id as string;

    const res = await fetch(`${BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photoIds: [photoId],
        background: { preset: "white" },
        enhance: false,
        copiesPerPhoto: 1,
        marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        cutMarks: false,
      }),
    });
    assert.equal(res.status, 200);
    const created = await res.json();
    assert.ok(created.id);

    const job = await waitForJobDone(created.id);
    assert.equal(job.status, "done");
    assert.equal(job.items.length, 1);
    assert.equal(job.items[0].status, "failed");
    assert.match(job.items[0].error, /Background removal not configured/);
  });

  it("GET unknown job -> 404", async () => {
    const res = await fetch(`${BASE}/jobs/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
  });
});

describe("POST /photos/:id/reprocess", () => {
  it("unknown photo -> 404", async () => {
    const res = await fetch(`${BASE}/photos/00000000-0000-0000-0000-000000000000/reprocess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ background: { preset: "white" }, enhance: false }),
    });
    assert.equal(res.status, 404);
  });

  it("missing background -> 400", async () => {
    const up = await uploadFiles([{ buffer: await uniquePng(11), filename: "r1.png", type: "image/png" }]);
    const photoId = up.body.photos[0].id as string;
    const res = await fetch(`${BASE}/photos/${photoId}/reprocess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enhance: false }),
    });
    assert.equal(res.status, 400);
  });

  it("invalid cropOverride -> 400", async () => {
    const up = await uploadFiles([{ buffer: await uniquePng(12), filename: "r2.png", type: "image/png" }]);
    const photoId = up.body.photos[0].id as string;
    const res = await fetch(`${BASE}/photos/${photoId}/reprocess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: { preset: "white" },
        enhance: false,
        cropOverride: { x: 0, y: 0, w: 0, h: 10 },
      }),
    });
    assert.equal(res.status, 400);
  });

  it("with BG_PROVIDER=none -> 500 (background removal not configured)", async () => {
    const up = await uploadFiles([{ buffer: await uniquePng(13), filename: "r3.png", type: "image/png" }]);
    const photoId = up.body.photos[0].id as string;
    const res = await fetch(`${BASE}/photos/${photoId}/reprocess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: { preset: "white" },
        enhance: false,
        cropOverride: { x: 0, y: 0, w: 32, h: 32 },
      }),
    });
    // provider "none" throws inside processPhoto -> 500 with the reason
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Background removal not configured/);
  });
});

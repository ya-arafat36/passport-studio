# Smart Passport Photo Studio

Turn ordinary portraits into print-ready passport photos. Upload photos, pick a
background (white / official blue / custom), optionally enhance, then process a
whole batch and export a print sheet: a 3-page-style A4 PDF laying out 20
photos per page (4×5 grid of 1.6″×2″ photos) with optional cut marks.

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  client  (React 18       │ /api   │  server  (Express + sharp     │
│  + Vite + Tailwind)     ├───────►│  + pdf-lib)                   │
│  http://localhost:5173  │ proxy  │  http://localhost:4000       │
└─────────────────────────┘        └──────────────────────────────┘
```

- **client/** — React SPA. In dev, Vite proxies `/api` → `http://localhost:4000`
  (see `client/vite.config.ts`), so the UI just calls `/api/...`.
- **server/** — Express API. Image pipeline is pure `sharp` (crop → background
  removal → trim → compose on 480×600 canvas → enhance). PDF sheets are built
  with `pdf-lib` via `src/layout.ts`. Background removal is pluggable
  (`src/providers.ts`): `removebg` (cloud API), `rembg-local` (local Python),
  or `none` (disabled).
- **Storage** — local disk under `server/.tmp/` (originals, processed images,
  job records). No database.

## Quickstart

Requirements: Node 20+, npm, and (only if you want real background removal)
either a remove.bg API key or Python with `rembg` — see `AI_API_SETUP.md`.

```bash
# 1. install
cd server && npm install
cd ../client && npm install

# 2. download the face-detection model (not stored in git)
python3 server/download_model.py   # saves server/yunet.onnx (~230KB)

# 3. configure (from the project root)
cp .env.example server/.env
# edit server/.env — at minimum choose BG_PROVIDER (none works for trying the UI)

# 4. run (two terminals)
cd server && npm run dev     # API on :4000
cd client && npm run dev     # UI on :5173
```

Open http://localhost:5173. For production-style runs see `DEPLOYMENT.md`.

## Environment variables

| Variable           | Default | Description                                                        |
| ------------------ | ------- | ------------------------------------------------------------------ |
| `PORT`             | `4000`  | Port the API server listens on.                                    |
| `BG_PROVIDER`      | `none`  | `removebg` \| `rembg-local` \| `none` (see `AI_API_SETUP.md`).      |
| `REMOVEBG_API_KEY` | _(empty)_ | remove.bg API key. Server-side only — never sent to the client or logged. |
| `MAX_FILE_MB`      | `15`    | Max size per uploaded file (MB).                                   |
| `MAX_FILES`        | `100`   | Max files per upload batch.                                        |
| `CLEANUP_HOURS`    | `24`    | Stored files/records older than this are deleted by the cleanup task. |

## Sample workflow

1. **Upload** — drag photos onto the dropzone (JPG/PNG/WebP, ≤ 15 MB each, ≤ 100
   per batch). Files are sniffed by magic bytes, not by extension. Re-uploading
   the same bytes is deduped (reported as `duplicate`, same id).
2. **Settings** — choose background preset (white / blue `#2b6cb0` / custom hex),
   toggle enhance, copies per photo (1–10), sheet margins, and cut marks.
   Optionally fine-tune framing per photo with the crop editor.
3. **Process All** — creates a background job; each photo is processed to an
   exact 480×600 PNG (concurrency 3). With `BG_PROVIDER=none` items fail with
   a clear "Background removal not configured" error.
4. **Preview** — review the sheet layout and before/after compare before printing.
5. **Export PDF** — downloads the A4 sheet (20 photos/page, optional cut-mark ticks).

## API surface

| Method | Route                  | Notes                                                      |
| ------ | ---------------------- | ---------------------------------------------------------- |
| GET    | `/api/health`          | `{ ok: true, uptime }`                                     |
| GET    | `/api/config`          | Provider name + limits. **No secrets** — keys never leave the server. |
| POST   | `/api/upload`          | Multipart `files[]`. Per-file `{ id, status: uploaded\|duplicate\|failed }`. |
| GET    | `/api/photos/:id`      | `?variant=original\|processed\|preview`                     |
| DELETE | `/api/photos/:id`      | Removes record + files.                                    |
| POST   | `/api/jobs`            | Starts a processing job (background, concurrency 3).        |
| GET    | `/api/jobs/:id`        | Job summary with per-item status/error.                    |
| POST   | `/api/jobs/:id/pdf`    | Builds + downloads the A4 sheet PDF.                       |

## Project structure

```
passport-studio/
├── README.md            # this file
├── AI_API_SETUP.md      # background-removal providers: remove.bg vs rembg-local
├── DEPLOYMENT.md        # VPS + Docker deployment sketches
├── .env.example         # copy to server/.env
├── client/
│   ├── src/
│   │   ├── App.tsx, main.tsx, api.ts, i18n.ts, index.css
│   │   └── components/  # Dropzone, SettingsPanel, CropEditor, PhotoGrid,
│   │                     # SheetPreview, CompareSlider, ProgressBar, ...
│   └── vite.config.ts   # dev proxy: /api -> localhost:4000
└── server/
    ├── src/
    │   ├── index.ts     # express boot, /api router, error handler
    │   ├── routes.ts    # upload / photos / jobs / pdf endpoints
    │   ├── jobWorker.ts # job validation + background processing (concurrency 3)
    │   ├── pipeline.ts  # per-photo pipeline -> exact 480x600 PNG
    │   ├── providers.ts # BgProvider: removebg | rembg-local | none
    │   ├── layout.ts    # A4 20-up grid + buildPdf with cut marks
    │   ├── store.ts     # local-disk records (server/.tmp)
    │   ├── cleanup.ts   # periodic deletion of old files/records
    │   └── config.ts    # env parsing (dotenv)
    └── tests/           # node:test + tsx suite (see below)
```

## Tests

```bash
cd server && npm test   # node --import tsx --test tests/*.test.ts
```

31 tests, all green, no network, no real API keys:

- `tests/layout.test.ts` — pure unit tests for the A4 grid math (page size,
  rect sizes, page distribution, no-overlap, in-bounds, even gaps, oversize
  margins throw).
- `tests/pipeline.test.ts` — real sharp pipeline on synthetic portraits with a
  local chroma-key **stub** standing in for the bg-removal provider (the real
  `processPhoto` has no provider-injection seam, so the documented step order is
  replicated; the stub never touches the network).
- `tests/validation.test.ts` — boots a real server child process
  (`BG_PROVIDER=none`) and exercises health/config, upload validation,
  dedupe, delete, and the job failure path end-to-end over HTTP.
- `tests/integration.test.ts` — 45 synthetic portraits → pipeline → real
  `buildPdf` → pdf-lib verification: 3 A4 pages, 20/20/5 image draws parsed
  from content-stream `cm` ops, matching `layoutPositions` within 0.5pt.

## Maintenance

- **Cleanup** — `cleanup.ts` runs on boot and every 30 minutes (unref'd):
  deletes originals/processed files, photo records and job JSONs older than
  `CLEANUP_HOURS` (based on file mtime). Orphaned records whose files are gone
  are dropped too.
- **Logs** — the server logs only to stdout (boot line with port + provider
  name; the API key is never logged). Under pm2/systemd, use the process
  manager's log rotation.
- **Storage growth** — everything lives under `server/.tmp/`. If disk fills up,
  lower `CLEANUP_HOURS` or wipe `server/.tmp/` while the server is stopped
  (records are rebuilt empty on boot).

## Honest limitations

- **Background removal is not built in.** You need a remove.bg API key
  (`BG_PROVIDER=removebg`, 50 free images/month) **or** a local Python
  `rembg` install (`BG_PROVIDER=rembg-local`). With `none`, processing jobs
  fail with a clear error. See `AI_API_SETUP.md`.
- **Face positioning is a subject-bbox heuristic, not ML face detection.**
  The pipeline trims transparent edges to find the subject box, fits it inside
  440×520, and composites it on a 480×600 canvas with a 40px top offset. It
  does not detect faces — odd poses or busy backgrounds may need the manual
  crop editor.
- **PDF image extraction is embedded-raster only.** Uploading a PDF recovers
  only JPEG (`DCTDecode`) and JPEG2000 (`JPXDecode`) images; FlateDecode raw
  pixels and vector-only pages yield "no embedded raster images found".
- **Uploads must be real images.** Files are sniffed via `sharp` magic bytes;
  only jpeg/png/webp pass. Extension alone means nothing.
- **Single-server local storage.** Records and files live on local disk
  (`server/.tmp/`); there is no database, no multi-instance sync, and no
  auth layer — put it behind your own reverse proxy / firewall in production.

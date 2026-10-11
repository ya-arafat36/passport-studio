# Background-Removal (AI) Setup

Photo processing needs an AI background-removal step. This app does **not**
ship one built in — you pick one of the two options below. There is **no
unlimited-free option**: every real provider either costs money per image or
costs you local compute time.

The choice is a single env var in `server/.env`:

```
BG_PROVIDER=removebg      # cloud API (needs REMOVEBG_API_KEY)
BG_PROVIDER=rembg-local   # local Python rembg (needs pip install rembg onnxruntime)
BG_PROVIDER=none          # disabled — jobs fail with "Background removal not configured"
```

Restart the server after changing it.

---

## Option A — remove.bg (cloud API, best quality)

1. Sign up at https://www.remove.bg and open the API dashboard to get a key.
2. Put it in `server/.env`:
   ```
   BG_PROVIDER=removebg
   REMOVEBG_API_KEY=your-real-key-here
   ```
3. Restart the server. `GET /api/config` should report `"bgProvider": "removebg"`.

**Cost honesty:**

- Free tier: **50 images/month**.
- Beyond that it is pay-as-you-go — see **remove.bg/pricing** for current
  prices (we don't quote numbers here because they change).
- Each processed photo = one API call. A 45-photo sheet = 45 calls, so the
  free tier covers roughly one sheet per month.

**Notes:**

- The key is read only from `process.env` on the server (`src/providers.ts`).
  It is never sent to the browser, never logged, and never appears in
  `/api/config`.
- The client retries twice on 5xx/network errors and surfaces 4xx rejections
  (e.g. bad key, quota exhausted) directly on the failed job item.
- Images are uploaded to remove.bg's servers — don't use this for photos you
  can't share with a third party.

## Option B — rembg-local (free, on your own hardware)

1. Install Python 3 with pip, then:
   ```bash
   pip install "rembg[cpu,cli]" onnxruntime opencv-python
   ```
   (plain `pip install rembg onnxruntime` also works — the `[cpu,cli]` extra
   just guarantees the CLI dependencies are present. `opencv-python` enables
   automatic face-centered cropping; without it the app falls back to
   subject-bbox cropping.)
2. The **first run downloads the u2net model (~176 MB)** — needs internet once,
   then works fully offline.
3. Set in `server/.env`:
   ```
   BG_PROVIDER=rembg-local
   REMBG_MODEL=u2net   # optional: u2net_human_seg, isnet-general-use, ...
   ```
   (no API key needed; leave `REMOVEBG_API_KEY` empty)
4. Restart the server. Processing spawns the bundled `server/rembg_stdin.py`
   adapter per photo (stable `rembg` Python API — works with rembg 1.x and 2.x,
   unlike the old `python3 -m rembg i` CLI invocation) and reads the
   transparent PNG from stdout.

**Cost honesty:**

- Free and unlimited — but **slow on CPU** (seconds to tens of seconds per
  photo depending on your machine; a GPU + `onnxruntime-gpu` helps a lot).
- Quality is good but generally a notch below remove.bg on tricky hair/edges.

---

## Honest comparison

|                        | remove.bg (cloud)              | rembg-local (your machine)          |
| ---------------------- | ------------------------------ | ----------------------------------- |
| Cost                   | 50 free images/month, then pay-as-you-go (see remove.bg/pricing) | Free, unlimited |
| Quality                | Best-in-class edges/hair       | Good, slightly rougher edges        |
| Speed                  | ~seconds per photo (their GPUs) | Slow on CPU, faster with GPU       |
| Privacy                | Images leave your machine      | Fully local after model download    |
| Setup                  | API key only                   | `pip install rembg onnxruntime` + ~176 MB model |
| Offline                | No                             | Yes (after first model download)    |

There is **no unlimited-free cloud option**. If someone promises one, it's
either rate-limited, watermarked, or not actually free.

## Tests never call real APIs

The test suite (`server/tests/`) replaces the provider with
`ChromaKeyStubProvider` — an honest local chroma-key that makes near-background
pixels transparent. No test performs a network call or needs an API key, so
`npm test` is safe and deterministic anywhere.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Job items fail: "Background removal not configured …" | `BG_PROVIDER=none` (or unset). Pick A or B above. |
| "BG_PROVIDER=removebg but REMOVEBG_API_KEY is not set" | Key missing from `server/.env`, or you forgot to restart. |
| "remove.bg rejected the request (HTTP 4xx)" | Bad key or quota exhausted — check your remove.bg dashboard. |
| "Failed to launch rembg … Is Python 'rembg' installed?" | `rembg` not on PATH for the server process. Install it for the same Python that `python3` resolves to, and restart. |
| First rembg-local photo hangs a long time | Model downloading (~176 MB). Wait for it once; later runs are local. |

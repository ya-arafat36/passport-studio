# Deployment

Two sketches: a plain VPS and Docker. Both assume you have read `README.md`
and `AI_API_SETUP.md` and have a working `server/.env`.

## 0. Build once, locally

```bash
cd server && npm install && npm run build   # -> server/dist/
cd ../client && npm install && npm run build # -> client/dist/
cd ../server && npm test                     # sanity: 31 green, no network
```

Production runs the **compiled** server (`node dist/index.js`), not tsx.

---

## Option 1 — VPS (Node 20+, Ubuntu/Debian sketch)

```bash
# as a deploy user
git clone <your-repo> passport-studio && cd passport-studio
cd server && npm install --omit=dev && npm run build
cd ../client && npm install --omit=dev && npm run build
cp ../.env.example ../server/.env   # then edit: PORT, BG_PROVIDER, keys...
```

### Process manager — pm2

```bash
npm i -g pm2
cd ~/passport-studio/server
pm2 start dist/index.js --name passport-studio --cwd ~/passport-studio/server
pm2 save && pm2 startup   # resurrect on reboot
pm2 logs passport-studio  # stdout logs (the server logs only to stdout)
```

### …or systemd

```ini
# /etc/systemd/system/passport-studio.service
[Unit]
Description=Smart Passport Photo Studio API
After=network.target

[Service]
User=deploy
WorkingDirectory=/home/deploy/passport-studio/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/home/deploy/passport-studio/server/.env

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now passport-studio
journalctl -u passport-studio -f
```

### nginx reverse proxy (client static + /api)

```nginx
server {
    listen 80;
    server_name photos.example.com;

    root /home/deploy/passport-studio/client/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        client_max_body_size 200m;   # >= MAX_FILES * MAX_FILE_MB headroom
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Add TLS (certbot) for anything beyond localhost. `client_max_body_size` must
cover your worst-case batch: default limits allow 100 × 15 MB uploads, so size
nginx accordingly (or lower `MAX_FILES`/`MAX_FILE_MB`).

### Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```
The Node server itself should **not** be exposed directly — only via nginx.

---

## Option 2 — Docker

### `server/Dockerfile` (multi-stage)

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# .tmp/ holds uploads + job records; mount it as a volume (see compose)
VOLUME /app/.tmp
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

### `client/Dockerfile` (static build; nginx serves it — see compose)

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# /api proxy configured in the nginx conf below
```

### `docker-compose.yml` (sketch)

```yaml
services:
  api:
    build: ./server
    env_file: ./server/.env
    volumes:
      - studio-data:/app/.tmp
    restart: unless-stopped

  web:
    build: ./client
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - api
    restart: unless-stopped

volumes:
  studio-data:
```

`nginx.conf` for the `web` service: same `location /api/` proxy as the VPS
sketch, but `proxy_pass http://api:4000;` (compose DNS name).

```bash
docker compose up -d --build
docker compose logs -f api
```

> Note: `rembg-local` inside Docker needs Python + pip in the server image
> (add a `python3 -m pip install rembg onnxruntime` layer and the ~176 MB
> model pre-download). For remove.bg you only need the env key.

---

## Backup / cleanup notes

- **Everything stateful lives in `server/.tmp/`** (or the `studio-data`
  volume): `originals/`, `processed/`, `jobs/*.json`, `meta.json`. Back that
  directory/volume up if uploads matter; otherwise it's disposable.
- The built-in cleanup task deletes files/records older than `CLEANUP_HOURS`
  (default 24) every 30 minutes — tune it down on small disks.
- There is no database migration story: `meta.json` is rewritten on every
  change and reloaded on boot; wiping `.tmp/` while stopped starts fresh.

## Scaling note

- The job worker processes photos with a **hardcoded concurrency of 3**
  (`CONCURRENCY` in `server/src/jobWorker.ts`). To raise it, change the
  constant and rebuild — there is no env var for it today.
- The API is otherwise stateless, but storage is local disk, so horizontal
  scaling needs a shared volume (or object storage, which would be a code
  change). For a single studio's workload, one instance is plenty: the heavy
  lifting is sharp (CPU-bound) plus the bg-removal provider you chose.

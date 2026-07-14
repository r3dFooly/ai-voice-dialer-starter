# Deploy

Recommended: **everything on one VPS** (backend + dashboard), so each project is a
self-contained box. Vercel is an optional alternative for the dashboard only.

## Prerequisites on the VPS

- Node 18+ and PM2 (`npm i -g pm2`)
- `nginx` + `certbot` (Let's Encrypt)
- Two DNS A-records → the VPS IP, e.g. `dialer.example.com` (backend webhook) and
  `console.example.com` (dashboard). The voice provider needs a public `wss://` URL.

## 1. Backend (voice-dialer + dialer-scheduler)

```bash
cd ai-voice-dialer-starter/backend
cp ../.env.example .env        # fill it in
npm ci || npm install
cd ..
pm2 start ecosystem.config.js  # starts voice-dialer (:4002) + dialer-scheduler
pm2 save
pm2 logs voice-dialer --lines 30
```

nginx for the backend websocket + webhook (`dialer.example.com` → `127.0.0.1:4002`):

```nginx
server {
  server_name dialer.example.com;
  location / {
    proxy_pass http://127.0.0.1:4002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # required for the /retell-llm websocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
  }
}
```

Then `sudo certbot --nginx -d dialer.example.com`. Point your Retell agent's Custom-LLM URL at
`wss://dialer.example.com/retell-llm` and its webhook at `https://dialer.example.com/retell-webhook`.

## 2. Dashboard — self-host (recommended)

```bash
cd ai-voice-dialer-starter/dashboard
cp .env.example .env.local     # NEXT_PUBLIC_SUPABASE_* + SUPABASE_SERVICE_ROLE_KEY + DASHBOARD_ACCESS_PASSWORD
npm ci || npm install
npm run build
pm2 start npm --name dialer-dashboard -- start   # next start on :3000
pm2 save
```

nginx (`console.example.com` → `127.0.0.1:3000`):

```nginx
server {
  server_name console.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

`sudo certbot --nginx -d console.example.com`. Redeploy on change:
`git pull && cd dashboard && npm run build && pm2 restart dialer-dashboard`.

## 2b. Dashboard — Vercel (alternative)

Import `dashboard/` as the project root on Vercel; set the same `NEXT_PUBLIC_SUPABASE_*` +
`SUPABASE_SERVICE_ROLE_KEY` + `DASHBOARD_ACCESS_PASSWORD` env vars. The **backend still runs on
the VPS** — Vercel hosts only the UI.

## 3. Go live

Flip the master switch in `agency_settings` (it ships `false`):
```sql
update agency_settings set setting_value='true'
 where setting_key='retell_dialer_enabled' and effective_from=(
   select max(effective_from) from agency_settings where setting_key='retell_dialer_enabled');
```
Confirm a `retell_default_from_number` / `RETELL_FROM_NUMBER` is set, load a test lead, and
watch `pm2 logs`.

## PM2 repoint trap

If you relocate the checkout, `pm2 delete voice-dialer dialer-scheduler` then `pm2 start`
again — do **not** `restart`. PM2 pins `env.pm_exec_path` from its saved dump and will relaunch
the OLD path. Strip `pm_*`/`PM2_*` from any hand-built env before `pm2 start`.

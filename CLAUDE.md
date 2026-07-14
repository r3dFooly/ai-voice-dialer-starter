# CLAUDE.md — AI Voice Dialer Starter

Project brief for any Claude session working in this repo. Read this first, then the
`docs/`. This file is intentionally **vertical-agnostic** — it must never accumulate any
one business's content. If you're launching a specific business on this dialer, your
customizations go in `.env`, `agency_settings` (DB), and the `knowledge/` files — **not
here**.

## What this is

A blank, reusable **AI outbound + inbound voice dialer**. An AI voice agent calls leads,
qualifies them, warm-transfers hot ones to a human, schedules callbacks, and logs
everything to a dashboard. Clone it, fill in a vertical, launch. Every external dependency
(CRM, model, notifications) sits behind a swappable adapter; all business/vertical content
is config, not code.

- **New project from scratch?** → follow `NEW_VERTICAL_SETUP.md`.
- **Being onboarded to customize + extend for a specific business?** → there is a companion
  build prompt (`KICKOFF-PROMPT.md`) that runs a customization interview and adds
  browser-managed operation.

## Architecture (one line)

Leads land in `retell_call_queue` → `scheduler.js` drains by priority (spend caps + pacing)
→ fires a Retell call → `server.js` runs the conversation over the custom-LLM websocket →
qualifies / transfers / schedules → writes outcomes to `retell_call_log` → dashboard reads it.

## Layout

```
backend/                 Node dialer (two PM2 processes)
  server.js              HTTP + Retell custom-LLM WebSocket turn loop, post-call analysis,
                         transfer, screener/voicemail/wrong-person, DNC opt-out  (~2.4k lines)
  scheduler.js           Queue drainer: priority + spend caps + retry cadence + dial  (~1.5k)
  tiers.js               Retry-cadence engine        callback-detector.js  Inbound match
  config.js              ALL vertical knobs, read from env (single source of truth)
  adapters/
    leadSource/          index (factory) · supabase.js (default) · ghl.stub.js (CRM template)
    llm/                 index.js — OpenAI-compatible client (callLLM / callLLMStream)
    notifier/            webhook.js — generic fire-and-forget POST (transfer/hot-lead alerts)
  compliance/            OFF by default — callingWindow · dnc · index (façade)
  system-prompt.txt, knowledge/*   BLANK prompt + call-script skeletons ({{placeholders}})
dashboard/               Standalone Next.js 16 / React 19 / Tailwind v4 app
  src/app/dialer/page.tsx            the console
  src/components/dialer/*            16 components (cards, queue, history, controls, settings)
  src/lib/dialer/*                   data layer (queries/actions/settings/status/types)
  src/lib/{config,utils,auth/gate,supabase/server}.ts
supabase/migrations/0001..0007       voice-only schema; 0007 = OPTIONAL compliance
docs/                    ARCHITECTURE · ADAPTERS · COMPLIANCE-MODULE · DEPLOY
```

## Core rules (do not violate)

1. **Keep it vertical-agnostic.** No company names, agent names, scripts, phone numbers,
   vertical terms, or industry rules in code. Vertical content lives in `.env`,
   `agency_settings`, or `knowledge/`. If you're tempted to hardcode a business value, add a
   config key instead.
2. **Adapters are the only door to the outside.** The dialer core never calls a specific CRM,
   model, or notifier directly — only `adapters/leadSource`, `adapters/llm`,
   `adapters/notifier`. Add integrations there.
3. **Secrets live in server-side `.env` only.** Never commit `.env` (only `.env.example`).
   Never surface provider API keys or the Supabase `service_role` key in the browser/dashboard.
4. **`is_lead_callable()` is fail-safe.** If that DB function is missing or errors, the
   scheduler dials NOTHING. It must exist (migration 0005).
5. **Compliance ships OFF** (bare dialer — pacing + spend caps only). Enabling it =
   `COMPLIANCE_MODULE_ENABLED=true` **and** apply migration 0007. US telemarketing is TCPA-
   regulated ($500–$1,500/call). Never enable real dialing without an explicit compliance
   decision by the operator. See `docs/COMPLIANCE-MODULE.md`.

## Config surface

- **Env** (`backend/.env`, from `.env.example`): provider keys, `SUPABASE_*`, `LLM_*`,
  `COMPANY_NAME` / `AGENT_PERSONA_NAME` / `SEGMENT_LABEL`, `TRANSFER_*`, `NOTIFY_WEBHOOK_URL`,
  tunables, `COMPLIANCE_MODULE_ENABLED`. Read via `config.js` (`const { config } = require('./config')`).
- **`agency_settings`** table (effective-dated K/V, read via `vw_agency_settings_current`):
  the master toggle `retell_dialer_enabled`, spend caps, retry tiers, calling window,
  transfer numbers. Editable at runtime (backend reads live — no restart for these).
- **`knowledge/` + `system-prompt.txt`**: the call flow. Currently files on disk.

## Verify (run before committing)

```bash
# backend syntax + boot
cd backend && npm install
for f in server.js scheduler.js tiers.js callback-detector.js; do node --check $f; done
node server.js   # should log 'listening ... leadSource=... compliance=...' and serve /health

# dashboard
cd ../dashboard && npm install && npm run build   # must exit 0

# migrations (throwaway Postgres)
docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine
for m in supabase/migrations/000{1,2,3,4,5,6}_*.sql; do \
  psql postgresql://postgres:pw@localhost:55432/postgres -v ON_ERROR_STOP=1 -f $m; done
docker rm -f pg
```

## Deploy (self-host on one VPS — recommended)

`pm2 start ecosystem.config.js` runs `voice-dialer` (server.js) + `dialer-scheduler`
(scheduler.js). Dashboard: `npm run build` then `pm2 start npm --name dialer-dashboard -- start`.
`nginx` reverse-proxy + `certbot` on two subdomains (Retell needs a public `wss://` for the
custom-LLM socket). Flip `retell_dialer_enabled` to `true` to go live. Full recipe:
`docs/DEPLOY.md`. **PM2 repoint trap:** if you relocate the checkout, `pm2 delete` then
`start` (never `restart` — PM2 pins the old path).

## Gotchas

- **`consent_verified` defaults `true`** (bare dialer, so leads dial). Migration 0007 flips
  it to opt-in — after that, new leads won't dial until consent is recorded.
- **Seed a `from` number** (`RETELL_FROM_NUMBER` or `agency_settings.retell_default_from_number`)
  or the scheduler skips every lead.
- **Idempotency is code-level** on `retell_call_log.provider_call_id` (no unique index).
- Rename the voice agent in Retell's own dashboard too — `AGENT_PERSONA_NAME` only controls
  prompt text, not the provider's configured voice/name.

# AI Voice Dialer — Starter

A blank, vertical-agnostic **AI outbound + inbound voice dialer**: an AI voice agent that
calls leads, qualifies them, warm-transfers hot ones to a human, schedules callbacks, and
logs everything to a live dashboard. Clone it, fill in your vertical, and launch.

Built to be **reused across projects** — all business/vertical content is blanked and every
external dependency (CRM, LLM, notifications) sits behind a swappable adapter.

## What's inside

```
backend/            Node dialer: Retell custom-LLM turn loop (server.js) + queue
                    scheduler (scheduler.js) + retry tiers, wired to adapters/
  adapters/         leadSource (Supabase default | CRM stub) · llm (OpenAI-compatible)
                    · notifier (generic webhook)
  compliance/       calling-window / DNC / consent — OFF by default
  system-prompt.txt, knowledge/   blank prompt + call-script skeletons
dashboard/          Standalone Next.js console: spend cards, active queue, call history
supabase/migrations/  Voice-only schema (call queue, call log, settings) + RPCs
docs/               Architecture, adapters, compliance, deploy
NEW_VERTICAL_SETUP.md   ← start here to launch for a new project
```

## Quickstart

```bash
# 1. database — apply supabase/migrations/0001..0006 to a fresh Supabase project
# 2. backend
cd backend && cp ../.env.example .env    # fill it in
npm install && node server.js            # boots the voice engine
# 3. dashboard
cd ../dashboard && cp .env.example .env.local
npm install && npm run build
```

Full walkthrough (accounts, prompts, deploy, compliance): **[`NEW_VERTICAL_SETUP.md`](./NEW_VERTICAL_SETUP.md)**.

## Architecture in one line

Leads land in `retell_call_queue` → `scheduler.js` drains by priority (spend caps + pacing) →
fires a Retell call → `server.js` runs the conversation over the custom-LLM websocket →
qualifies / transfers / schedules → writes outcomes to `retell_call_log` → dashboard reads it.

## Reusability seams

| Swap this | Via | Default |
|---|---|---|
| Where leads come from | `LEAD_SOURCE` + `adapters/leadSource/` | Supabase table |
| Which model | `LLM_BASE_URL` / `LLM_MODEL` | OpenAI-compatible |
| Where alerts go | `NOTIFY_WEBHOOK_URL` | (unset = off) |
| Calling rules | `COMPLIANCE_MODULE_ENABLED` + migration 0007 | off (bare dialer) |

## ⚠️ Compliance

Ships with **no** calling-window/DNC/consent enforcement by default. US outbound
telemarketing is subject to the TCPA ($500–$1,500 per call). Read
[`docs/COMPLIANCE-MODULE.md`](./docs/COMPLIANCE-MODULE.md) and §7 of the setup guide before
dialing real numbers.

## License

MIT — see `LICENSE`.

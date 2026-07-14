# Architecture

## Processes

| Process | File | Role |
|---|---|---|
| `voice-dialer` | `backend/server.js` | HTTP + the voice provider's **custom-LLM WebSocket** turn loop. Handles the live conversation, screener/voicemail/wrong-person detection, warm transfer, DNC opt-out, and the post-call webhook (disposition + analysis). |
| `dialer-scheduler` | `backend/scheduler.js` | Polls `retell_call_queue`, picks the highest-priority due + callable lead, enforces spend caps, and fires the outbound call. Owns retry cadence + priority decay. |
| `dashboard` | `dashboard/` | Next.js console (read/write to Supabase). |

## Data flow

```
lead ─(LeadSource.ingest)→ retell_call_queue
                                │
              scheduler.js tick │  (priority_score DESC, next_attempt_at, is_lead_callable())
                                ▼
                        Retell REST: create call ──► phone rings
                                                        │
                    server.js  ◄── wss /retell-llm ─────┘  (custom-LLM turn loop)
                        │  callLLM/callLLMStream (adapters/llm)
                        │  qualify → transfer (notifier) | callback | voicemail | DNC
                        ▼
                  /retell-webhook  (call_ended / call_analyzed)
                        │  writes outcome
                        ▼
     retell_call_log ──► dashboard cards + call history
```

## Database (Supabase / Postgres)

- **`retell_call_queue`** — one row per lead. Status, priority, per-lead attempt caps +
  cooldown, callback state, telephony enrichment, `lead_context` JSONB.
- **`retell_call_log`** — one row per call attempt. Duration, cost, transcript, disposition,
  sentiment, transfer outcome. Idempotent by `provider_call_id` (code-level, no unique index).
- **`agency_settings`** — effective-dated key/value store (master toggle, spend caps, retry
  tiers, transfer numbers, calling window). Read via `vw_agency_settings_current`.
- **RPCs** — `is_lead_callable(queue_id)` (fail-safe pacing gate), `get_retell_spend_today()`,
  `get_retell_spend_month()`.

## The three adapters

The dialer core never talks to a specific CRM, model, or notifier — only to adapters. See
[`ADAPTERS.md`](./ADAPTERS.md).

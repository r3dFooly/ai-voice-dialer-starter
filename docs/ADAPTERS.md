# Adapters

Three swappable seams keep the dialer vertical- and vendor-agnostic.

## 1. LeadSource — where leads come from & where results go

`backend/adapters/leadSource/` · selected by `LEAD_SOURCE` (`supabase` | `ghl`).

```
fetchCandidates({ limit })   -> queueRow[]   Pending + due, priority order
updateQueueRow(id, patch)    -> void
recordCallLog(row)           -> void         insert into retell_call_log
ingestLead(payload)          -> { id }       normalize + insert a new lead
markDnc(phone, reason)       -> void
writeback(queueRow, outcome) -> void         push result to an external CRM (no-op for supabase)
client                       -> raw supabase client (shared reads)
```

- **`supabase`** (default) — `retell_call_queue` is the system of record. No external CRM.
- **`ghl.stub.js`** — implement `ingestLead` + `writeback` (+ `markDnc`) to sync with
  GoHighLevel or any CRM. The local queue is still your work queue; the CRM feeds ingest and
  receives writeback. Copy it to build an adapter for any other CRM.

## 2. LLM — which model answers on the call

`backend/adapters/llm/` · OpenAI-compatible `POST {LLM_BASE_URL}/chat/completions`.

```
callLLM(messages)            -> { ok, content } | { ok:false, reason }
callLLMStream(messages, onD) -> streams deltas to onDelta, returns { ok, content }
```

Both never throw — on failure they return `{ ok:false }` so the turn loop falls back to a safe
line instead of dead air. The stream uses an idle-reset watchdog. Point `LLM_BASE_URL` at
OpenAI, a **LiteLLM** proxy, or an Anthropic-compatible gateway; set `LLM_MODEL` + `LLM_API_KEY`.

## 3. Notifier — where transfer / hot-lead alerts go

`backend/adapters/notifier/webhook.js` · fire-and-forget JSON POST to `NOTIFY_WEBHOOK_URL`.

```
notifyTransferIntent({ callId, leadName, phone, segment, assignedAgent, agentName, queueId })
notify(event, payload)   // generic escape hatch
```

Neutral payload — point it at a Slack/Discord/Teams incoming webhook or your own endpoint.
Unset `NOTIFY_WEBHOOK_URL` = notifications off. One-shot per call (no spam on retried turns).

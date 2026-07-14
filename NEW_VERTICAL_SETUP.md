# NEW_VERTICAL_SETUP — launching this dialer for a new project

This repo is a **blank, vertical-agnostic AI voice dialer**. It was extracted from a
working production dialer with all business/vertical content stripped out, so you can
clone it onto a fresh VPS and stand up an outbound (and inbound) AI calling system for
*any* project by filling in the blanks.

If you are a **new Claude chat** picking this up on a fresh VPS: read this whole file
first. It tells you exactly what to provision, what to fill in, and how to verify. A
copy-paste kickoff prompt is at the bottom.

---

## 1. What you get

- **`backend/`** — two Node processes:
  - `server.js` — HTTP + the voice provider's **custom-LLM WebSocket turn loop** (this is
    what actually talks on the call), post-call analysis, warm-transfer, screener/voicemail/
    wrong-person handling, and the DNC opt-out.
  - `scheduler.js` — the **queue drainer**: picks the highest-priority due lead, enforces
    spend caps + per-lead pacing, and fires the outbound call.
  - `tiers.js` (retry cadence), `callback-detector.js` (inbound match).
  - `adapters/` — the three seams that make it reusable: **LeadSource** (where leads come
    from), **LLM** (which model), **notifier** (where transfer/hot-lead alerts go).
  - `compliance/` — OFF by default (see §7).
- **`dashboard/`** — a standalone Next.js console: spend cards, active queue, call history
  with transcripts, master controls, retry-tier settings.
- **`supabase/migrations/`** — the database schema (7 files).

## 2. Accounts to provision (all fresh — nothing is shared)

| Service | Why | Notes |
|---|---|---|
| **VPS** (e.g. DigitalOcean) | Runs `server.js` + `scheduler.js` (must be always-on) and, if self-hosting, the dashboard | 1–2 GB droplet is plenty |
| **Supabase project** | The database | Create a NEW project. Grab the project URL + `service_role` key + `anon` key |
| **Voice provider (Retell)** | The AI voice agent + telephony | Create an agent, point its **Custom LLM** websocket at `wss://<your-domain>/retell-llm`, get the API key + agent id + a phone number |
| **LLM** | The model behind the voice | Any OpenAI-compatible endpoint (OpenAI, a LiteLLM proxy, or an Anthropic gateway). Need base URL + key + model |
| **Twilio** *(optional)* | Caller-ID / line-type lookup enrichment | Only if you set `ENABLE_TWILIO_LOOKUP=true` |
| **Notifier target** *(optional)* | Where "hot lead / transfer" alerts POST | Any URL: Slack/Discord/Teams incoming webhook, or your own |

> The dialer **backend cannot run on Vercel or Supabase compute** — the voice provider calls
> its webhook mid-call and the scheduler polls continuously, so it needs a persistent server
> (the VPS). Supabase is the database; Vercel (optional) can host only the dashboard UI.

## 3. Setup (on the new VPS)

```bash
git clone git@github.com:<you>/ai-voice-dialer-starter.git
cd ai-voice-dialer-starter

# --- database ---
# In your new Supabase project's SQL editor (or `supabase db push`), apply IN ORDER:
#   supabase/migrations/0001 … 0006   (0007 ONLY if you enable compliance — see §7)

# --- backend ---
cd backend
cp ../.env.example .env      # then fill it in (see §4)
npm install
# smoke test (Ctrl-C after you see it listen):
node server.js               # should log: listening ... leadSource=supabase ...
node scheduler.js            # should log: seeded defaults / entering loop

# --- dashboard ---
cd ../dashboard
cp .env.example .env.local   # fill NEXT_PUBLIC_SUPABASE_* + SUPABASE_SERVICE_ROLE_KEY + DASHBOARD_ACCESS_PASSWORD
npm install
npm run build
```

## 4. Fill the blanks (the vertical customization)

Everything vertical-specific is a config value or a `{{placeholder}}`. Fill these:

**`backend/.env`** — at minimum:
- `COMPANY_NAME`, `AGENT_PERSONA_NAME` (what the agent calls itself), `SEGMENT_LABEL`
- `RETELL_API_KEY`, `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `TRANSFER_PRIMARY` (a human's number for warm transfer), `NOTIFY_WEBHOOK_URL` (optional)

**Prompt + scripts** (`backend/`), currently blank skeletons — write your call flow:
- `system-prompt.txt` — the agent's identity, objective, rules, voicemail message.
- `knowledge/vertical-script.txt` — discovery questions, pitch, objection handling.
- `knowledge/inbound-script.txt` — how to handle inbound/callback calls.
- `knowledge/{avatar,product}-briefs.json` — optional persona/product briefs.
- Optional greeting overrides via env: `RETELL_FIRST_MESSAGE_GREETING`, `RETELL_INBOUND_GREETING`.

**Also rename the agent in the Retell dashboard itself** — the persona name/voice lives in
Retell's own agent config, outside this repo. `AGENT_PERSONA_NAME` only controls what the
prompt text says.

**Seed a `from` number**: the scheduler skips every lead until a caller ID exists. Set
`RETELL_FROM_NUMBER` or the `retell_default_from_number` row in `agency_settings`.

## 5. Load leads

Default lead source = the `retell_call_queue` table itself. Insert rows (phone_e164 +
contact_name required) via SQL, CSV import, or POST to your own ingest hook using the
LeadSource adapter's `ingestLead()`. To pull from a CRM instead, implement
`backend/adapters/leadSource/ghl.stub.js` (or write your own adapter) and set `LEAD_SOURCE`.

## 6. Go live + deploy

1. Point a subdomain's DNS A-record at the VPS.
2. `nginx` reverse-proxy + `certbot` for TLS on that subdomain (the voice provider needs a
   public `wss://` URL for the custom-LLM socket, and the dashboard needs HTTPS).
3. `pm2 start ecosystem.config.js && pm2 save` (runs `voice-dialer` + `dialer-scheduler`).
4. Dashboard: **self-host** (`npm run build` then `pm2 start npm --name dialer-dashboard -- start`,
   proxied by nginx on another subdomain) — recommended, keeps everything on one box. *Or*
   deploy `dashboard/` to Vercel (set the same Supabase env there).
5. Flip `retell_dialer_enabled` to `true` in `agency_settings` (starts disabled).

See `docs/DEPLOY.md` for the full nginx + PM2 + certbot recipe.

## 7. ⚠️ Compliance — READ THIS before dialing real numbers

This starter ships as a **bare dialer with NO calling-window, DNC, or consent enforcement**
in its default path (only per-lead pacing + spend caps). US outbound telemarketing is
subject to the **TCPA** (quiet hours, DNC scrubbing, prior consent) with statutory damages
of **$500–$1,500 per call**. Other jurisdictions/industries have their own rules.

To turn on the built-in guardrails: set `COMPLIANCE_MODULE_ENABLED=true` **and** apply
migration `0007_compliance_dnc.sql` (adds a DNC list, flips leads to opt-in consent, and
enforces a timezone-aware calling window inside `is_lead_callable`). This is a starting
point, **not legal advice** — own your compliance posture. See `docs/COMPLIANCE-MODULE.md`.

## 8. Gotchas (learned the hard way)

- **`is_lead_callable()` is fail-safe.** If it's missing or errors, the scheduler dials
  NOTHING. Make sure migration 0005 applied.
- **`consent_verified` defaults `true`** in the bare dialer so leads are dialable. Migration
  0007 flips this to opt-in — after applying it, new leads won't dial until consent is recorded.
- **PM2 repoint trap.** If you move the checkout, `pm2 delete` then re-`start` (don't
  `restart`) — PM2 pins the old path. Strip `pm_*`/`PM2_*` from any hand-built env.
- **Never commit `.env`.** Only `.env.example` is committed.

---

## Kickoff prompt for a new Claude chat

Paste this to a fresh Claude on the new VPS:

> I have cloned `ai-voice-dialer-starter` onto this VPS. It's a blank, vertical-agnostic AI
> voice dialer. Read `NEW_VERTICAL_SETUP.md` end to end. I'm launching it for **<describe your
> business / vertical / offer>**. Help me: (1) provision the accounts in §2, (2) fill
> `backend/.env` + `dashboard/.env.local`, (3) write `system-prompt.txt` and the
> `knowledge/` scripts for my vertical, (4) apply the migrations to my Supabase project,
> (5) load a few test leads, and (6) do the boot + verify steps. Ask me for anything you
> need (company name, agent name, offer, transfer number, calling rules). Do NOT enable the
> dialer until I've reviewed the prompt and decided on compliance (§7).

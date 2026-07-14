# Handoff Prompt — AI Voice Dialer: Grill, Customize, and Make Dashboard-Managed

You are picking up a freshly-built, blank AI voice dialer and standing it up for a real operator on this VPS. This repo (`github.com/r3dFooly/ai-voice-dialer-starter`, checked out locally) is **vertical-agnostic**: it has no business baked in. Your job is to (1) interview the operator to customize it for their specific business, (2) apply those answers, (3) rebuild the dashboard so the operator can run the ENTIRE dialer from their browser with no terminal for day-to-day work, and (4) verify and gate go-live behind a hard compliance check.

**Do this before anything else:** read the repo docs end to end so you understand the moving parts before you touch code:
- `README.md`
- `NEW_VERTICAL_SETUP.md`
- `docs/ARCHITECTURE.md`
- `docs/ADAPTERS.md`
- `docs/COMPLIANCE-MODULE.md`
- `docs/DEPLOY.md`

Then skim the code you'll be changing: `backend/server.js` (the Retell custom-LLM websocket turn loop), `backend/scheduler.js`, `backend/config.js`, `backend/knowledge/*`, `backend/system-prompt.txt`, the Supabase migrations `0001`–`0007`, and the dashboard's `DialerControls`, `RetrySettingsPanel`, `actions.ts`, and `queries.ts`.

**This repo has TWO separate apps, each with its OWN `.env` and DIFFERENT variable names:**
- **`backend/.env`** (copied from the root `.env.example`) — the Node dialer.
- **`dashboard/.env.local`** (copied from `dashboard/.env.example`) — the Next.js console.

Read BOTH `.env.example` files before writing any env value. **Treat each app's own `.env.example` as the single source of truth for that app's variable names — over any inline list in this prompt, including the lists below.** They intentionally do not share the same names (e.g. the backend uses `SUPABASE_URL`, the dashboard uses `NEXT_PUBLIC_SUPABASE_URL`). If this prompt and a `.env.example` ever disagree, the `.env.example` wins and you flag the discrepancy.

## What you're working toward

The operator wants to run a **new vertical** they'll describe to you, and they want to **manage all of it from the dashboard UI** — editing the prompt and scripts, persona/greetings, transfer numbers, notifier, caps/hours, DNC, and loading leads — without SSH'ing in. The honest boundary (respect it exactly):

- **Everything operational and every piece of business configuration lives in the UI**, read live by the backend.
- **Secrets and deploy-level infra stay in server-side `.env` and are planted once via SSH. They must NEVER reach the browser.** The two apps split like this:

  **`backend/.env` (server-side only):**
  - Secrets: `RETELL_API_KEY`, `LLM_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and (only if Twilio Lookup is enabled) `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.
  - Non-secret deploy config: `SUPABASE_URL` (**NOT** `NEXT_PUBLIC_` — this is the backend), `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`, `LLM_BASE_URL` / `LLM_MODEL`, `TRANSFER_PRIMARY` / `TRANSFER_FALLBACK`, `NOTIFY_WEBHOOK_URL`, `COMPLIANCE_MODULE_ENABLED`, `COMPANY_NAME` / `AGENT_PERSONA_NAME` / `SEGMENT_LABEL`, `LEAD_SOURCE`, and infra tunables (`PORT` default `4002`, `SCHEDULER_POLL_INTERVAL_MS`, `RETELL_CANDIDATE_BATCH_SIZE`, `RETELL_STALE_CALL_TTL_MS`, `LLM_TIMEOUT_MS`).

  **`dashboard/.env.local` (Next.js — anything `NEXT_PUBLIC_` is shipped to the browser):**
  - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — browser-safe by design (the anon key is meant to be public and is gated by RLS), set at deploy time.
  - `SUPABASE_SERVICE_ROLE_KEY` — **server-only** (no `NEXT_PUBLIC_` prefix, ever); used by server actions.
  - `DASHBOARD_ACCESS_PASSWORD` — the password gate for the whole console.

So "manage entirely from the dashboard" honestly means: **all business config + all day-to-day operation in the browser, with a one-time SSH/.env step (both files) to plant provider credentials and run migrations `0001`–`0007`** (`0007` is required before the compliance/DNC toggle does anything).

## Guardrails (hold these through every phase)

1. **The dialer ships DISABLED and STAYS disabled** until the operator has reviewed the final script and explicitly approves go-live. Never flip `retell_dialer_enabled` on for real dials on your own.
2. **Never put a secret in the browser, in the DB, in a client component, or in a git commit.** Provider keys and the service-role key are server-side `.env` only.
3. **NEVER give a secret a `NEXT_PUBLIC_` prefix.** In Next.js that prefix inlines the value into the browser bundle for anyone to read. The service-role key must be exactly `SUPABASE_SERVICE_ROLE_KEY` (server-only) — never `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. Only the Supabase URL and the anon/publishable key may carry `NEXT_PUBLIC_`. **Before every dashboard build, grep the dashboard env + source for any secret-looking `NEXT_PUBLIC_` var (service role, API key, password, token, secret) and ABORT the build if one is found.**
4. **Interview one question at a time. Do not assume answers.** Checkpoint every answer to a file as you go.
5. **Confirm before anything destructive** — schema changes, bulk lead operations, deleting data, running migrations against a populated DB.
6. **Never dial without affirmed prior express consent.** If the operator can't affirm it (Section 3 / Section 10), you flag it and refuse to enable dialing rather than let it slide.
7. Work on the VPS as a non-root user, absolute paths, no credentials in logs.

---

## PHASE 1 — GRILL (customization interview)

Run the interview below **one question at a time**. After each answer, reflect it back in a sentence to confirm you understood, then move on. Do not batch questions and do not fill in blanks with plausible defaults — a wrong or vague answer here makes the agent sound like a scam call or, worse, breaks the law.

**Checkpoint file:** create `backend/vertical-answers.md` (git-ignored) and after every answer append the question and the operator's verbatim answer. If the session drops, you resume from this file. Tell the operator this file is the source of truth for their configuration.

Ask each section's questions in order. The **why** line is for you — share it with the operator if they ask why a question matters.

### 1. Business Identity
*Why: sets the company name and the agent's spoken identity — every greeting, voicemail, and disclosure names the business.*
1. What is the exact name of your business as you want it spoken on a call? (The agent will literally say this.)
2. In one plain sentence, what does your business do?
3. Are you the business owner, or calling on behalf of someone else's business? If on behalf of, whose brand does the agent represent?
4. Is there a website, phone number, or email a curious person might Google mid-call — and what should the agent say if they ask "who is this / how did you get my number"?
5. Do you operate in a regulated industry (insurance, lending, healthcare, debt, solar, real estate)? If so, name it — the calling rules change a lot.

### 2. The Offer / Product
*Why: feeds the product briefs and the value statement; the agent can only pitch what you define and is barred from inventing prices or promises.*
1. What exactly are you selling or offering on these calls? Describe it like you'd explain it to a friend.
2. What is the single biggest reason someone says yes — the one benefit that matters most?
3. Is there a price, a "free/no-cost" angle, or a specific promotion? State the exact wording you're comfortable with the agent saying out loud.
4. Are there any claims, prices, or guarantees the agent must NEVER say? (These become hard "do not say" rules.)
5. Do you have more than one product/offer that different lead groups should hear? If yes, list them — each can get its own script.

### 3. Target Audience & Consent Story
*Why: defines WHO you're calling and WHY they'd expect the call — the consent story is both a conversion lever and the TCPA fault line.*
1. Who are these people? Describe your typical lead in a sentence (age, situation, what they need).
2. How did these people get onto your list — form fill, requested info, bought something, or a purchased/cold list?
3. When the agent says "I'm following up about ___," what is the true reason that makes the person go "oh right, yes"? (This becomes the lead context reason.)
4. How recently did they raise their hand? Minutes-old web leads and 6-month-old lists get treated very differently.
5. Do you have documented proof of consent to call each lead (and to call with an automated/AI system specifically)? Be honest — this decides whether we can dial at all.
6. Is there anyone on your list you must NOT call (existing customers, prior opt-outs, specific states)?

### 4. The Single Call Objective
*Why: sets the one job the agent optimizes toward every turn. Multiple competing goals make it meander and close nothing.*
1. When a call goes perfectly, what is the ONE thing that happened by the end? (Booked appointment? Warm transfer? Confirmed interest? Collected a specific answer?)
2. Hand a hot lead to a live person immediately, or schedule a callback for later? (Warm-transfer vs. booking.)
3. What is the acceptable "good enough" outcome when the perfect one isn't possible — a callback time, a texted link, permission to follow up?
4. Should the agent ever try to fully close/sell on the call itself, or always hand off to a human for the actual sale?

### 5. Conversation Flow, Discovery, Pitch & Objections
*Why: this is the body of the vertical script — discovery, value pitch, objection rebuttals, closing line. Blanks mean the agent has nothing to say past hello.*
1. What are the 2–4 questions the agent must ask to figure out if this person is a fit? (Short, phone-friendly.)
2. After they answer, what 1–2 sentences make the offer feel relevant to THEM?
3. What are the 3–5 most common objections/brush-offs ("I'm busy," "not interested," "how much," "is this a robot") and how do you want each answered — honestly and briefly?
4. What tone fits your brand — warm/consultative, upbeat/energetic, calm/professional? Give an example of how it should sound.
5. What is the closing line when someone IS interested, and the polite exit line when they're NOT?
6. Are there words, phrases, or a pushy vibe the agent must avoid entirely?

### 6. Qualification Criteria (What Makes a Lead "Hot")
*Why: defines the qualification criteria and the transfer gate — too loose spams your closers, too strict drops real buyers.*
1. What answers or traits make you say "yes, this is a real opportunity"? List the must-haves.
2. Are there disqualifiers that mean "do not pass to a human" no matter how interested they sound? (wrong location, no budget, not the decision-maker…)
3. What specific facts must the agent confirm/collect BEFORE it's allowed to transfer or book? (name, zip, eligibility, budget…)
4. Is there any sensitive info (SSN, full DOB, bank/card, health details) the agent must NEVER ask for or accept? (Hard rule.)
5. Generous (transfer anyone remotely interested) or picky (only clear fits)?

### 7. Warm-Transfer Rules & the Human's Number
*Why: sets the primary/fallback transfer numbers (`TRANSFER_PRIMARY` / `TRANSFER_FALLBACK` in env, `retell_transfer_primary` / `retell_transfer_fallback` in the DB) and the trigger; a wrong number means hot leads drop or ring a dead phone.*
1. Exact phone number (with country code, e.g. +1…) a hot lead should be connected to live.
2. Backup number if the first doesn't answer? If BOTH miss it — book a callback, take a message, or just alert you?
3. During what hours is a live human actually available for transfers? (Outside those, the agent books instead.)
4. Who is the human on the other end (name/role) so the agent can say a natural hand-off line?
5. Should the agent stay on to introduce the lead, or drop off once connected?

### 8. Notifications (Where Hot-Lead Alerts Go)
*Why: sets the notifier webhook (`NOTIFY_WEBHOOK_URL`) — the moment a lead qualifies or transfers, this is how a human finds out.*
1. Where do you want to be pinged when a lead is hot or a transfer happens — Slack, Discord, Teams, email, text, CRM?
2. Do you already have an incoming webhook URL for that channel, or do we build one together?
3. What goes in the alert — name, phone, interest, transcript link, outcome?
4. Should different events go to different places (hot leads to sales, opt-outs/complaints to you)?
5. Who besides you should receive these alerts?

### 9. Branding, Persona & Caller ID (Agent Name, Greeting, Voicemail, Outbound Number)
*Why: sets the agent name, first-message greeting, inbound greeting, voicemail script (and the Retell voice must be picked to match) — plus the outbound caller-ID number, which the dialer literally cannot run without.*
1. What should the AI agent call itself? (A simple first name works best.)
2. How should the very first line of an outbound call go? (We'll draft it — tell me the vibe.)
3. What voice — male/female, accent, energy? (Set in Retell's own agent config, separate from the script.)
4. Voicemail: short message it should leave — and include a callback number?
5. When someone calls the number BACK, how should the agent answer? (Inbound greeting.)
6. Should the agent disclose it's an AI/automated assistant if asked — or proactively? (Some states/industries require this.)
7. **OUTBOUND CALLER ID (MANDATORY before any dialing):** What phone number should appear as the caller ID on outbound calls (in E.164, e.g. `+15551234567`)? **Do you actually own that number, and is it provisioned in Retell/Twilio for OUTBOUND calls from this agent?** This is not optional — the scheduler **skips every lead** until a from-number is set, so no from-number means zero calls. It feeds `agency_settings.retell_default_from_number` (and/or `RETELL_FROM_NUMBER`) in the Customize phase.

### 10. Calling Rules & Compliance (Hours, Timezone, DNC, Recording, Consent)
*Why: drives operating days, hours, blocked dates, the DNC list, call-recording disclosure, and the compliance toggle. TCPA violations carry $500–$1,500 per call, and recording the wrong call is a separate wiretap/eavesdropping exposure. This section keeps you out of court.*
1. What local hours may the agent call? (Dialer respects each lead's OWN timezone; common safe window is 9am–8pm local.)
2. Which days of the week are OK, and any specific dates to block (holidays, blackouts)?
3. Calling across multiple states/timezones? (If yes, per-lead timezone matters and some states are stricter.)
4. **Call recording:** Are these calls recorded? And do you operate in — or call into — any all-party (two-party) consent state such as Florida or California? If either is yes, the agent must **verbally disclose the recording at the very start of the call.** (This is wiretap/eavesdropping law, separate from TCPA — getting it wrong is its own liability.)
5. Turn the built-in compliance guardrails ON — timezone-aware window, DNC scrubbing, consent-required-before-dialing? (Strongly recommended; it starts OFF, and with it off nothing stops an illegal call.)
6. Do you have a Do-Not-Call list (past opt-outs, complaints) to load before the first dial? Are you scrubbing against national/state DNC registries?
7. **IMPORTANT:** Can you affirm every lead gave prior express consent to be called by an automated system? If you can't, we do NOT dial until that's sorted — I will flag this rather than let it slide.
8. How many calls per day and per month total are you comfortable making? (Global caps, separate from per-lead limits.)

### 11. Lead Source (CSV / CRM / Webhook)
*Why: sets the lead source and, for a CRM, which adapter to wire; the dialer needs at minimum a phone and name and silently skips leads missing them.*
1. Where do your leads live now — spreadsheet/CSV, a CRM (GoHighLevel, HubSpot, Salesforce…), or real-time from a web form/webhook?
2. If a CRM: which one, and can you get an API key — or export a CSV to start?
3. For each lead, which fields do you have: phone (with country code?), name, timezone/state, email, source/reason?
4. Write completed-call results (answered, interested, opted-out) BACK into your CRM, or is one-way fine to start?
5. Roughly how many leads first, and how fast do new ones arrive?
6. Should brand-new real-time leads be higher priority than the existing list? (Ties into retry tiers.)

### 12. Retry Cadence & Tier Preferences
*Why: tunes the tier engine (per-tier daily/monthly/lifetime caps, cooldown, voicemail limits, engaged labels). Too aggressive reads as harassment and burns caller-ID reputation.*
1. If someone doesn't pick up, how many times a day is it OK to try — and how many days before giving up?
2. How long to wait between attempts to the same person (cooldown)?
3. Work fresh leads harder than old-list leads — agree? How hard for each?
4. Is there a label/tag meaning "this one is warm, work it more"? (Becomes the engaged-labels set.)
5. How many voicemails max for one person, ever?
6. When someone asks for a callback at a specific time, should that always take priority over normal cadence?
7. Rotate attempts across morning/afternoon/evening? (Recommended — lifts contact rates, looks less robotic.)

### 13. Wrap-Up, Dashboard Access & Go-Live Gate
*Why: confirms the operator can run everything from the browser and locks in human sign-off before any real dial.*
1. Who needs to log into the dashboard day-to-day? We will set `DASHBOARD_ACCESS_PASSWORD` to a **strong, unique** password — this single password is the only thing standing between the public internet and an autodialer's on/off switch plus all your leads' PII, so it must NOT be a simple/guessable one and must NOT be reused from anywhere else.
2. Which of these do you want to change yourself from the browser without a terminal: prompt/script, greetings, caps, hours, transfer number, DNC list, loading leads, master on/off? (We build the UI around your answer.)
3. Before going live, do you want to place a few test calls to your OWN phone to hear the agent first?
4. Have you reviewed and approved the final call script and the compliance answers? (I will NOT enable live dialing until you explicitly say yes.)
5. Anything about your business, leads, or feel that we haven't covered but you'd be upset if the agent got wrong?

**End of Phase 1:** read the full `backend/vertical-answers.md` back to the operator as a summary and get a "yes, that's right" before you customize anything.

---

## PHASE 2 — CUSTOMIZE (apply the answers)

Using the checkpointed answers, do the one-time setup and load initial leads. This is where the SSH/`.env`/migration work happens. Remember there are **two `.env` files** — each app's own `.env.example` is the source of truth for its variable names.

1. **Backend credentials + infra (`backend/.env`, one time, server-side only):** copy the root `.env.example` to `backend/.env` and fill it in. Secrets: `RETELL_API_KEY`, `LLM_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (and Twilio creds only if `ENABLE_TWILIO_LOOKUP=true`). Non-secret config: `SUPABASE_URL` (**not** `NEXT_PUBLIC_`), `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`, `LLM_BASE_URL` / `LLM_MODEL`, `TRANSFER_PRIMARY` / `TRANSFER_FALLBACK`, `NOTIFY_WEBHOOK_URL`, `COMPANY_NAME` / `AGENT_PERSONA_NAME` / `SEGMENT_LABEL`, `LEAD_SOURCE`, `COMPLIANCE_MODULE_ENABLED` (leave `false` for now), and tunables (`PORT` default `4002`, etc.).
2. **Dashboard credentials (`dashboard/.env.local`, one time):** copy `dashboard/.env.example` to `dashboard/.env.local`. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same project as the backend's `SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` (server-only, **no** `NEXT_PUBLIC_`), and `DASHBOARD_ACCESS_PASSWORD` (the strong, unique password from Section 13). Confirm with the operator before writing. **Never echo any of these to logs, chat/SMS/Teams, or a git commit — the access password is stored only in `dashboard/.env.local`.**
3. **Run migrations `0001`–`0007`** against the Supabase project. `0006` enables RLS; `0007` (compliance/DNC) is mandatory before the compliance toggle or DNC list does anything. Confirm before running against any non-empty DB.
4. **Wire the Retell agent to THIS server (Custom-LLM):** in the Retell dashboard, confirm the agent identified by `RETELL_AGENT_ID` is set to **Custom LLM** pointing at this server's public websocket URL — `wss://<your-domain>/retell-llm` (the exact public path depends on your nginx reverse-proxy config; see `docs/DEPLOY.md` — the server listens on the `/retell-llm` path with an optional `/retell-llm/<call_id>` suffix). Also import/attach the outbound from-number (Section 9 Q7) to the agent for outbound calls. If this isn't wired, the server can boot fine yet never handle a single turn.
5. **Author the initial content from the interview** so there's a working baseline — but note it will move to DB-editable form in Phase 3:
   - System prompt (`backend/system-prompt.txt`) with the identity, objective, qualification, transfer gate, and hard "do not say" rules.
   - `backend/knowledge/vertical-script.txt` (discovery, pitch, objections, close/exit), `inbound-script.txt`, `product-briefs.json`, `avatar-briefs.json` — validate the JSON.
   - Identity/persona/greetings/voicemail from Sections 1 and 9. **If Section 10 Q4 said calls are recorded in an all-party-consent context, bake a recording-disclosure line into the greeting now** (and it becomes a go-live gate item in Phase 4).
   - Transfer numbers (Section 7), notifier URL (Section 8).
   - Caller-ID from-number (Section 9 Q7) into `RETELL_FROM_NUMBER` and/or `agency_settings.retell_default_from_number`.
   - Caps, hours, operating days, blocked dates (Section 10); retry tiers, cooldowns, VM limits, engaged labels (Section 12).
6. **Pick and note the Retell voice** in Retell's own agent config to match Section 9 (this is provider-side, not in the script).
7. **Wire the lead source** (Section 11): CSV to start, or the CRM adapter per `docs/ADAPTERS.md`.
8. **Load the initial leads** into `retell_call_queue` with correct phone/E.164, name, segment, and initial tier/priority. The scheduler drains this queue. Skip/flag any lead missing phone or name. **Do not enable dialing.**

The dialer's scheduler already re-reads `agency_settings` every poll, so caps/hours/toggle/from-number/max-concurrent are already live-editable. Seed the DB settings from the answers so the dashboard reflects reality.

---

## PHASE 3 — MAKE IT DASHBOARD-MANAGEABLE (no terminal for day-to-day)

This is the core build. The block to no-terminal operation is `server.js`: it loads the system prompt, knowledge scripts, company/persona identity, inbound greeting, transfer numbers, and notifier URL into **module-level constants at STARTUP** (from files + env), so those are the file/env/restart-bound surfaces. **The fix pattern is identical everywhere: stop freezing these values at process start; read them from the DB per call or on a short TTL cache (30–60s) so operator edits take effect without a restart.**

**Reuse what's already there — don't duplicate infra:**
- `server.js` already holds a service-role Supabase client at `const supabase = leadSource.client` (around line 149). **Reuse it — do NOT create a second client.**
- Implement **ONE shared settings/knowledge cache helper** with a 30–60s TTL and route ALL live reads (prompt, knowledge, identity, greeting, notifier, transfer) through it, instead of scattering ad-hoc DB reads.
- **For EVERY new settings key, keep three lists in sync or the value silently never gets read:** the scheduler's `SETTING_KEYS` map + its value-type mapping (`backend/scheduler.js`, ~line 142), and the dashboard's setting-key list / types in `dashboard/src/lib/dialer/types.ts` (+ `settings.ts` / `actions.ts`). A key written by the UI but absent from `SETTING_KEYS` (or mis-typed in the value-type map) is written-but-never-read.
- **Ordering-safety rule (do not violate):** do NOT surface any new settings toggle/input as *functional* in the UI until its backend LIVE-read path actually exists. If you must ship the control early, render it visibly **disabled / "not wired yet"** so the operator never believes something is being enforced when it isn't. (See section I for the concrete compliance-toggle trap.)

Already live today (verify, don't rebuild): master on/off toggle (`retell_dialer_enabled`), operating days, hours, daily/monthly spend caps, blocked dates, per-tier retry caps + cooldown + Tier-1 decay, voicemail limits, all per-lead queue actions (Call Now, Move to Top, Reset Attempts, Change Tier, Reschedule, Skip/Remove/DNC, bulk Remove/DNC), and the read-only live-call board / spend tracker / call history.

Build the gaps below. Every new operational value goes to DB (`agency_settings` keys or a small new table), gets an **admin-gated server action** to write it, and gets read **live** by the backend.

**A. Script & Prompt editor (highest value)**
- New DB home for editable text: system prompt (either `agency_settings.retell_system_prompt` or a `dialer_prompts` table) and a `dialer_knowledge` table (`name`, `content`, `kind`) for `vertical-script`, `inbound-script`, `product-briefs`, `avatar-briefs`.
- Dashboard "Script & Prompt" panel: a textarea editor per document, JSON-validated editors for the briefs, admin-gated server actions that upsert to DB.
- **Backend:** `server.js` must stop caching `SYSTEM_PROMPT_TEMPLATE` at module load and the knowledge loaders (`loadVerticalScript`/`loadInboundScript` `_vsScriptCache`, briefs loader) must stop caching for process lifetime. Replace disk-read + lifetime cache with a DB read on the shared short-TTL helper. (The current cache never invalidates during the process, so a file-sync approach alone still needs a restart — must be DB + TTL.)
- Fold the per-segment script map (`SEGMENT_SCRIPT_MAP` env JSON) into `dialer_knowledge` as one row per segment; read segment scripts from DB keyed by segment.

**B. Identity panel**
- New `agency_settings` keys `retell_company_name`, `retell_agent_persona_name`, `retell_segment_label`; three text inputs in `DialerControls`, included in `updateDialerSettings`.
- **Backend:** `server.js`/`scheduler.js` must read these from the live settings object per call instead of `config.company` (frozen at start). The scheduler already re-reads settings each poll — wire company/persona/segment through that path (and add the keys to `SETTING_KEYS`).

**C. Transfer panel (two dead DB keys already SEEDED)**
- `agency_settings.retell_transfer_primary` / `retell_transfer_fallback` already exist — **seeded by migration `0002`** — but the backend reads env (`TRANSFER_PRIMARY` / `TRANSFER_FALLBACK`) instead and no UI writes them. **Wire the UI + backend read to these existing keys; do not invent new ones.** Add two E.164-validated inputs writing those keys.
- **Backend:** change `server.js` to read transfer targets from the live settings row; add them to `SETTING_KEYS` in `scheduler.js` and pass through. No restart to change.

**D. Caller ID + Max concurrent (backend already reads live; UI-only gap)**
- Add an E.164 "Caller ID" input writing `retell_default_from_number` (already SEEDED in migration `0002`; scheduler already reads it live). This is the mandatory from-number from Section 9 Q7 — surface clearly that dialing is skipped entirely while it's blank.
- Add a numeric "Max concurrent" input writing `retell_max_concurrent` (already read live). No backend change for either.

**E. Notifier webhook URL**
- New key `retell_notify_webhook_url`; URL input in an Integrations/Transfer panel + server action.
- **Backend:** `adapters/notifier/webhook.js` reads `config.notifier.webhookUrl` (captured at startup from `NOTIFY_WEBHOOK_URL`) — change it to read the URL from the live settings object at fire time.

**F. Inbound greeting**
- New key `retell_inbound_greeting`; text input in the Script & Prompt panel.
- **Backend:** `server.js` must read the greeting from DB per inbound call instead of the `INBOUND_GREETING` module const.

**G. Load Leads panel**
- New "Load Leads" panel: CSV upload + single-lead add form → admin-gated server action that validates phone/E.164 and inserts rows into `retell_call_queue` (name, phone, segment, initial tier/priority). No backend change needed (scheduler drains the queue); optionally reuse the webhook's scoring path.

**H. DNC List panel**
- New "DNC List" panel backed by the migration `0007` DNC table: add a number, bulk CSV import, search/remove — admin-gated server actions.
- **Backend:** ensure `backend/compliance/dnc.js` is checked at dial time. This only runs when the compliance module is enabled (see I), and requires migration `0007` applied.

**I. Compliance toggle + calling-window enforcement**
- New key `retell_compliance_enabled` + a **clearly-labeled toggle with a TCPA warning** in `DialerControls`. Surface whether migration `0007` is applied (the toggle is inert without it).
- **Backend — this is a live-read-path trap, honor the ordering-safety rule:** today `backend/compliance/index.js` captures the flag ONCE at process load — `const enabled = config.compliance.enabled;` (line 14) — reading the STATIC env var `COMPLIANCE_MODULE_ENABLED`. So a `retell_compliance_enabled` UI toggle is **INERT** until you refactor compliance/scheduler to read the flag from the live settings row each poll. **Until that backend refactor lands, render the toggle disabled / "not wired yet"** — an operator must NEVER be able to flip a switch that looks like it turns on DNC/quiet-hours enforcement while nothing actually changes. Once the live read exists, enabling it takes effect without a restart. (General rule: any DB key you add to the UI before its backend read path exists must be shown non-functional.)

**J. (Optional, low priority) Cosmetic tier labels + LLM model/temp/max-tokens/voice model**
- Only build if the operator wants to relabel tiers or swap models from the browser. If so, add `retell_tier_labels` / `retell_llm_model` keys and read `config.llm.model` / tier labels from live settings. Otherwise leave in env (`LLM_MODEL`, etc.) as advanced infra.

**Secrets boundary (repeat for this phase):** none of A–J introduces a secret into the browser or DB. Provider keys and the service-role key stay in `.env`; server actions run server-side and use the service-role key without exposing it. No new `NEXT_PUBLIC_` secret, ever. If any design would require a secret client-side, stop and redesign.

After the backend changes, restart the process ONCE so the new DB-read code paths are live — from then on, operator edits need no restart.

---

## PHASE 4 — VERIFY + GO-LIVE (hard compliance gate)

1. **Build/boot checks:** dashboard builds and serves; backend boots clean; scheduler polls and reads settings from DB; confirm each Phase-3 edit takes effect live (change a value in the UI, confirm the backend picks it up within the TTL without a restart). Before the dashboard build, run the `NEXT_PUBLIC_` secret grep from Guardrail 3 and abort if anything secret-looking is prefixed.
2. **Prove the no-restart claim** for at least the prompt, a knowledge script, identity, transfer number, greeting, and notifier URL — edit each in the UI and observe the change reflected without touching the terminal.
3. **Retell wiring is real:** with the operator, place a **test call from their OWN phone** that actually reaches the LLM turn loop (they hear the agent respond, not just that the server logged "listening"). This confirms `RETELL_AGENT_ID` → Custom-LLM → `wss://<domain>/retell-llm` and the from-number import are correct end to end. Then run through greeting, voicemail, objection handling, and a transfer before any real lead is dialed (Section 13 Q3).
4. **Security checks (the whole browser-managed model depends on these — all must pass):**
   - **Auth gate works:** an UNAUTHENTICATED request to a dashboard admin view / server action is rejected (no valid `DASHBOARD_ACCESS_PASSWORD` cookie ⇒ blocked). Verify it actually 401s/redirects rather than serving data.
   - **RLS is on and the anon key is blind to PII:** confirm RLS is enabled (migration `0006`) and that the `NEXT_PUBLIC_SUPABASE_ANON_KEY` **cannot `SELECT`** lead PII / call data (`retell_call_queue`, `retell_call_log`). Test with the anon key directly — it must return zero rows / permission denied. Only the server-side service-role path may read that data.
   - **Transport is encrypted:** the dashboard is served over **HTTPS** (or bound to localhost behind an authenticated reverse proxy). NEVER expose a plaintext public dashboard — the access password and lead PII would travel in the clear.
5. **HARD COMPLIANCE / TCPA GATE — all must be true before enabling real dials:**
   - Operator explicitly affirmed prior express consent to call each lead with an automated/AI system (Section 3 Q5, Section 10 Q7). If they cannot, **STOP — do not enable dialing**, and tell them exactly what to resolve.
   - **Call-recording disclosure:** if calls are recorded and any leg touches an all-party-consent state (Section 10 Q4), the recording-disclosure line is present at the start of the greeting. If it should be there and isn't, **STOP**.
   - Compliance module decision made; if ON, migration `0007` is applied, its live-read path exists (Phase 3 §I), the DNC list is loaded, and the timezone-aware calling window is enforcing.
   - Operator has reviewed and **explicitly approved the final call script and compliance answers** (Section 13 Q4).
   - Caller-ID from-number is set (Section 9 Q7) — otherwise the scheduler dials nothing anyway.
   - Global daily/monthly caps, hours, operating days, and blocked dates are set sanely.
6. **Only after all of the above and an explicit "yes, enable it" from the operator**, they flip the master toggle on from the dashboard. You do not enable it for them silently. Then watch the first batch of live calls together and confirm outcomes and alerts are flowing.

Throughout: interview one question at a time, checkpoint answers, never expose a secret to the browser (and never `NEXT_PUBLIC_` a secret), confirm before destructive actions, and keep the dialer disabled until the operator reviews and approves.

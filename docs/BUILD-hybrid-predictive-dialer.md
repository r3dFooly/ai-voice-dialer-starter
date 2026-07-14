# Build Plan — AI-Screen Predictive Dialer (Hybrid on managed ViciDial)

The **how**, phase by phase. Pairs with `V2-DECISION-predictive-dialer.md` (the *why/which
path*). Target: an AI-fronted predictive dialer where the LLM screens (answer → kill dead-air
→ confirm live human + right-person) and **cold-transfers only warm humans** into a **managed
ViciDial** agent floor. The full-custom deltas are marked ⧉.

> **Cost truth this design relies on:** the AI is on the line only for the ~30–60s screening
> window, then releases. Human handle time carries **no AI cost**. Verify the transfer is a
> release/REFER (not a lingering bridge) in Phase 1, or you pay AI + both legs for the whole call.

---

## Two hosting truths (read before sizing anything)

1. **Do not self-host ViciDial on your app VPS.** ViciDial/Asterisk wants a **dedicated box
   (8 GB+ RAM, SSD, 4+ cores)** and is **real-time-audio sensitive** — co-locating it with your
   Node/Next stack means CPU contention causes choppy/one-way audio. And a non-technical partner
   can't safely run Asterisk. **Use managed/hosted ViciDial** (~$15–55/agent/mo) — the host owns
   the Asterisk/Linux/DB layer; your partner just runs the floor in the browser UI.
2. **Your VPS runs only the light half.** The AI screening leg (`backend/`) + the dashboard are
   modest (Node + Next `next start` ≈ **1–2 GB running**; the Next *build* is the only spike, ~2 GB
   — build with swap or on a 2 GB+ box). **So your current VPS RAM is a non-issue for the hybrid**
   as long as ViciDial is hosted elsewhere. If it's a 1 GB droplet, it runs the AI leg fine; just
   build the dashboard with a swapfile or on Vercel. *(Tell me your droplet size for an exact call.)*

⧉ **Full-custom route:** there's no ViciDial, so you host the agent platform yourself too — plan
a separate, larger box (or managed Twilio infra) and accept you now own real-time audio SLAs.

---

## Cross-cutting workstreams (the angles we were missing — they span every phase)

These are not "phases," they run alongside the whole build and are **existential for insurance
outbound** — skipping them is how dialers get sued or get zero connect rate:

- **Caller-ID reputation & STIR/SHAKEN (make-or-break for connect rate).** Spam-flagged numbers =
  nobody answers, and your AI never gets to screen anyone. You need: DID rotation / local-presence
  numbers, **STIR/SHAKEN attestation** (buy DIDs from carriers that sign A-level attestation),
  and continuous **"Scam Likely"/spam-flag monitoring + remediation** (services like Numeracle,
  Caller ID Reputation, Free Caller Registry). *This is exactly what Convoso's Ignite does for you —
  on the ViciDial/custom path you own it.* Budget it as a real line item, not an afterthought.
- **TCPA litigator + DNC scrubbing (lawsuit prevention).** Insurance lead-gen is a magnet for
  serial-TCPA plaintiffs. Scrub every list against **national + internal DNC** *and* a **litigator/
  known-plaintiff list** (Blacklist Alliance, DNC.com, TCPA Litigator List) **before** loading the
  hopper. Log consent provenance (PEWC) per lead. One un-scrubbed litigator = a five-figure claim.
- **Recording storage + retention.** Stereo recordings pile up fast (~0.5 MB/min). Set a retention
  policy, cron-offload ViciDial's disk recordings to S3/object storage, and treat them as PII.
- **Reporting reconciliation.** Metrics now live in two places — your AI leg (Supabase: dials,
  answers, AI-screen pass/fail, abandonment) and ViciDial (MySQL: agent talk time, dispositions,
  sales). Build one funnel view: dials → answers → AI-passed → agent-connected → sold.
- **Toll-fraud / VoIP security.** Any Asterisk/SIP endpoint is a fraud target — SBC/firewall,
  IP allow-listing on trunks, TLS/SRTP, spend alerts. (Managed hosting covers most of this.)
- **Failover / uptime.** A dead dialer = idle paid agents. Dual SIP carriers (primary + failover),
  and a health-check/restart on the AI leg (PM2 already restarts).

---

## Phase 0 — Stand up the floor (managed ViciDial) · *integrator/host, no code*
**Goal:** agents taking real calls on a proven floor, before any AI.
- Provision managed ViciDial; connect **two SIP carriers** (Twilio Elastic SIP / Telnyx) with
  A-attestation DIDs; buy an initial DID pool for local presence.
- Create a **closer/blended campaign** + a dedicated inbound **in-group** (e.g. `AISCREEN`) with a
  next-agent strategy (`oldest_call_finish` for fair idle-based routing; add rank for skill tiers).
- Create agent logins; agents use ViciDial's **native WebRTC agent screen** (this is your softphone
  + presence + queue — you build none of it).
- Turn on compliance controls: **adaptive drop % ≤3%**, safe-harbor audio, local-call-time,
  internal DNC. Wire DNC + litigator scrubbing into list import.
- **Acceptance:** place a plain PSTN test call → DID → in-group → a Ready agent's browser answers
  with a screen-pop. *(Prove this before touching AI — mis-set in-group/DID routing is the classic
  ViciDial foot-gun where calls queue forever.)*

## Phase 1 — SIP bridge spike (highest-variance piece) · *coding + telephony*
**Goal:** hand a live, already-answered call from your side into ViciDial with a correct screen-pop.
- From a Twilio/Retell test call, **transfer the connected leg into the ViciDial DID → in-group**.
- **Pre-write the lead** via ViciDial `non_agent_api.php` (`add_lead`/`update_lead`, set
  `vendor_lead_code` = your lead UUID, preserve consumer **ANI**) **before** the transfer — else
  ViciDial auto-creates a bare lead and the pop is empty/wrong.
- Verify **media topology**: no one-way audio (NAT/RTP), decide who records (avoid double-record),
  and confirm the AI leg **releases** on transfer (cost + hangup ownership).
- **Acceptance:** a test "consumer" is transferred, a Ready agent's screen pops the right lead, two-
  way audio is clean, and the AI leg has dropped. **Do not proceed until this is solid.**

## Phase 2 — AI screening leg (reuse the repo) · *cloud-agent-buildable*
**Goal:** the AI answers, holds, screens, and triggers the Phase-1 bridge.
- Repurpose `backend/server.js`: keep answer + `SHORT_GREETING` (no dead-air) + the
  human/voicemail/wrong-person heuristics (`SCREENER_RE`, `detectVoicemailGreeting`,
  `detectWrongPerson` — Retell has no native AMD, these *are* your detector). **Invert the logic:**
  cleared screener + right-person confirmed → **route to agent** (was: pitch).
- **Gate the handoff:** before transferring, check ViciDial has a **Ready agent** (poll
  `non_agent_api` / the live-agents table). Never dangle a live human on the AI hoping an agent frees.
- Bake in the **AI-voice disclosure** (FCC Feb-2024: AI voice = artificial/prerecorded → identity
  disclosure + PEWC gating) and recording disclosure for all-party states (FL/CA).
- **Acceptance:** a real answered call is screened by the AI and warm-transferred to a live agent in
  **<10s** (ideally <5s once right-person confirmed), agent opens already-briefed.

## Phase 3 — Predictive pacing + abandonment governor · *coding, compliance-critical*
**Goal:** fire at a ratio that keeps agents busy without over-abandoning.
- **Fix the throughput gotcha:** `scheduler.js tick()` currently dials **one lead per cycle** even
  with a raised cap — convert it to a **dial-N loop**; N = clamp(readyAgents × ratio − inProgress).
- Read Ready-agent count live; compute the ratio from recent connect rate.
- ⚠️ **Ownership decision (from the decision doc):**
  - **Pattern A (recommended first):** let **ViciDial dial predictively**, your AI screens *its*
    connects → ViciDial owns the ≤3% abandonment safe-harbor. **Skip building the governor.**
  - **Pattern B (your AI fires):** you own abandonment — build the **≤3%/30-day metering + safe-
    harbor abandoned-call message + auto-throttle** in your orchestrator. Only do this if you must
    own pacing.
- **Acceptance:** sustained dialing keeps agents busy, live abandonment rate stays < 3%, and the
  governor throttles as it approaches the cap (Pattern B) or ViciDial does (Pattern A).

## Phase 4 — Agent platform · **ViciDial provides this — zero build in the hybrid**
Softphone, Ready/On-Call presence, ACD/queue routing, agent auth, recording, reporting, supervisor
listen/whisper/barge — all native ViciDial. **Nothing to build.**

⧉ **Full-custom route — this is the big net-new phase (weeks):** build the Twilio Voice SDK browser
softphone (AccessToken/VoiceGrant token service + TwiML conference bridge + `Device` + call
controls), `dialer_agents` auth, `agent_sessions` presence + Supabase Realtime, `call_assignments`
routing + next-agent algorithm + overflow, supervisor tools, recording, and reporting — i.e. rebuild
everything Phase 0 gave you. This is the 2–4 months and the reason the decision doc says don't-custom-first.

## Phase 5 — Supervisor & analytics (your dashboard) · *optional, cloud-agent-buildable*
- Extend the existing dashboard into a **supervisor/analytics** surface: live abandonment-rate tile,
  the AI-screen funnel (dials→answers→passed→connected→sold), spend, DID reputation health.
- Reconcile with ViciDial's native reports (Phase-cross-cutting: reporting reconciliation).

## Phase 6 — Harden & scale · *ops*
- Caller-ID reputation monitoring loop + DID rotation; litigator/DNC re-scrub cadence; recording
  offload to S3; carrier failover test; spend/fraud alerts; load-test the ratio at target agent count.

---

## Sequencing summary

| | Hybrid (managed ViciDial) | Full custom ⧉ |
|---|---|---|
| Live agents by | **~2–4 weeks** (Phase 0) | ~2–4 months |
| You build | AI leg (P2) + bridge (P1) + optional pacing (P3) + analytics (P5) | all of that **+ the entire agent platform (P4)** |
| Owns abandonment | ViciDial (Pattern A) | You, always |
| Partner runs floor | ✅ ViciDial UI | ❌ until you build ops UI |
| On your VPS | AI leg + dashboard only (light) | everything (needs a bigger box) |

**Recommended order:** P0 → P1 (spike) → P2 → P3 (Pattern A) → P5, with the cross-cutting
workstreams running throughout. Get the floor live on hosted ViciDial in weeks; layer your AI edge;
decide own-vs-rent on real numbers.

*Not legal advice — validate TCPA/TSR/DNC, STIR/SHAKEN, litigator-scrub, and recording-consent
specifics with counsel before dialing at scale.*

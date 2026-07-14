# V3 — AI-Fronted Predictive Agent Platform: Product & Architecture Design

**Status:** Design / pre-build · **Scope:** single-tenant (operator-first), productizable later
**Builds on:** this repo's Retell custom-LLM screener (`backend/server.js`), scheduler (`backend/scheduler.js`), Supabase schema (`retell_call_queue` / `retell_call_log` / `agency_settings`), and Next.js 16 / React 19 / Tailwind v4 dashboard.
**Supersedes for V3:** `docs/ROADMAP-V2-PREDICTIVE-DIALER.md` and `docs/V2-DECISION-predictive-dialer.md` chose a *hybrid/ViciDial fast-path* for V2. V3 makes a different, deliberate call for an **owned, branded, latency-controlled** platform — **on UX / latency / ownership grounds, not compliance grounds** (§2). Both are recorded; §2 explains why V3 diverges.

> **Blank-template rule.** This doc is vertical-agnostic (per the repo's core rule). No company names, agent names, or vertical-specific business content. "The operator" is whoever launches the platform; "segment / vertical" is their configured business line; regions (e.g. `us-east`) are illustrative.

> **⚠️ Compliance gate — read first.** V3 originates outbound calls whose FIRST voice the consumer hears is an **AI / synthetic voice**. Under the FCC's **February 8, 2024 Declaratory Ruling**, an AI-generated or otherwise synthetic voice **IS an "artificial or prerecorded voice"** under the TCPA. Every outbound AI-voice dial placed for a telemarketing/solicitation purpose therefore requires **prior express *written* consent (PEWC)** *before* the call is placed — and a human agent joining later does **not** retroactively remove that classification. This platform's design **increases**, not decreases, telemarketing exposure versus a human-dialed floor. **Do not go live without written sign-off from qualified telemarketing counsel.** Treat every "≤3% abandonment," "consent," and "recording-consent" statement in this doc as a hard build requirement, not an option.

---

## 1. Overview & the EndZone framing

### 1.1 What V3 is

V3 is the operator's **own branded, multi-page agent platform**: an AI-fronted **predictive/parallel dialer** where the LLM does the cold, low-value work — answer, kill dead-air, confirm a live human, confirm the *right* person — and **transfers ONLY warm, qualified humans** to logged-in human agents who close. The existing codebase is already half of this: a custom-LLM voice screener that answers, holds, screens, and transfers. V3 wraps it in the operator-facing product: an in-browser agent desktop, live monitoring, pacing control, a CRM lead hub with import, per-vertical custom dispositions and fields, an agent state machine, and reporting.

The design principle throughout: **the AI absorbs the screening/pacing work and the human agent only ever meets a confirmed, warm human.** But note the compliance corollary (§2): *the AI touching the consumer first is exactly what makes every dial an artificial/prerecorded-voice call requiring PEWC.* The AI-first inversion is a **UX and ownership** advantage, not a compliance shortcut.

### 1.2 The EndZone framing — and why it's the *bar*, not the *blueprint*

The operator points at **agentendzone.io / EndZone** as the connection-quality reference. Framing matters:

- **EndZone is INBOUND call *delivery*** — it routes inbound callers to agents with an excellent, instant-feeling connection. Direction is inbound; the platform's job is delivery + connection quality.
- **V3 is OUTBOUND AI-screen + agent-close.** We originate calls, an AI screens them, and only warm humans reach an agent. Direction, value-add, **and regulatory posture** are different (outbound telemarketing = TCPA/TSR; inbound delivery is not).

So EndZone is **not** an architecture to copy. What we copy is the **UX bar**: the moment a call is routed to an agent, the audio is *there* — no ring-to-voice dead gap, no per-call negotiation stall, no "can you hear me now." That instant-connect feel is the benchmark, and §3/§4 describe concretely how we approach it (persistent warm WebRTC endpoint + in-SFU participant swap + comfort-noise ramp), because in our model the human is dropped **into an already-live conversation the AI is holding** — the warmest possible transfer.

### 1.3 The four pillars of V3

1. **Owned media path** (LiveKit) for a latency-controlled agent WebRTC endpoint.
2. **Server-authoritative agent state machine** that *enforces* "disposition every call."
3. **Config-driven everything** — per-vertical dispositions and custom fields, no hardcoding.
4. **Supabase-native** presence, realtime, RBAC, and reporting extending the existing schema.

---

## 2. Engine decision: Y (headless ViciDial) vs Z (custom LiveKit/Twilio)

### 2.1 The fork

- **Y — ViciDial headless:** keep ViciDial as a certified predictive + compliance engine (abandonment governor, DNC, ratio dialing, TSR safe-harbor) behind a custom UI.
- **Z — fully custom media:** own the media on LiveKit (or Twilio Voice SDK / Telnyx WebRTC), own pacing + abandonment, own latency.

### 2.2 Recommendation: **Z — custom media on LiveKit**, chosen on **UX / latency / ownership** grounds only

**The compliance rationale in earlier drafts was legally inverted and is corrected here.** V3 does **not** get to claim a lighter compliance burden because an AI answers first. The opposite is true:

- **The AI voice IS an artificial/prerecorded voice (FCC, Feb 8 2024).** Every outbound AI-voice dial for a telemarketing purpose requires **prior express *written* consent (PEWC)** *before* dialing. A human joining the call later does not change the classification of the leg the consumer already heard.
- **TSR abandonment still applies, and the AI does not count as a "live rep."** The Telemarketing Sales Rule requires a **live representative on the line within 2 seconds** of the consumer's completed greeting, measured as an abandonment rate that must stay **≤3%** (per campaign, over each 30-day period), with the **FTC safe-harbor recorded message** played on any abandoned call. **An AI screener answering the consumer does not satisfy "live rep"** — so AI-first origination has *more* surface area for an abandoned-call finding, not less. Statutory damages are **$500–$1,500 per call**.
- **Therefore Z is chosen for UX, latency, and ownership — never for compliance.** We are building the agent desktop, presence, routing, monitor, and reporting regardless; that discards exactly what ViciDial's value is (its native agent screen/ACD UI), leaving only its predictive/abandonment engine. Reskinning ViciPhone (a WebRTC softphone bolted onto Asterisk/Kamailio) means fighting a 20-year-old PHP/Perl stack's opinions on agent state, dispositions, and data model. You cannot get a React 19 agent desktop, custom fields in the pop, and a Supabase-native lead hub without rewriting Vici's front half anyway. That, plus the LiveKit media advantages in §2.3, is the whole case for Z.

**PEWC is a HARD GATE from day one.** Concretely:

1. **Apply migration `0007` in V3** (not optional here): `consent_verified` default flips to **false**, and `is_lead_callable()` enforces the **consent gate** (`consent_verified = true`), DNC, and calling window. The scheduler's hot-path index already re-adds `consent_verified = true` under `0007`.
2. **Enforce consent at import** (§6 `/leads`): the import wizard cannot set `consent_verified = true` without a mapped, retained **written-consent** artifact per row (source, timestamp, capture text). Rows without it import as **not callable**.
3. **The ≤3% abandonment governor is UNAVOIDABLE regardless of engine.** Building custom (Z) does not remove it — we must build a real predictive/abandonment controller with the safe-harbor message (§9). This is precisely why **Y/ViciDial remains attractive as a *certified compliance hedge*:** a proven, auditable abandonment engine is a genuine value if regulatory pressure demands one. Keeping Y available (headless, behind LiveKit SIP) is a *risk reduction*, not a UI compromise.

**Get telemarketing counsel sign-off before go-live.** Consent model, abandonment accounting, recording consent, and the safe-harbor script must be reviewed by qualified counsel before the first real dial.

### 2.3 Why LiveKit over Twilio Voice SDK / Telnyx WebRTC (for Z)

Validated against current (2025–2026) infra facts:

| Axis | **LiveKit** (pick) | Twilio Voice JS | Telnyx WebRTC |
|---|---|---|---|
| **SFU + TURN geography** | You own it. Cloud region-pin or self-host the SFU in-region (agents' region → co-located cloud region, e.g. us-east); co-locate coturn. **Best latency ceiling.** | Telephony-first; media hairpins through Twilio PoPs, no SFU-region control. | Own anycast backbone, TURN co-located with PoPs (sub-200ms RTT), but provider-routed — fewer knobs than LiveKit. |
| **PSTN ⇄ browser** | Via SIP ingress into a Room (a bit more infra) — but it's the pattern that lets AI + human co-exist in one room. | Simplest out-of-box (TwiML → browser client). | Nearly as simple, more explicit SIP control. |
| **AI-voice fit** (the differentiator) | **First-class.** LiveKit Agents SIP + Phone Numbers are **GA (2025)**; the AI screener and the human agent are **participants in the SAME room**. | AI is an external media-forward-and-return integration around a telephony core. More glue, more hops. | AI is a WebRTC/SIP endpoint you wire yourself; no turnkey "agent room." |
| **Warm transfer** | **In-SFU participant swap** — drop the AI participant, add the human. **No SIP REFER.** | SIP REFER / TwiML Dial/Conference orchestration. | SIP REFER by default (conference-swap possible if you build it). |
| **Co-regional latency** | Low one-way agent↔SFU when co-located (measure it — §3). | Good but topology opaque. | Sub-200 ms RTT in-region. |
| **Ops** | Highest (self-host) — mitigate by starting on **LiveKit Cloud**. | Lowest. | Middle. |

Two facts seal it for *this* app:

1. **Warm transfer stops being a REFER.** This repo's memory documents real REFER pain (trunk `transfer_mode` rejecting cold SIP REFER). On LiveKit the "transfer" is an **in-SFU participant swap** inside a room the media never leaves — that class of failure disappears. (The destination agent still receives normal join/track signaling — see §3.2 for the honest version.)
2. **The AI and the agent share one media fabric.** The migration target is **LiveKit Agents** hosting *both* the AI screen leg and the human leg in one room, collapsing the extra SIP↔WebRTC bridge hop. Chained-provider inbound paths (e.g. a Twilio→LiveKit SIP-inbound hop) add measurable round-trip we avoid by unifying — but treat those figures as **to-be-measured on our own topology**, not as design guarantees.

### 2.4 Recommended Z stack

- **Media / agent WebRTC + AI screening + warm transfer:** LiveKit (Cloud now → self-host SFU + coturn in-region later, gated on the §10 cost model).
- **PSTN origination/termination:** a SIP trunk (e.g. Telnyx = cost-good US, A-level STIR/SHAKEN) into LiveKit SIP, **decoupled from the media SDK**. Feeds `did_pool` for local presence + spam-flag monitoring. **A PSTN caller is G.711 narrowband at the carrier boundary — the G.711↔Opus transcode at the SIP gateway is unavoidable (§3.3, lever 4).**
- **AI screening leg (phase 1):** keep the proven Retell custom-LLM bridged in via SIP. **Later migration target:** LiveKit Agents to collapse Retell + the bridge into one fabric — budget for sub-500ms AI-first-word (e.g. fast STT ~150ms + fast LLM ~250ms + streaming low-latency TTS, streamed). **AMD/voicemail detection lives on this leg (§4.5).**
- **Pacing / abandonment:** our own predictive controller service (§9 `/dialer`), a real closed-loop controller — **not** the ratio formula that appears in earlier drafts.
- **ViciDial:** reserved as a **certified-engine compliance hedge** (headless behind LiveKit SIP) — kept explicitly available because the ≤3% governor is unavoidable and hard to build well (§2.2, §9).

---

## 3. Low-latency media architecture — approaching the EndZone bar

### 3.1 Two planes, never conflated

- **Plane 1 — MEDIA (LiveKit):** guarantees low *audio* latency. Owns the connection quality bar.
- **Plane 2 — SIGNALING/PRESENCE (Supabase Realtime):** call-pop, agent presence, live monitor. Only needs UI-coherence speed (~<100ms median, <300ms p95) — far looser than audio. Detailed in §8.

### 3.2 The "instant-connect" technique (the honest version)

The EndZone-class feel comes from **reusing an already-established transport**, not from "zero signaling." Precisely:

1. **On "Go Ready":** establish a **persistent LiveKit connection** — **ICE gathered + DTLS handshake complete**, `getUserMedia` mic acquired, echo canceller warm, comfort noise playing in the agent's ear. This transport stays up for the whole Ready period; **device/pipeline warmup and the expensive ICE/DTLS handshake happen here, once, not per call.**
2. **Screened callers are parked** on the media server as RTP endpoints (held by the AI).
3. **Routing decision = adding the parked caller's audio track to the agent's already-connected session** (a participant/track swap inside the SFU). **What we save is the per-call ICE gathering + DTLS handshake** — the multi-hundred-millisecond part — because the agent's transport is already up. **We do NOT eliminate signaling:** the destination agent's PeerConnection still receives normal LiveKit **join/track-subscribe/SDP** signaling for the new participant/track. So this is **ICE/DTLS *reuse*, not "no renegotiation."**
4. **A 50–100 ms playout ramp** fades comfort-noise → caller audio so there's no dead-silence-to-voice glitch.

**Target, not guarantee:** click-answer to human voice is *hypothesized* in the low tens of milliseconds because the handshake is pre-paid. **That "tens of ms" figure MUST be empirically measured on LiveKit Cloud (our region, our trunk) before it becomes a design benchmark or a marketing claim.** The track-subscribe signaling round-trip is real and non-zero; measure it.

Because the AI already holds the live warm human in the room, the agent is dropped **into an already-live conversation** — warmer than any inbound delivery, independent of the millisecond count.

### 3.3 The eight latency levers (design constraints)

1. **SFU/PoP geography** — the single biggest lever. Pin the SFU in the agents' region. Cross-region routing adds 40–120 ms each way.
2. **PSTN↔SFU bridge location** — terminate the SIP trunk into a gateway in the *same* region/DC as the SFU so caller RTP and agent WebRTC meet locally. A trunk landing in another region silently doubles the audio path.
3. **TURN placement** — prefer direct host/srflx UDP; use TURN only on restrictive NAT, and when used it MUST be **regional/co-located with the SFU**, never a default global relay (a full extra hop).
4. **Codec / transcoding — right-sized for PSTN.** A **PSTN caller arrives as G.711 (μ-law) narrowband at the carrier boundary**; the SIP trunk delivers G.711. The agent leg is WebRTC **Opus**. Therefore a **G.711↔Opus transcode at the SIP gateway is UNAVOIDABLE** — do not design around "avoiding" it. The rule is: **keep it a single hop inside the bridging media server** (LiveKit SIP / the SFU's SIP bridge), never a separate transcoding hop. "Keep Opus end-to-end / avoid transcoding" applies **only to SIP-native or WebRTC-native legs** — e.g. the AI screen leg ↔ agent leg when both are Opus participants in the same room (no PSTN in between). PSTN in the path = one transcode, always.
5. **Tight jitter buffer** — the agent leg is inside our controlled DC/TURN path, so run a **small** buffer (20–40 ms), not a conservative 60–120 ms default.
6. **Silent auto-reconnect on network change** — WiFi switch/IP change invalidates ICE+TURN; raw WebRTC will **not** self-heal. Watch `onconnectionstatechange`: on `disconnected` start a ~5s grace timer; on persistence/`failed` call `restartIce()` + `createOffer({iceRestart:true})` and re-signal, keeping the call UI "in call"; only surface a drop banner after ~60–90s. **LiveKit's SDK does this ICE-restart ladder + signaling-websocket reconnect internally** — lean on it and re-publish audio on `reconnected`.
7. **Pre-warmed persistent PeerConnection** — one long-lived `RTCPeerConnection` (ICE+DTLS done, comfort noise flowing) for the whole time the agent is Ready. §3.2.
8. **Device/pipeline warmup at Go-Ready** — mic, echo canceller, and audio-device spin-up cost real time on first acquire; pay it at Go-Ready, not at answer.

### 3.4 Network-check & telemetry (the EndZone-grade signal)

**Pre-shift network check** (gates "Go Ready"):

- Flow: Go Ready → 10–20 s test against a LiveKit test Room/echo endpoint **in the production region** (so the test path == the real media path) → poll `pc.getStats()` every 1s → aggregate → compute estimated MOS → gate.
- Metrics from `getStats()`: **RTT** (`candidate-pair.currentRoundTripTime` / `remote-inbound-rtp.roundTripTime`), **jitter** (`inbound-rtp[audio].jitter`), **loss** (`ΔpacketsLost/ΔpacketsReceived`), **jitter-buffer delay** (`ΔjitterBufferDelay/ΔjitterBufferEmittedCount`).
- Thresholds (VoIP): RTT good <100ms / warn 100–250 / bad >250–300; loss good <1% / warn 1–3% / bad >3–5%; jitter good <20ms / bad >30–50ms; JB delay concern >60–80ms / bad >100ms.
- Estimated MOS (E-model, good enough to gate): `Ie = 0.1*lossPct; d = rttMs + jitterBufMs; Id = 0 if d≤100, (d-100)*0.02 if d≤300, else 4+(d-300)*0.04; R = 94 - Ie - Id; MOS = 1 + 0.035R + R(R-60)(100-R)*7e-6` (clamp 1..4.5).
- Gate: **MOS ≥ 3.8 → allow Ready**; 3.0–3.8 → allow but flag "network degraded" + which metric failed; **< 3.0 → BLOCK Ready** with specific guidance ("high loss / high delay — move closer to AP or go wired").

**In-call quality telemetry** (continuous):

- Sample `getStats()` every 3–5s during every call; compute rolling RTT/jitter/loss/MOS.
- Stream a compact per-call quality series to the backend → `call_quality` companion table (keyed by call/agent id) for admin reporting + post-mortems.
- Live per-agent quality badge (green/amber/red) on `/monitor` off the metrics broadcast channel — a supervisor sees a degrading agent *before* the customer complains.
- On sustained degradation (MOS <3 for >10s) raise a soft in-UI warning to the agent and log it; tie repeated bad-network events to the agent's device/location for coaching.
- Correlate quality with disposition outcomes to catch "lost the sale because the line was bad."

---

## 4. The agent desktop + the state machine

### 4.1 Agent desktop UX (single page, presence-driven — the whole screen re-skins by state)

**Global top bar (always visible):**
- **Presence pill (left):** color-coded state (Ready=green, Reserved=amber pulse, On-Call=blue, Wrap=purple, Paused=grey) with a live timer (idle time in Ready, talk time On-Call, wrap countdown, aux time in Paused).
- **READY/PAUSE control (right):** a single toggle. Not-Ready → "Go Ready"; Ready → "Pause" split-button whose dropdown lists configured reasons. **Disabled** (greyed, tooltip "available after you disposition") during Reserved/On-Call/Wrap. Clicking Pause mid-call shows "Pause pending — after wrap."
- **Identity, connection-quality dot** (WebRTC RTT/jitter/loss — the EndZone-grade signal), **Logout.**

**Call-pop** (renders on Reserved, persists through On-Call/Wrap as the call header):
- Fires a **looping ring sound** + **browser Notification** + **tab-title flash** (§8) so an agent on another tab still gets pulled in. Large Answer/Decline if manual; if **auto-answer** is configured, a 1–2s "Connecting…" then bridge — **but auto-answer carries a mandatory answer-confirmation check (§4.5, §4.8): no agent audio within N seconds → treat as missed, requeue the caller.**
- **Contact block:** `contact_name`, `phone_e164`, segment/product_interest, timezone, **plus the per-vertical custom fields** rendered from `lead_context` via `custom_field_definitions` (labels/order config-driven, same fields used in import + reports). **PII-flagged fields are masked by default (§5.3).**
- **AI screening summary (the differentiator):** the screener's `call_summary`, right-person-confirmed flag, `bant_score`, sentiment, and a short transcript snippet of what the prospect just said — the agent opens *talking*, not cold. Consent/PEWC + DNC-clear badges for compliance confidence.

**In-call control bar** (active only On-Call):
- Mute/Unmute, Hold/Unhold (hold audio to prospect), Hangup (→ auto-wrap), **Transfer** (to another logged-in human — warm/consult or cold; modeled explicitly in §4.4), **Mark-DNC** (immediate lead suppression, call continues), DTMF keypad. Big, keyboard-shortcut-bound. Live talk timer + recording indicator + quality dot stay visible.

**Disposition panel** (blocking modal on Wrap):
- Header: "Disposition required — wrap ending in MM:SS" (server-authoritative countdown, soft warning ~15s).
- **Outcome buttons:** the operator-configured disposition set for THIS vertical, **snapshotted at call start** so they can't shift mid-wrap.
- **Conditional sub-form:** selecting a disposition reveals its required fields (**Callback → datetime**, which also **binds the callback to this agent** — §4.6; **Sale → amount/product**; **Not-Interested → reason**) plus agent-editable custom fields. Notes textarea always available. Submit disabled until required fields validate. **No skip/close-X** — the only exits are Submit or the server max-wrap timeout.

**Pause/Not-Ready view:** workspace dims to a clear "You are Not-Ready (reason • aux timer)" card with a prominent Go-Ready button and inline reason switcher — unmistakable that the agent is NOT receiving calls.

### 4.2 The state machine (server-authoritative, one authoritative table)

**Authority model (no dual source of truth).** `agent_sessions` is the **ONE authoritative table for AGENT presence state**. `call_assignments` is the authoritative table for the **CALL lifecycle**. They are **not** two copies of the same fact — but where they overlap (an agent is Reserved *because* an assignment is offering, On_Call *because* an assignment is connected) they are **written together in a single transaction** by the transition function, and the link is `agent_sessions.current_assignment_id`. Every transition = one `set_agent_state(...)` RPC that atomically updates **both** rows (agent presence + the assignment's lifecycle state) and emits the presence event. **No code path may update one without the other.** The `/monitor` board and the pacing loop read `agent_sessions.state` as the authority for "who is Ready" — never a JWT claim (§6, JWT-staleness fix).

**State ↔ DB literal reconciliation (1:1 with `agent_sessions.state`).** The `agent_sessions.state` CHECK is exactly: `'offline' | 'registering' | 'ready' | 'paused' | 'reserved' | 'on_call' | 'wrap_up'`. (Corrects the earlier draft: **`registering` is added**; **`ringing` is renamed to `reserved`** to match the FSM.) The UX names below map 1:1 to these literals.

**State table:**

| State (UX) | DB literal | Meaning | In dial pool? | Entry | Normal exit |
|---|---|---|---|---|---|
| **Logged_out** | `offline` | No agent session, no WebRTC registration, invisible to reservation engine. Terminal-idle. | No | Fresh load, logout, force-logout, heartbeat-lost eviction | → Registering (submit creds) |
| **Registering** | `registering` | Transient bootstrap: mint short-lived WebRTC token, register endpoint, confirm mic, pre-gather ICE (STUN/TURN) so the first bridge is warm. | No | Successful auth | → Paused(Just-logged-in) on success; → Logged_out on mic-deny / reg-fail |
| **Paused / Not-Ready** (reason: Just-logged-in, Break, Lunch, Training, Coaching, Admin, Missed-call, Timeout, Forced) | `paused` | Registered but deliberately OUT of the pool. Reason required, timestamped, reportable (adherence/aux). Reason swappable in place. | No | Go-Ready→Pause, deferred pause at wrap, missed-call policy, force | → Ready (Go Ready); reason↔reason |
| **Ready** | `ready` | In the reservation pool; eligible for the next AI-screened warm transfer. Endpoint warm. `last_ready_at` stamped (longest-idle routing). **Only state the dialer picks from.** | **Yes** | Go-Ready, wrap-submit re-arm, TTL expiry re-arm | → Reserved (dialer picks); → Paused (agent pause) |
| **Reserved** | `reserved` | Dialer selected THIS agent for a specific screened warm call and is bridging. Atomically removed from pool. Pop renders, ring + notification fire, endpoint alerts (or auto-answers). Reservation TTL runs. | No (held) | Ready → dialer CAS | → On_Call (answer confirmed); → Ready/Paused(Missed) (decline/TTL/no answer-audio); → Ready/short-Wrap (prospect abandons) |
| **On_Call** | `on_call` | Media bridged; agent talking. Call timer runs. Mute/hold/hangup/transfer/DNC live. Presence-changing actions accepted but **DEFERRED** as pending flags. | No | Reserved → media bridge + answer-confirmed | → Wrap_up (hangup / bridge BYE / agent leg drop / force-hangup); → (transfer, §4.4) |
| **Wrap_up** | `wrap_up` | AUTO-entered the instant the bridge tears down. Held OUT of pool. Disposition panel is a **blocking modal**; server-authoritative wrap-deadline runs. Cannot return to Ready until a valid disposition (or max-wrap timeout). **The enforcement point for "disposition every call."** | No | On_Call → teardown (either signal) | → Ready (submit, no pending flag); → Paused (submit + pending pause/force); → Logged_out (submit + pending logout); → Ready/Paused(Timeout) (max-wrap elapses) |

**Key transitions (actor · effect):**

- **Logged_out → Registering** · AGENT submits creds · create `agent_sessions` row, mint WebRTC token.
- **Registering → Paused(Just-logged-in)** · SYSTEM · agents land Not-Ready **by design** — they must explicitly opt in to receiving calls.
- **Registering → Logged_out** · TELEPHONY · mic denied / SIP-WebRTC reg failed · surface actionable error (mic blocked / network / TURN unreachable), tear down.
- **Paused(any) → Ready** · AGENT "Go Ready" · presence=`ready`, stamp `last_ready_at`, add to pool, emit event. **(There is no SYSTEM/supervisor path into Ready — see §4.3.)**
- **Paused(A) → Paused(B)** · AGENT · swap reason + restamp aux timer; stays out of pool.
- **Ready → Paused(reason)** · AGENT · remove from pool immediately, start aux timer.
- **Ready → Reserved** · SYSTEM · **atomic CAS on `state='ready'`**, attach `current_assignment_id`, set the assignment to `offering` in the SAME transaction, render pop, fire ring + notification, start reservation TTL, begin alert/auto-answer.
- **Reserved → On_Call** · TELEPHONY · agent leg answers **and answer-audio is confirmed (§4.5)**, media bridges · start call timer, activate controls, cancel ring + TTL, assignment → `connected`.
- **Reserved → Ready** · AGENT/SYSTEM · decline OR TTL expires · re-offer to next Ready agent (or hand back to AI hold); assignment → `missed`/`offering`(re-target).
- **Reserved → Paused(Missed)** · SYSTEM · no-answer/decline **or answer-confirmation failure** with auto-not-ready policy ON · pull the distracted/absent agent out so they stop burning warm transfers; requires manual Go-Ready.
- **Reserved → Ready (or short Wrap)** · TELEPHONY · prospect abandons before agent answers ("ghost") · no full wrap; log abandoned-at-transfer metric (feeds the ≤3% governor, §9).
- **On_Call → On_Call** · AGENT · mute/hold/mark-DNC · in-call side effects only, NOT a presence change.
- **On_Call → Wrap_up** · TELEPHONY · hangup / bridge BYE / media-server bridge-end · AUTO: set `state='wrap_up'` keyed on `current_assignment_id`, open `wrap_session`, start wrap-deadline, force modal.
- **On_Call → Wrap_up** · TELEPHONY · agent WebRTC drops mid-call · open short reconnect window; on fail → Wrap_up with suggested disposition "Dropped/Disconnected."
- **On_Call → (transfer)** · AGENT · warm/consult or cold transfer to another agent · modeled in §4.4.
- **Wrap_up → Ready** · AGENT · valid disposition (+ required per-vertical sub-fields) AND no pending flag · `apply_disposition(...)` persists to `retell_call_queue`/`retell_call_log`/`call_assignments`, close `wrap_session`, re-add to pool.
- **Wrap_up → Paused / Logged_out** · AGENT · valid disposition AND a `pending_pause`/`pending_force`/`pending_logout` was set during the call · persist, then honor the deferred action.
- **Wrap_up → Ready or Paused(Timeout)** · SYSTEM · max-wrap elapses with no submit · auto-stamp a `Not_Dispositioned` outcome (flagged for QA), re-arm per the auto-ready-vs-auto-pause config toggle.
- **any (not On_Call) → Paused(Forced)** · SYSTEM supervisor **force-not-ready** · drop from pool now; **if On_Call, set `pending_force` and apply at wrap** (never kills a live call).
- **On_Call → Wrap_up** · SYSTEM supervisor **force-hangup**/barge-drop · authoritatively tear down bridge, then normal auto-wrap.
- **any → Logged_out** · AGENT logout / heartbeat lost > grace / supervisor **force-logout** · if On_Call, guard/confirm and defer via `pending_logout` until wrap; otherwise deregister endpoint + end session.

### 4.3 Supervisor **force-ready is DISALLOWED** (explicit non-transition)

There is deliberately **no supervisor "force this agent Ready" action.** Forcing an away/paused agent into Ready manufactures the exact failure the ≤3% governor exists to prevent: the pacing loop counts that seat as available, dials against it, and bridges a live warm human to an **empty chair** — an abandoned call, a TSR/TCPA exposure event, and a terrible consumer experience. Supervisors get the **protective** controls only: **force-Pause** and **force-Logout** (remove a seat from the pool), plus listen/whisper/barge. **Entering Ready is always the agent's own explicit opt-in.** This is a hard rule; if ever added behind a break-glass flag it must be audit-logged.

### 4.4 Agent-to-agent transfer (modeled in the FSM)

Transfer creates (or re-targets) a `call_assignments` row pointing at **agent B**, and B goes through the **normal reservation path** so every guard (Ready-only, CAS, TTL, answer-confirmation) still applies.

- **Preconditions:** target **B must be `ready`** (in the pool). If B is Paused/On_Call/Wrap, the transfer offer **fails gracefully** and initiator **A stays On_Call** (nothing changes). B being in Wrap means B is *not* available — B must finish their own disposition first.
- **Cold (blind) transfer:** B: `ready → reserved → on_call` (answer-confirmed). At B's connect, **A → Wrap_up** immediately (A disposes their leg). The prospect's parked audio is swapped from A to B via the same in-SFU participant swap.
- **Warm / consult transfer:** B: `ready → reserved → on_call` and joins as a **third participant** (A + B + prospect, or A + B with prospect on hold, operator-config). When A hands off and leaves, **A → Wrap_up**; **B stays On_Call** with the prospect. B's eventual hangup drives B's own On_Call → Wrap_up.
- **State bookkeeping:** the transfer is one transaction — A's `current_assignment_id` is released and B's is attached; both `agent_sessions` rows and the assignment lifecycle move together (§4.2 authority model). Talk-time attribution splits by participant intervals on `call_assignments` (§7.4 counters).
- **Abort:** if B declines or B's reservation TTLs out, the transfer is cancelled and **A remains On_Call** (re-offer to another agent or cancel entirely — operator choice).

### 4.5 AMD / voicemail detection (moves to the AI screen leg in Z)

In the custom-media (Z) stack there is **no carrier/Twilio AMD** in front — **answering-machine detection is the AI screen leg's job.** The LiveKit-Agent / Retell screener classifies the first **~2–4 s** of answered audio (STT + greeting/beep heuristics: machine-style greeting, beep tone, long unbroken utterance) as **human vs machine**.

- **Latency:** AMD adds ~2–4 s before a confident human classification. Budget it, and note the tension with the TSR **2-second live-rep** window: **AMD must not be the reason a *human* waits >2 s for a live rep.** Bias the classifier toward "human" on ambiguity (never hold a real human while deciding), and only *withhold* the agent transfer when machine is confidently detected.
- **On machine detected:** the screener sets the call's resolution to **`voicemail`** → `dialer_status = 'Voicemail'` (via the write path, §5), optionally drops the configured voicemail/safe-harbor message, and **never reserves an agent** (no warm transfer for a machine). This keeps machine answers out of both the agent pool and the abandonment denominator.
- **On human detected:** proceed to screen → qualify → reserve an agent as normal.

### 4.6 Personal / agent-owned callbacks (return to the SAME agent)

A **`Callback → datetime`** disposition is a promise from a specific agent to a specific prospect and should return to **that agent.** New column **`retell_call_queue.callback_owner_agent_id → dialer_agents`** (also mirrored on the `call_assignments` that created it). `apply_disposition(...)` sets it to the dispositioning agent whenever `resolution='callback'`.

**Routing rule when a callback fires** (the scheduler callback fast-path already selects it by `dialer_status='Callback_Scheduled'` AND `callback_scheduled_at<=now()` — §5, §7): the AI screens as usual, and the **warm transfer targets the owner**:
- If `callback_owner_agent_id` is **Ready**, reserve the owner preferentially (skip longest-idle routing for this call).
- If the owner is not Ready within a grace window (config: e.g. 60–120 s), fall back per a per-campaign toggle: **strict-owner** (re-schedule/hold for the owner) **or** **best-effort** (offer to any Ready agent in the segment/skill). Default: best-effort with an owner-preferred first attempt.

### 4.7 Auto-wrap flow (dual-signal, idempotent)

Wrap is **server-authoritative** and triggered by **either** signal, whichever lands first: (a) the telephony **bridge-teardown** event, or (b) the client **`pc.close`** / connection-lost. Both flip the agent to `wrap_up` and open a `wrap_session` with a server-side `wrap_deadline` read from `agency_settings` (per-campaign override on `campaigns`). **The only normal re-arm to Ready is submitting a disposition** through `apply_disposition(...)` against the per-vertical set snapshotted at call start. Max-wrap timeout auto-stamps a `Not_Dispositioned` outcome and re-arms per config. Everything is **idempotent, keyed on `current_assignment_id` / `wrap_session.id`** — duplicate/late telephony events for a closed call are ignored.

### 4.8 Edge cases (all handled by design)

- **Auto-answer black-hole (answer-confirmation):** with auto-answer, the endpoint answers even if the agent stepped away — a naive ring-timeout can never fire, so a live warm human would be bridged to silence. **Fix:** after bridge, monitor the **agent leg for audio energy / an explicit answer gesture within N seconds** (e.g. 3–5 s). No agent audio → **treat as missed**, requeue the caller to the next Ready agent (or back to AI hold), and force the agent to **Paused(Missed)**. This is mandatory whenever auto-answer is enabled.
- **Missed/declined warm transfer:** reservation TTL (8–12s) expires → re-offer to next Ready agent or return to AI hold; policy toggle auto-Not-Readies the agent (Paused(Missed)).
- **Agent WebRTC drop mid-call:** prospect stays bridged to hold/AI during a short reconnect window; reconnect → re-attach, fail → Wrap with "Dropped." Distinguish agent-side drop from prospect hangup for accurate reporting.
- **Prospect abandons at transfer ("ghost"):** no full wrap (or a brief auto-dispositioned wrap for accounting); counts as **abandoned-at-transfer**, a key input to the ≤3% governor.
- **Pause/Logout/force clicked while On-Call:** accepted but **deferred** (`pending_pause`/`pending_logout`/`pending_force`); applied after disposition. Force-hangup is a separate explicit teardown.
- **Supervisor force-ready:** **disallowed** (§4.3) — not an edge case, a removed capability.
- **Double-reservation race:** prevented by **atomic CAS `ready→reserved`**; the loser re-picks another agent.
- **Wrap never completed (agent walks away):** max-wrap deadline auto-stamps `Not_Dispositioned` and re-arms; no silently-held slot.
- **Duplicate/late hangup + duplicate disposition submit:** wrap keyed on `current_assignment_id`, re-arm keyed on `wrap_session.id` — both idempotent.
- **Heartbeat lost while Ready/Paused (laptop sleep, network death):** after grace, server evicts to Logged_out and removes from pool so the dialer never bridges to a dead endpoint.
- **Mic revoked mid-session:** registration invalidated → forced to Paused/Logged_out with a fix-your-mic prompt; can't go Ready without a working input device.
- **Stale reservation (lost "answered" event):** reservation TTL still fires and frees the agent — a missing bridge event can't wedge them in Reserved.
- **Mark-DNC during a call:** applies immediately to the lead (suppression + `dialer_status='DNC'`) but does NOT change presence; the call still ends into normal Wrap.
- **Config/disposition set changes mid-shift:** in-flight wrap uses the set **snapshotted at call start** so buttons don't shift under the agent.

---

## 5. Configurable dispositions + custom fields (per vertical)

Ownership split is the core idea: **`dialer_status` is the fixed engine FSM (control plane); `disposition` is operator-configurable (business plane).** The scheduler's partial index (`dialer_status='Pending'`) and `is_lead_callable()`'s fail-safe are hardwired to the 13 literal `dialer_status` states — that CHECK stays and is **not** operator-editable. Dispositions become config-driven and each carries a `resolution` that deterministically maps into one of those fixed states. Result: unlimited operator-custom outcome buttons, the engine only ever sees states it understands, fully backward compatible, fail-safe preserved.

**`apply_disposition` is the SINGLE writer that keeps the legacy and new columns coherent.** This is critical: the live scheduler still reads the **legacy `disposition` text column** in three places — `countInProgressCallbacks` (keys on `disposition='Callback'`), `getTier` (holds `disposition='Callback'` leads on the conservative cadence), and the callback fast-path's accounting. So `apply_disposition` must **write BOTH** the legacy `disposition` text **and** the new `disposition_id`/`disposition_code`, deriving the legacy text from the `resolution` (below), until every legacy reader is migrated off the text column. No other code path writes `disposition`.

### 5.1 Disposition data model

**`disposition_sets`** — a reusable named group of outcome buttons; one active set per segment (partial unique index), a campaign points at one.
`id, name, segment (NULL=global), is_default, is_active, created_at, updated_at`

**`dispositions`** — the operator-defined outcome buttons.
`id, set_id FK→disposition_sets ON DELETE CASCADE, code (stable machine code), label (agent-facing), sort_order, hotkey, color,`
`resolution CHECK IN ('sold','completed','not_qualified','dnc','callback','retry','voicemail','transfer'),`
`maps_to_dialer_status (nullable override, CHECKed to the 13 queue states),`
`is_terminal, marks_sold, sets_dnc, schedules_callback, recycle, recycle_cooldown_hours,`
`counts_as_attempt, resets_retry_count, required_notes, required_field_keys text[], is_active` · `unique(set_id, code)`

**Resolution → `dialer_status` mapping** (deterministic, override via `maps_to_dialer_status`):
`sold/completed → Completed · not_qualified → Removed · dnc → DNC · callback → Callback_Scheduled · retry → Pending · voicemail → Voicemail · transfer → Transferred`.

**Resolution → legacy `disposition` text mapping** (derived by `apply_disposition`; keeps the legacy readers working — this column's CHECK is `'Transferred','Callback','DNC','Not_Qualified','Completed','Voicemail','No_Answer','Hung_Up'`):
`sold → Completed · completed → Completed · not_qualified → Not_Qualified · dnc → DNC · callback → Callback · retry → No_Answer · voicemail → Voicemail · transfer → Transferred`.
The `callback → Callback` row is load-bearing for `getTier` + `countInProgressCallbacks`; do not drop it.

**Write-back is one transactional RPC** — `apply_disposition(queue_id, provider_call_id, disposition_id, agent_id, notes, field_values jsonb, callback_at)`:
1. **Gates** on `required_notes` + `required_field_keys` (blocks agent re-arm if unmet); re-runs `resolveField` on every supplied value.
2. Resolves `dialer_status = coalesce(maps_to_dialer_status, map(resolution))`.
3. **Writes BOTH disposition columns coherently:** sets `disposition_id`, `disposition_code`, `disposition_set_id`, **and** the derived legacy `disposition` text (table above) on `retell_call_queue`; updates retry accounting.
4. **Callback resolution — sets the columns the scheduler's fast-path actually reads:** when `resolution='callback'`, set **`callback_scheduled_at = callback_at`** and **`callback_confirmed = false`** (NOT just `next_attempt_at`), set `dialer_status='Callback_Scheduled'`, write legacy `disposition='Callback'`, and set **`callback_owner_agent_id = agent_id`** (§4.6). *(The scheduler's callback fast-path selects on `dialer_status='Callback_Scheduled'` AND `callback_scheduled_at<=now()`; a callback that only touched `next_attempt_at` would never be re-dialed.)*
5. **Merges custom-field values into `lead_context`.**
6. Inserts `dnc_list` on `sets_dnc`.
7. Stamps `retell_call_log` with `disposition_code/disposition_id/agent_id/agent_notes/custom_field_snapshot` (PII-scrubbed per §5.3).
8. **Maintains per-agent counters** (`agent_sessions.calls_handled`, `talk_seconds`) transactionally, or leaves them derived from `call_assignments` in a view — see §7.4.

The engine reads only `dialer_status` (plus the legacy `disposition` text noted above), so the scheduler's hot path needs **no rewrite** — but see §5.4 / §7.3 for the **one** deliberate change to `is_lead_callable` (campaign-aware calling window + recording-consent gate).

### 5.2 Custom-field data model

**`custom_field_definitions`** — operator-defined per-vertical lead fields.
`id, segment, campaign_id, key (snake_case lead_context JSONB key), label,`
`field_type CHECK IN ('text','number','currency','date','datetime','boolean','select','multiselect','phone','email'),`
`options jsonb [{value,label}], required, validation jsonb {min,max,minLength,maxLength,regex}, default_value, placeholder, help_text, pii boolean default false,`
`where-shown flags: import_mappable / agent_pop_visible / agent_editable / reportable, sort_order, is_active`

**Scoping — one axis, unambiguous (fixes the earlier `segment OR campaign_id` ambiguity):**
- A definition is **global** (both null), **segment-scoped**, or **campaign-scoped** — **never both** at once:
  `CHECK (num_nonnulls(segment, campaign_id) <= 1)`
- Uniqueness across all three scopes via a **partial-unique index on the coalesced tuple**:
  `create unique index ux_cfd_scope_key on custom_field_definitions (coalesce(segment,''), coalesce(campaign_id::text,''), key) where is_active;`
- **Resolution precedence** for a given `key`: campaign-scoped def **overrides** segment-scoped **overrides** global.
- **Recommended default:** use the **`segment` axis** for almost everything (matches the vertical model); treat `campaign_id` as an advanced per-campaign override only when a single campaign genuinely needs a different field than its segment.

**Values live in `retell_call_queue.lead_context` JSONB keyed by `key`** — **no separate value table** (matches the existing "any other column → `lead_context.<name>`" import model). A **GIN index** on `lead_context`; values **snapshotted** into `retell_call_log.custom_field_snapshot` at wrap. Reportable fields query `lead_context->>'key'` with **lazily-created expression indexes**.

**One shared `resolveField(def, raw)` validator** runs in all three write paths so validation can never diverge:

| Where it renders | Reads | Behavior |
|---|---|---|
| **CSV/XLSX import** | `import_mappable` defs | column-mapping step maps by header, `resolveField` validates + coerces per `field_type`/`validation`, invalid → rejected-rows report. |
| **Agent pop** | `agent_pop_visible` defs | rendered typed by `field_type`, **read-only unless `agent_editable`**, ordered by `sort_order`, **PII masked per §5.3**. |
| **Disposition required-field gate** | `agent_editable` + a disposition's `required_field_keys` | conditional sub-form; `apply_disposition` re-runs `resolveField` and blocks submit until valid. |

### 5.3 PII lifecycle for `pii:true` custom fields (masking · access-scope · retention)

A custom field marked **`pii:true`** (SSN, DOB, income, health/financial details, etc.) is governed across **all three surfaces** it can reach:

1. **Agent pop:** rendered **masked by default** (e.g. `•••• 1234`) via a `PhiMaskedField`-style component; unmasking is a per-field, role-gated, **audit-logged** action (reveal event → `audit_log`). Fields the agent doesn't need to *see* to close can be `agent_pop_visible=false`.
2. **`retell_call_log.custom_field_snapshot`:** the snapshot **excludes or tokenizes** `pii:true` values by default. If a PII value must be retained for the record, store it in an **access-scoped, separately-RLS'd** column/table (admin-read, service-write), never in the general snapshot that supervisors browse. Prefer storing a reference/last-4 in the snapshot.
3. **`/reports`:** `pii:true` fields are **excluded from aggregates, row exports, and CSV downloads** unless the requester is admin **and** the export is audit-logged. No PII in funnel/scorecard views.
4. **Retention:** a **retention window** per PII field (or global default) with a **scheduled purge job** (§7.4) that nulls/tokenizes expired PII in `lead_context` and any scoped PII store, and purges recordings past their window. Consent-capture artifacts follow their own (longer) legal-hold window.

RLS backs all of this (§6): PII columns/tables carry stricter policies than the row they belong to.

### 5.4 Tables touched

- New: `disposition_sets`, `dispositions`, `custom_field_definitions`.
- `retell_call_queue`: **keep** legacy `disposition` text (now written by `apply_disposition`, §5); **add** `disposition_id`, `disposition_code`, `disposition_set_id`, `callback_owner_agent_id`; GIN index on `lead_context`. `callback_scheduled_at` / `callback_confirmed` (existing columns) are set by `apply_disposition` for callbacks (§5.1 step 4).
- `retell_call_log`: **add** `disposition_code`, `disposition_id`, `disposition_set_id`, `agent_id`, `agent_notes`, `custom_field_snapshot` (PII-scrubbed).
- **`is_lead_callable`**: replaced by a **campaign-aware** version with a **recording-consent gate** (§7.3) — this is an acknowledged migration, not "no change."

---

## 6. Page map + RBAC

Three roles via Supabase Auth, **retiring the single shared-password `gate.ts`**. `dialer_agents.auth_user_id → auth.users`; a custom-claims auth hook copies `dialer_agents.role` into the JWT so both the app (`requireRole()`, successor to `requireAdmin`/`requireTab`) and Postgres RLS can read it from `auth.jwt()->>'role'`. Helper SQL: `current_agent_id()`, `current_role()`, `agent_owns_assignment(id)`.

**JWT staleness — the role claim is a coarse gate, not live authority (fix).** A JWT is a *snapshot*; a demoted or disabled agent still holds a valid token until it expires. So:
- **Short access-token TTL** (e.g. 5–15 min) so a role/status change propagates quickly.
- **Force-logout = server-side session revocation**, not "wait for the claim to expire": revoke the refresh token (Supabase Auth admin `signOut` / delete session) **and** delete/flag the `agent_sessions` row + set `dialer_agents.is_active=false`. The next request/refresh fails.
- **Live authority is the DB, not the JWT.** `/monitor` and the **pacing loop** decide "who is Ready / eligible" from **`agent_sessions.state` + `dialer_agents.is_active`** (read server-side), never from a possibly-stale JWT claim. The JWT role only gates route access and RLS shape.

| Route | Min role | What it is |
|---|---|---|
| **/login** | public | Supabase Auth email+password. On success reads `dialer_agents.role` → redirect agent→/agent, supervisor→/monitor, admin→/dialer. |
| **/agent** | agent (sup/admin read-only shadow) | **The agent desktop** (§4). LiveKit JS softphone receiving warm transfers; pop + ring + Notification; screen-pop from `retell_call_queue` + `lead_context` **through** `custom_field_definitions` (PII masked); mute/hold/hangup/transfer/DTMF; state-machine toggle; blocking wrap→disposition. Realtime-subscribed to its **own** `agent_sessions` row + `call_assignments` (private channel, §8). |
| **/monitor** | supervisor, admin | **Live monitoring.** Agents board (`agent_sessions` presence + timers — **authoritative, not JWT**), live calls (`call_assignments` in screening/offering/reserved/connected joined to lead), supervisor **LISTEN/WHISPER/BARGE** (LiveKit subscribe / agent-only publish / all-publish — logged to `audit_log`), and the **live abandonment-rate tile** (rolling 30-min abandoned÷answered — the ≤3% safe-harbor gauge). |
| **/dialer** | admin (sup read-only) | **Queue & pacing** — extends the existing `DialerControls`. Per-campaign master on/off, `dial_mode` (preview\|power\|progressive\|predictive), `dial_ratio` (power/progressive only), `max_concurrent`, daily/monthly caps, and the **predictive controller's** target-abandonment + live throttle status (§9). Writes `agency_settings` (global) **and** `campaigns` (per-campaign). |
| **/leads** | supervisor, admin (agents get NO bulk access) | **CRM lead hub.** Server-paginated, filterable table of ALL `retell_call_queue` (campaign, list, dialer_status, segment, disposition, consent, DNC, free-text on name/phone/lead_context). Row drawer = full lead + custom fields (PII masked) + call history (`retell_call_log`) + assignment/disposition history (`call_assignments`). **CSV/XLSX import wizard** per `docs/LEAD-IMPORT-format.md`: upload → auto column-map → validate + E.164 normalize + dedup + DNC/litigator scrub report → **map & retain the written-consent artifact** → confirm into a list/campaign. **Consent gate: a row is `consent_verified=true` only with a mapped PEWC artifact (§2.2).** Writes `lead_import_batches` + `retell_call_queue`; rejected-rows download. |
| **/campaigns** | admin | **Campaigns/config.** Campaign CRUD; **disposition-sets editor** (§5); **custom-field-definitions editor** (§5, incl. `pii` + scope); **calling window** (per-campaign, feeds `is_lead_callable`, §7.3); **recording-consent policy** (per-campaign two-party-consent enforcement, §7.3); **caller-ID/DID pool** (`did_pool`: numbers, STIR/SHAKEN attestation, spam/reputation, rotation). |
| **/reports** | supervisor, admin | **Reporting.** Funnel dials→answers→AI-passed→connected→dispositioned→SOLD (`vw_campaign_funnel`), per-agent scorecards (handled, talk, avg wrap, close rate — from `call_assignments`/counters, §7.4), **abandonment report (≤3% evidence, per campaign per 30 days)**, spend rollups (existing `get_retell_spend_today/month`). **No `pii:true` fields (§5.3).** |
| **/settings** | admin | Global `agency_settings`, DNC management (`dnc_list` incl. litigator scope), user/agent roster (`dialer_agents` role assignment + `is_active`), PII **retention windows**, `audit_log` viewer. |
| **/api/\*** + server actions | per action | Every mutating action wraps `requireRole(min)` **and** re-checks live `dialer_agents.is_active` server-side; realtime channels are authorized per §8 (private-channel RLS for broadcast/presence; app-table RLS for postgres_changes). |

**RBAC matrix (min role):**
- **agent:** `/agent` only. READ own `agent_sessions`, own `call_assignments` (+joined lead, PII masked), read-only config for rendering. WRITE own `agent_sessions.state` (via `set_agent_state` RPC) and own dispositions (via `apply_disposition`). No bulk leads, no other agents' calls, no config.
- **supervisor:** agent's view PLUS read-all `agent_sessions`/`call_assignments`/`retell_call_queue`/`retell_call_log`/`vw_campaign_funnel` (PII masked). Access `/monitor` (listen/whisper/barge, audit-logged), `/leads`, `/reports`. No config writes. **No force-ready (§4.3).**
- **admin:** full CRUD on campaigns, disposition sets/dispositions, custom fields, `did_pool`, `dialer_agents` roles/active, `agency_settings`, `dnc_list`, PII retention; sees `audit_log` + can PII-reveal (audit-logged). Superset of supervisor.
- **service_role:** backend orchestrator, scheduler, predictive controller, Retell/LiveKit webhooks — bypasses RLS (matches existing `0006`). Owns inserts into queue/log/assignments, pacing writes, and **broadcast sends on private channels** (§8).

**RLS approach** (extends `0006`, which today gives service_role ALL + a blanket authenticated read):
- Keep `*_service_all` on every table.
- **Replace** blanket authenticated-read with role-scoped policies: agent policies `USING (agent_id = current_agent_id())` on `agent_sessions`/`call_assignments` (+ join-existence for the active queue row); supervisor/admin `USING (current_role() IN ('supervisor','admin'))`; writes split by role with `WITH CHECK`.
- **PII:** `pii:true`-bearing columns/scoped-PII tables carry stricter policies (admin-only reveal; masked projections for supervisor).
- Config tables (`campaigns`, `dispositions`, `disposition_sets`, `custom_field_definitions`, `did_pool`): SELECT to authenticated (agents render them), write to admin only.
- `dnc_list`: service_role + admin write; supervisor/admin read.
- `audit_log`: INSERT via service_role/definer functions only; SELECT admin only; **no UPDATE/DELETE** (append-only).
- `lead_import_batches`/`lead_lists`: supervisor+admin.

**Realtime authorization — two different mechanisms (fixes the §6↔§8 contradiction):**
- **Postgres-changes** (durable rows: call-log, disposition writes, config) **are** gated by the **app-table RLS** above — an agent's `postgres_changes` subscription only yields rows its policies allow.
- **Broadcast & Presence** (the call-pop, agent-state fan-out) are **NOT** gated by app-table RLS. Supabase Broadcast is authorized by **RLS policies on `realtime.messages`** with **PRIVATE channels**. See §8 for the exact policy. **Do not claim app-table RLS secures the call-pop broadcast — it does not.**

---

## 7. Consolidated Supabase schema (extending existing tables)

### 7.1 Existing tables — extend

- **`retell_call_queue` (extend).** Add `campaign_id → campaigns`, `list_id → lead_lists`, `import_batch_id → lead_import_batches`, `assigned_agent_id → dialer_agents` (replaces free-text `assigned_agent`), `disposition_id → dispositions`, `disposition_code`, `disposition_set_id`, `callback_owner_agent_id → dialer_agents`. Keep legacy `disposition` text (written by `apply_disposition`, §5). Custom fields stay in `lead_context`, now **described** by `custom_field_definitions`. Indexes: `idx_rcq_campaign(campaign_id, dialer_status)`, GIN on `lead_context`. **`dialer_status` and its 13-state CHECK are unchanged.** Existing `callback_scheduled_at` / `callback_confirmed` are written by `apply_disposition` for callbacks (§5.1 step 4).
- **`retell_call_log` (extend).** Add `campaign_id`, `assignment_id → call_assignments`, `disposition_id`, `disposition_code`, `disposition_set_id`, `agent_id`, `agent_notes`, `custom_field_snapshot jsonb` (PII-scrubbed). Stays the immutable per-attempt record powering funnel + spend RPCs.
- **`agency_settings` (unchanged shape).** Global effective-dated K/V for the master toggle + global caps + `wrap_deadline` + the global calling window (`retell_hours_start`/`retell_hours_end`). Per-campaign pacing/window now lives on `campaigns`; `agency_settings` remains the **global fallback** `is_lead_callable` reads (§7.3).
- **`dnc_list` (extend from `0007`).** Add `scope CHECK IN ('internal','national','litigator') default 'internal'`, `added_by → dialer_agents`, `source`, `notes`. Keep `phone_e164` unique. Scrubbed at import AND at dial via `is_lead_callable`.

### 7.2 New tables

- **`dialer_agents`** — the roster + auth/role source. `id, auth_user_id unique → auth.users, email unique, display_name, phone_e164 (PSTN fallback DID), role CHECK ('agent','supervisor','admin') default 'agent', skills text[] (segments the agent can close — feeds skills-based routing), max_concurrent int default 1, is_active, created/updated_at`.
- **`agent_sessions`** — presence + the state machine (the **ONE authoritative table for agent state**, §4.2). `id, agent_id → dialer_agents, state CHECK ('offline','registering','ready','paused','reserved','on_call','wrap_up') default 'offline', pause_reason, current_assignment_id → call_assignments, livekit_identity, livekit_room, state_changed_at, last_ready_at, last_heartbeat_at, login_at, logout_at, calls_handled int default 0, talk_seconds int default 0, created/updated_at`. **Partial unique index: one non-offline session per agent.** In the realtime publication; the ready-agent count the pacing loop reads. **`calls_handled`/`talk_seconds` are maintained in `apply_disposition`/`set_agent_state` transactionally, or treated as a cache of `vw_agent_shift_stats` (§7.4) — never hand-edited.**
- **`call_assignments`** — the screen-leg ↔ agent-leg link and the **call-lifecycle authority**; one row per AI-screened call that reaches (or should reach) a human. `id, queue_id → retell_call_queue, call_log_id → retell_call_log, campaign_id → campaigns, agent_id → dialer_agents (null until routed), callback_owner_agent_id → dialer_agents (null unless owner-callback), screen_provider_call_id (AI/Retell leg), agent_leg_call_id (agent WebRTC/SIP leg), livekit_room, state CHECK ('screening','offering','reserved','connected','wrap_up','completed','abandoned','missed','failed') default 'screening', offered_at, accepted_at, connected_at, ended_at, wrap_started_at, disposition_id → dispositions, dispositioned_at, disposition_notes, talk_seconds, wrap_seconds, abandoned bool default false (feeds the ≤3% governor), safe_harbor_message_played bool default false, recording_url, created/updated_at`. Realtime-published; drives pop, monitor, funnel, abandonment, wrap gate. **Updated in the SAME transaction as `agent_sessions` on every transition (§4.2).**
- **`campaigns`** — per-vertical pacing + compliance + routing. `id, name, segment (the vertical), is_active default false, dial_mode CHECK ('preview','power','progressive','predictive') default 'preview', dial_ratio numeric default 1.0, max_concurrent, disposition_set_id → disposition_sets, calling_window jsonb (start/end/days/tz — read by is_lead_callable, §7.3), daily_cap_usd, monthly_cap_usd, caller_id_strategy CHECK ('fixed','local_presence','rotate') default 'fixed', default_from_number, abandon_rate_target numeric default 0.03, recording_consent_mode CHECK ('one_party','two_party','off') default 'two_party', callback_owner_policy CHECK ('best_effort','strict_owner') default 'best_effort', created/updated_at`.
- **`lead_lists`** — named cohort inside a campaign. `id, campaign_id → campaigns, name, source, import_batch_id → lead_import_batches, is_active, created_at`.
- **`lead_import_batches`** — CSV/XLSX import provenance + **consent-artifact mapping**. `id, list_id → lead_lists, campaign_id → campaigns, filename, uploaded_by → dialer_agents, column_mapping jsonb, consent_mapping jsonb (source/timestamp/text columns for PEWC), rows_total/rows_accepted/rows_rejected/rows_deduped/rows_dnc_suppressed/rows_no_consent int, rejected_file_url, status CHECK ('mapping','validating','importing','completed','failed'), created_at, completed_at`.
- **`disposition_sets`**, **`dispositions`** — §5.1.
- **`custom_field_definitions`** — §5.2 (with the `num_nonnulls` CHECK + partial-unique index).
- **`did_pool`** — caller-ID/DID pool for local presence + STIR/SHAKEN + spam-flag monitoring. `id, phone_e164 unique, campaign_id → campaigns (null), area_code, state, attestation CHECK ('A','B','C'), reputation_status CHECK ('good','flagged','blocked') default 'good', last_checked_at, daily_call_count int default 0, is_active, created_at`. **`daily_call_count` is reset by a daily cron (§7.4).**
- **`audit_log`** — INSERT-only, admin-read. `id, actor_agent_id → dialer_agents (null=system), actor_role, action, entity_type, entity_id, before jsonb, after jsonb, ip_addr, user_agent, created_at`. Indexes `(entity_type, entity_id)`, `(created_at desc)`. Captures config changes, disposition edits, DNC adds, spend-cap overrides, barge events, **PII reveals/exports**, **force-pause/force-logout**.
- **`call_quality`** (companion) — per-call rolling MOS/RTT/jitter/loss series keyed by call + agent (§3.4).

### 7.3 View + RPCs

- **`vw_campaign_funnel` (view)** — per campaign/day: dials (`retell_call_log`), answers, AI-passed (`call_assignments` reaching offering/reserved), agent-connected (`state='connected'`), dispositioned, sold (`dispositions.resolution='sold'`), **abandoned (incl. `safe_harbor_message_played`)**, abandonment_rate (per-campaign, 30-day window for the ≤3% evidence). Powers `/reports` + the `/monitor` tile.
- **`vw_agent_shift_stats` (view)** — per agent per shift: `count(*)` handled, `sum(talk_seconds)`, `avg(wrap_seconds)`, close rate — the source of truth for `/reports` scorecards and (optionally) the `agent_sessions` counter cache (§7.4).
- **`is_lead_callable` — replaced with a CAMPAIGN-AWARE version (acknowledged migration; the earlier "no change" claim is wrong).** It keeps every existing gate (status, consent, per-lead caps, cooldown, DNC) and changes the **calling-window** source to: **the lead's campaign `calling_window` (via `campaign_id → campaigns.calling_window`) when present, else the global `agency_settings` window** (`retell_hours_start`/`retell_hours_end`). Still **fail-safe** (any error → false → nothing dials). The scheduler's application-level per-lead lead-local 09:00–20:00 clamp stays as defense-in-depth.
- **Recording-consent enforcement at the dial decision (fix, not just an open decision):** for a lead in a two-party-consent state, `is_lead_callable` + the campaign `recording_consent_mode` require that the campaign is configured to announce/obtain recording consent on the leg; a two-party lead under a campaign not so configured is **gated at the dial decision** (returns not-callable), rather than dialed and documented later. Where the lead's state is resolved (a `two_party_consent_states` reference or the lead's `state`/`did_pool.state`) is a config input, not a code constant.
- **Existing RPCs kept:** `get_retell_spend_today`, `get_retell_spend_month`.
- **New RPCs:** `set_agent_state(agent_id, to_state, assignment_id, ...)` (the single transactional presence+assignment transition, §4.2), `apply_disposition(...)` (§5.1, the single disposition writer), `get_ready_agent_count(campaign_id)` (from `agent_sessions.state='ready'` ∩ skills — authoritative, not JWT), `get_live_abandon_rate(campaign_id, window)` (governor + monitor tile), `reset_did_daily_counts()` (§7.4), plus the existing `reset_daily_attempt_counts` / `reset_monthly_attempt_counts`.

### 7.4 Counter-reset & maintenance jobs (fix)

- **`did_pool.daily_call_count`** — reset to 0 by a **daily cron at ET midnight** via `reset_did_daily_counts()` (mirror the existing `reset_daily_attempt_counts` rollover the scheduler already runs). Incremented on each dial that uses the DID.
- **`agent_sessions.calls_handled` / `talk_seconds`** — **maintained inside `apply_disposition` / `set_agent_state`** (increment on wrap-submit and On_Call→Wrap transitions), **or** derived from `call_assignments` via **`vw_agent_shift_stats`**. **Recommended:** `call_assignments` is the source of truth; the `agent_sessions` columns are a per-shift cache reset at login/shift boundary. Do not double-count (transfers split talk-time by participant interval, §4.4).
- **PII retention purge** — scheduled job per §5.3 (null/tokenize expired PII in `lead_context` + scoped PII store; purge recordings past window). Consent artifacts on a separate legal-hold window.

### 7.5 FK relationship map

```
auth.users 1—1 dialer_agents
dialer_agents 1—* agent_sessions (one non-offline at a time; AUTHORITATIVE agent state)
              1—* call_assignments (agent_id, callback_owner_agent_id)
              1—* lead_import_batches (uploaded_by)
campaigns 1—* lead_lists 1—* retell_call_queue
campaigns 1—* {retell_call_queue, retell_call_log, call_assignments, did_pool}
campaigns *—1 disposition_sets   ·   campaigns.calling_window read by is_lead_callable
disposition_sets 1—* dispositions
dispositions 1—* {call_assignments.disposition_id, retell_call_queue.disposition_id, retell_call_log.disposition_id}
retell_call_queue 1—* retell_call_log (queue_id)   1—* call_assignments (queue_id)
call_assignments 1—1 retell_call_log (call_log_id)  *—1 agent_sessions.current_assignment_id
custom_field_definitions scoped by (segment XOR campaign_id XOR global) — num_nonnulls CHECK
lead_import_batches 1—1 lead_lists  +  stamps lead_context.import_batch_id + consent artifact per queue row
dnc_list keyed by phone_e164 (no FK — checked in is_lead_callable + at import scrub)
audit_log → dialer_agents (actor, loose) + polymorphic (entity_type, entity_id)
vw_campaign_funnel = retell_call_log × call_assignments × dispositions × campaigns
vw_agent_shift_stats = call_assignments grouped by agent × shift
```

### 7.6 Migration sequencing

`0008` dialer_agents + auth-claims hook + short-TTL/session-revocation config · `0009` campaigns/lead_lists/lead_import_batches (incl. recording_consent_mode, callback_owner_policy, consent_mapping) · `0010` disposition_sets/dispositions · `0011` custom_field_definitions (num_nonnulls CHECK + partial-unique index) · `0012` agent_sessions (7-literal state CHECK) · `0013` call_assignments · `0014` did_pool + dnc_list extend · `0015` retell_call_queue/retell_call_log FK columns (+ callback_owner_agent_id) + `apply_disposition` (dual-writer, callback columns) + `set_agent_state` + `get_ready_agent_count` + `get_live_abandon_rate` · `0016` **campaign-aware `is_lead_callable` (replaces `0007`'s version) + recording-consent gate** · `0017` audit_log + call_quality + `reset_did_daily_counts` + PII-purge job · `0018` RLS role policies (replacing `0006` authenticated-read) + **`realtime.messages` broadcast/presence policies (§8)** + postgres_changes publication · `0019` vw_campaign_funnel + vw_agent_shift_stats.
**Note:** V3 also **applies `0007`** (consent default false + consent-gated index) as a hard prerequisite — PEWC is not optional here (§2.2).

---

## 8. Notifications & the realtime plane

Fire **all four** on the agent's **private** broadcast `incoming_call` event, which carries the **full lead payload** (PII masked) so the pop renders instantly with zero extra fetch (no round-trip between ring and render):

1. **Visual pop** — modal/toast from the payload: `contact_name`, phone, segment/vertical, consent status, and the vertical's custom fields (rendered from the field schema — same schema the import + reports use), **PII masked (§5.3)**. Accept/Reject + call controls.
2. **Ring sound** — loop a preloaded `<audio>` (short Opus/mp3, preloaded at Go-Ready). **Autoplay is blocked without a prior gesture**, so **unlock the audio context on the "Go Ready" click** (play+immediately pause a silent buffer) — that gesture licenses later programmatic ring. Per-agent volume + mute-ring toggle. Stop on accept/reject/timeout.
3. **Browser notification** — Notification API, **permission requested at Go-Ready** (not page load), so an agent in another tab still gets pulled in ("Incoming call — {name}, {segment}"), with a focus-tab action. Gate on `Notification.permission === 'granted'`; degrade gracefully if denied.
4. **Tab-title flash** — `setInterval` toggling `document.title` between "☎ INCOMING CALL" and the normal title (~800ms) while ringing; clear on accept/reject/timeout. Pair with a favicon swap. Cheapest, most reliable attention-grabber when backgrounded.

**Auto-timeout** (15–20s no-answer): stops ring/flash, fires a `missed/requeue` event so the pacing engine re-routes the parked caller to the next Ready agent, and flips the agent's state (optionally to Paused(Missed)) so a walked-away agent doesn't blackhole live callers. **With auto-answer enabled, the answer-confirmation check (§4.5/§4.8) is the equivalent guard.** All of this is **client reaction to a broadcast event**; state authority stays on the server (`agent_sessions`).

### 8.1 Realtime plane (Plane 2) — start on Supabase Realtime, three modes, **with the correct authorization for each**

- **Broadcast** channels for the **call-pop** and agent-state changes — pub/sub, no DB transaction in the path, lands in tens of ms. `agent:{id}` for the pop, `queue:{segment}` for team events. Do NOT drive the pop off a Postgres INSERT→replication event.
- **Presence** channels for who's-online / Ready-Paused-Reserved-InCall-Wrap rosters the monitor + pacing engine read.
- **Postgres changes** only for durable things where a small delay is fine (call-log rows in reporting, disposition writes, config updates).

**Authorization — this is the security-critical part (fixes the earlier "Realtime honors RLS" over-claim):**
- **Supabase Broadcast/Presence is NOT gated by your app-table RLS.** A malicious authenticated client could otherwise subscribe to another agent's `agent:{id}` topic and receive that agent's call-pop (with lead PII). You must use **PRIVATE channels** (client connects with `{ config: { private: true } }`) and write **RLS policies on the `realtime.messages` table** that authorize by the agent's identity vs the channel topic. Sketch:
  ```sql
  -- SELECT (receive): an agent may read messages only on its own private topic;
  -- supervisors/admins may read the team firehose.
  create policy agent_reads_own_topic on realtime.messages
    for select to authenticated
    using (
      realtime.topic() = 'agent:' || public.current_agent_id()::text
      or (public.current_role() in ('supervisor','admin')
          and realtime.topic() like 'queue:%')
    );
  -- INSERT (send): only service_role (the orchestrator) broadcasts the call-pop;
  -- clients never publish onto agent:{id}.
  create policy service_sends on realtime.messages
    for insert to service_role with check (true);
  ```
- **Postgres-changes subscriptions** *are* gated by app-table RLS (§6) — an agent's `call_assignments` subscription only yields its own rows. Use this for durable UI (history, config), not the pop.
- **Net:** the call-pop is a **private-channel broadcast authorized by `realtime.messages` RLS**; durable rows are **postgres_changes authorized by app-table RLS**. Two mechanisms, documented, no contradiction with §6.

Keep the state machine **server-authoritative** so a browser crash mid-call auto-times-out of Wrap and the seat isn't lost. **Graduate off Supabase Realtime** (to Phoenix Channels / Go+Redis fan-out) only at thousands of concurrent agents or sub-50ms p99 cross-region SLAs — design the client with a thin realtime-transport abstraction so that swap is contained; **do not pre-build it.**

---

## 9. Predictive pacing & the abandonment governor (its own component — the PRIMARY build risk)

**The formula in earlier drafts — `dial-N = clamp(readyAgents × ratio − inProgress)` — is POWER / ratio dialing, not predictive.** It dials a fixed multiple of ready agents. That is fine for `dial_mode='power'`/`'progressive'`, but calling it "predictive" is wrong and dangerous, because the **≤3% abandonment ceiling is a legal limit (TSR)**, not a tuning preference. The predictive controller is a **distinct service** with real control theory, and it is **the single biggest build risk in V3.**

**True predictive controller (the `/dialer` pacing service):**
1. **Rolling historical answer-rate estimate** — per campaign, per time-of-day/day-of-week, an EWMA (or windowed rate) of `connects / dials` over a trailing window; the probability a placed dial becomes a live human.
2. **Over-dial factor** — dial *ahead* of currently-Ready agents based on (a) predicted answer rate, (b) predicted agent free-time (current On_Call/Wrap durations trending to free), so a human answers roughly when an agent frees — **not** a fixed ratio.
3. **Closed-loop abandonment throttle (PID or equivalent)** — continuously measure **live abandonment = abandoned ÷ answered** over a rolling 30-min window (`get_live_abandon_rate`); drive the over-dial factor **down** as the rate approaches `abandon_rate_target` (default 0.03), with a **hard clamp** so predicted abandonment never exceeds target. When agents are scarce, it throttles toward progressive/1:1.
4. **Safe-harbor abandoned-call message** — when a live human answers and **no agent can take the call within the 2-second TSR window (the AI screen leg does NOT count as the live rep)**, play the **FTC safe-harbor recorded message** (caller identity, purpose, business phone, do-not-call opt-out), mark `safe_harbor_message_played`, and count the call in the abandonment numerator. Abandonment is measured **per campaign over each 30-day period** for the ≤3% evidence (`vw_campaign_funnel`, `/reports`).
5. **Governor is authoritative and fail-safe** — reads `get_ready_agent_count` from **`agent_sessions`** (not JWTs); on any uncertainty it **under-dials**. The `/monitor` ≤3% tile is the live gauge; `/dialer` shows throttle state.

**Why this re-justifies keeping Y/ViciDial as a certified hedge (§2.2):** a correct predictive controller with a defensible safe-harbor accounting is genuinely hard to build and to *prove* to a regulator. ViciDial's abandonment engine is battle-tested and auditable. Keeping it available (headless behind LiveKit SIP) is a real risk reduction if we cannot get our own controller certified/comfortable before scaling dials. **Do not scale predictive pacing without counsel sign-off (§2.2).**

---

## 10. Cost & scale model (needed before Phase 2c / Phase 3 commitments)

**A real number is required before committing to the media/pacing phases.** Fill these with quoted rates and target concurrency; do not commit to LiveKit Cloud vs self-host, or to predictive dial volume, on vibes.

**Per-connected-minute cost (LiveKit Cloud path):**
```
cost_per_min ≈ livekit_participant_min_rate × participants_in_room   (AI leg + agent leg + any supervisor)
             + sip_trunk_per_min                                      (inbound+outbound PSTN)
             + ai_stt_per_min + ai_llm_per_min + ai_tts_per_min       (screen leg only)
             + did/number rental (amortized) + recording egress + object storage
```
**Monthly at target concurrency:**
```
billable_minutes/mo ≈ concurrent_calls × avg_call_min × dials_per_hour_factor × hours/day × days/mo
monthly_media_cost  ≈ billable_minutes/mo × cost_per_min
```
**Self-host breakeven (Phase 5 trigger):**
```
self_host_fixed/mo ≈ SFU instance(s) + coturn instance(s) + bandwidth egress + on-call/ops labor
breakeven when:  monthly_media_cost(Cloud)  >  self_host_fixed/mo + self_host_per_min × billable_minutes/mo
```
**Deliverable before Phase commitments:** a filled table for the operator's real concurrency (e.g. 5 / 20 / 50 concurrent agents) with quoted LiveKit Cloud, SIP, and STT/LLM/TTS rates, showing (a) $/connected-minute, (b) $/booked-appointment or $/sale at expected conversion, and (c) the concurrency at which self-hosting the SFU + coturn pays back. **Note:** predictive over-dialing raises *dialed* minutes faster than *connected* minutes — model the AI-screen-leg cost on **dials**, not connects, since the AI answers many non-transfers.

---

## 11. Phase plan (single-tenant first; a minimal dialer exists WITH/BEFORE the desktop)

**A minimal origination path already exists** — the current `scheduler.js` + Retell screener dials today. V3 keeps that dialing throughout Phases 0–1 so that when the agent desktop appears there are **real screened calls to answer** (you cannot validate a warm transfer with nothing dialing). The overloaded "media" phase is **decomposed into 2a/2b/2c**.

**Phase 0 — Foundations (auth + schema + consent gate).** Migrations `0007`–`0019`. Replace `gate.ts` with Supabase Auth + `dialer_agents` + JWT role claims (short TTL) + `requireRole()` + server-side revocation. RLS role policies + `realtime.messages` broadcast policies + postgres_changes publication. **Apply `0007` (PEWC consent gate ON).** Ships: login, roles, the full data model. No live agent calls yet; the existing scheduler keeps dialing.

**Phase 1 — Config + Lead Hub.** `/campaigns` (campaign CRUD, disposition-sets editor, custom-field-definitions editor incl. PII + scope, per-campaign calling window + recording-consent mode, DID pool) and `/leads` (CRM table + CSV/XLSX import wizard writing `lead_import_batches` + `retell_call_queue`, with E.164/dedup/DNC-litigator scrub **and PEWC consent-artifact mapping**). Operator can now load *callable* leads and define verticals. Existing scheduler still drives outbound; `is_lead_callable` becomes campaign-aware + recording-consent-gated here (migration `0016`).

**Phase 2a — Media plumbing + a single MANUAL click-to-answer call (the media proof).** LiveKit Cloud (region-pinned) + a SIP trunk into LiveKit SIP. Retell stays the AI screen leg, **bridged via SIP** (accept the phase-1 bridge hop). Build the persistent warm WebRTC endpoint, the network-check gate on Go-Ready, and a **single manual "Answer" that swaps ONE screened caller into the agent's room.** No FSM yet — this validates the media path and **empirically measures the §3.2 latency** end-to-end with something actually dialing.

**Phase 2b — FSM + auto-wrap + disposition gate.** The **server-authoritative state machine** (`agent_sessions` + `set_agent_state`, single-transaction transitions), presence over Supabase Realtime (private channels), the pop + ring + Notification, screen-pop from `custom_field_definitions` (PII masked), in-call controls, auto-wrap → **blocking disposition** (`apply_disposition`, dual-writer + callback columns). Enforces "disposition every call."

**Phase 2c — Warm-transfer participant swap.** The true warm transfer: AI screen leg → **in-SFU participant swap** to the agent, answer-confirmation (§4.5), agent-to-agent transfer (§4.4), owner-callback routing (§4.6). **This is the milestone that makes V3 real.** (Gate on the §10 cost model.)

**Phase 3 — Predictive pacing + Monitoring.** The **predictive controller** (§9) as its own service: rolling answer-rate estimate, over-dial factor, abandonment PID against `abandon_rate_target`, safe-harbor message, `get_ready_agent_count` from `agent_sessions`. `/monitor`: live agents board + live calls + LISTEN/WHISPER/BARGE (supervisor joins the LiveKit room) + the live ≤3% abandonment tile. In-call quality telemetry → `call_quality` + per-agent quality badges. **Counsel sign-off before scaling dials (§2.2, §9).**

**Phase 4 — Reporting + hardening.** `/reports` (`vw_campaign_funnel`, per-agent scorecards from `vw_agent_shift_stats`, **≤3% abandonment evidence per campaign per 30 days**, spend), `/settings` (DNC/litigator management, roster + `is_active`, PII retention windows, `audit_log` viewer). Adherence/aux-time reports off Paused reasons. Recording + PII retention purge jobs live (§7.4).

**Phase 5 — Media unification (latency) + optional self-host.** Migrate the AI screen leg from Retell-over-SIP to **LiveKit Agents** so the AI and the agent share one media fabric — removes the bridge hop, targets sub-500ms AI-first-word. Begin self-hosting the SFU + coturn **only when the §10 breakeven says so.**

**Later (not launch):** multi-tenancy; the **ViciDial certified-engine hedge** (headless behind LiveKit SIP) if the abandonment controller can't be proven in-house; dedicated WS fan-out layer if scale demands it.

---

## 12. Open decisions

1. **Auto-answer vs manual-answer** default per campaign — auto-answer gives the lowest latency but **requires the answer-confirmation guard (§4.5/§4.8) to be live** or it black-holes warm callers. Recommend manual-answer default until 2c's answer-confirmation is proven, then auto-answer with a per-agent opt-out.
2. **Missed-call policy** — is `Reserved` no-answer / answer-confirmation-fail auto-Not-Ready (Paused(Missed)) ON by default? Protects screened-human inventory but is stricter on agents. Recommend ON for predictive, configurable per campaign.
3. **Max-wrap timeout behavior** — on timeout, re-arm to **Ready** or **Paused(Timeout)**? Config toggle exists; recommend Paused(Timeout) so a walked-away agent doesn't immediately get re-dialed.
4. **Wrap deadline value** — global default in `agency_settings` + optional per-campaign override on `campaigns`. Recommend a global default + per-campaign override.
5. **Abandoned-at-transfer accounting** — how, exactly, is the ≤3% denominator defined (does a prospect "ghost" pre-answer count as answered? does the AI-screened-but-not-transferred call count?) — **requires counsel sign-off** on the abandonment definition, since it is the legal metric (§2.2, §9).
6. **LiveKit Cloud vs self-host at launch** — recommend Cloud (region-pinned) to cut ops; the switch is **gated on the §10 cost model**, revisit in Phase 5.
7. **Recording consent — script, state list, retention** — `recording_consent_mode` is now a per-campaign, dial-enforced field (§7.3), but the **two-party-consent state list, the recording-consent announcement script, retention window, and storage (LiveKit egress → object storage)** still need a counsel decision before Phase 2c.
8. **STIR/SHAKEN attestation + DID rotation strategy** — A-level attestation via the trunk, and the `did_pool` rotation/reputation-refresh cadence, need an operator + carrier decision.
9. **Callback owner fallback** — `callback_owner_policy` default (`best_effort` vs `strict_owner`) per campaign (§4.6): how long to hold for the owner before offering to the segment.
10. **Skills-based routing granularity** — `dialer_agents.skills` vs campaign `segment`: exact matching rules (one skill = one segment? multi-skill priority?) when multiple agents are Ready — longest-idle within skill is the proposed default.
11. **PII retention windows** — per-field vs global default; legal-hold carve-out for consent artifacts vs shorter window for health/financial PII (§5.3).

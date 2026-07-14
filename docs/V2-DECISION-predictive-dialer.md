# V2 Decision — Predictive Dialer + Human Agents: Buy vs Build

**Question:** how to run a predictive dialer with human agents for insurance, where the
edge is *"a proven agent floor now + an AI-connect differentiator"* (the LLM answers, holds
with a natural greeting so there's no dead-air, detects a live human + right-person, and
passes **only** warm live humans to agents).

**This is a decision doc, not a build plan.** It lays out four paths and the one question
that actually decides between them. *Not legal advice — see the compliance sections.*

---

## TL;DR

The real fork isn't "which dialer" — it's **do you need to OWN a unique AI as your moat, or
just BUY the best turnkey AI dialer running now?**

- **Own the moat →** Hybrid: your custom AI screens and injects warm humans into an **open**
  floor (**ViciDial**). You control and iterate the AI edge. More engineering + ops.
- **Buy the best floor →** **Convoso.** Fastest, best connect rates, AI included (Voso.ai),
  zero ops, partner-friendly — but you *rent* the AI (every competitor can buy it too) and
  can't bolt your own AI in front (closed platform).

Given your "both" answer, the honest recommendation is **start on Convoso to get a proven,
compliant, partner-runnable floor live in weeks** (and get a big chunk of the AI value from
Voso.ai immediately), **while you prototype your own AI-connect layer on the current repo as
the moat** — then decide whether the owned-AI edge beats Voso.ai enough to justify moving the
floor to an open platform (ViciDial hybrid) where you can inject it. You don't have to pick
"own vs buy" on day one; you *do* have to know that Convoso's closedness is what forces the
choice later.

---

## The four paths

1. **Convoso** — proprietary cloud SaaS predictive dialer (DX5 engine). AI-native (Voso.ai
   virtual agent, AI-AMD ~97% claimed), caller-ID reputation management (Ignite), predictive/
   power/preview/progressive, built-in TCPA/abandonment/DNC tooling. ~$90+/seat/mo, custom-
   quoted, real spend higher with telecom/DIDs. Zero ops. **Closed telephony** — open API for
   data/CRM, but no proven path to SIP-inject *your* externally-screened call into its queue.
2. **ViciDial** — open-source (AGPL), Asterisk-based, self-hosted (or managed). Predictive/
   adaptive pacing, WebRTC browser agents (ViciPhone), blended, beep-AMD (70–92%), DNC,
   recording, built-in **3% abandonment safe-harbor** controls. $0 license; heavy ops (Linux/
   Asterisk/DBA) unless managed-hosted (~$15–55/agent/mo). **Open telephony** — you *can* SIP-
   inject your AI-screened calls (this is the hybrid seam). No native AI.
3. **Full custom** — build the predictive dialer + agent softphone + abandonment engine on
   your own stack (Node/Next/Supabase/Twilio/Retell). Own everything, AI-native. 2–4 months to
   parity, and you carry lifetime TSR-compliance liability for unproven pacing code.
4. **Hybrid (your AI + ViciDial floor)** — ViciDial runs the agent floor + ACD + reporting +
   compliance controls; your existing Retell/LLM stack is the screening front-end that injects
   only warm live humans into a ViciDial in-group. Owns the moat, rents the floor.

## Head-to-head

| Dimension | Convoso | ViciDial (self/managed) | Full custom | Hybrid (your AI + ViciDial) |
|---|---|---|---|---|
| **Time to live agents** | Days–2 wks (SaaS signup + config) | 2–4 wks (install + trunks) | 2–4 **months** | ~2–4 wks floor + AI layered after |
| **Who builds it** | Nobody — you configure | Human sysadmin / integrator | Your engineers (cloud-agent-buildable) | Split: sysadmin (floor) + coding agents (AI) |
| **Ops burden** | ~None (vendor-managed) | High (Asterisk/Linux/DB) unless managed | Your stack (no Asterisk) | Both stacks — widest surface |
| **Partner can run day-to-day?** | ✅ Best (polished admin, zero infra) | ⚠️ Floor yes, infra no (needs sysadmin/host) | ❌ Only if you build ops UI | ✅ Floor via ViciDial; AI hands-off |
| **AI screening** | ✅ Included (Voso.ai) — **rented** | ❌ None native | ✅ **Owned** (build it) | ✅ **Owned** (reuse the repo) |
| **Number reputation / connect-rate tooling** | ✅ Best-in-class (Ignite) | ⚠️ Manual / DIY | DIY | ⚠️ ViciDial-level (DIY) |
| **Can you inject YOUR own AI?** | ❌ Not confirmed (closed) | ✅ Yes (open SIP) | ✅ It's all yours | ✅ Yes (the design) |
| **Who owns abandonment/TSR** | Convoso engine (proven) | ViciDial engine (proven) | You (unproven, riskiest) | **You** if your AI dials first (see below) |
| **Monthly cost** | $$$ per-seat + telecom | $ (server + trunks) or $$ managed | $ servers + Twilio/Retell/LLM per-min | $$ ViciDial + AI telephony + LLM |
| **The differentiator** | Commoditized (same AI all buyers get) | None (bare floor) | Fully yours, ships late | **Fully yours, floor is proven** |

## Critical insight #1 — the hybrid "compliance inversion"

The seductive story is *"use the hybrid and inherit ViciDial's proven abandonment
compliance for free."* **That's a trap.** Because your AI must be the *first* thing that
touches the consumer (to kill dead-air and screen), **your orchestrator — not ViciDial —
fires the outbound dial, and therefore owns predictive pacing and the abandonment decision.**
ViciDial shrinks to agent-side ACD of legs that already have a live human on them. So in the
"fire at concurrency, ViciDial only receives warm humans" model you described, **you must
rebuild the 3%-abandonment governor + safe-harbor logic in your own code** — the exact thing
ViciDial was supposed to give you. (Alternative "Pattern A": let ViciDial dial predictively
and your AI screen *its* connects — keeps the proven engine in the compliance seat. Safer
first step. Decide this deliberately.)

## Critical insight #2 — AI voice is legally "artificial/prerecorded"

Per the **FCC's Feb-2024 Declaratory Ruling**, an AI voice counts as an *artificial/
prerecorded voice* under the TCPA. Two consequences for any AI-fronted model (Convoso's
Voso.ai included):
- It triggers **stricter prior-express-*written*-consent** for calls to cell phones, plus an
  early automated identity disclosure.
- The AI "hold" does **not** stop the TSR's separate *"connect to a live rep within 2 seconds"*
  clock — an AI voice isn't a live rep, so these still count toward the ≤3% abandonment cap
  unless consent-backed. (The AI *does* solve the *consumer-experience* dead-air problem — a
  present voice buys ~10–30s of goodwill — but not the *legal* clock.)

This is not a reason to avoid AI dialing; it's a reason to gate leads by consent status and
bake the disclosure into the script. It applies **regardless of vendor.**

## Critical insight #3 — Convoso is closed; that's the whole trade

Convoso has an **open API for CRM/data/workflow**, but based on current public evidence there
is **no supported path to SIP-inject a call your external AI already answered into a Convoso
agent queue.** It's a managed platform with **vendor-controlled telephony**, not an open
fabric. Combined with the fact that Convoso *already sells* AI screening (Voso.ai), the
consequence is clean:
- **Convoso = rent the AI.** Great AI, not yours, not injectable-around.
- **ViciDial = own the AI.** Worse floor UX, but full freedom to interpose your own AI.

If the hybrid-with-Convoso is a must-have, get these in **writing from Convoso before buying**
(from the research): (1) inbound SIP handoff from an external screening system into an agent
queue? (2) external AMD / call classification before agent connect? (3) API to submit a
screening result/disposition? (4) supported webhook/API to transfer a *live answered leg* into
a campaign queue? (5) any restriction on non-Convoso origination for calls that reach Convoso
agents? If those are "no," the owned-AI hybrid means ViciDial, not Convoso.

## Cost picture (order-of-magnitude)

- **Convoso:** ~$90+/seat/mo + telecom/DIDs/add-ons (real spend often materially higher).
  Best connect-rate tooling can *lower cost-per-contact* even at higher sticker.
- **ViciDial self-host:** software $0; infra ~$40–350/mo small, clusters at scale; SIP
  ~$0.005–0.015/min; DIDs ~$1.50–5 each; support labor if outsourced.
- **Managed ViciDial:** ~$15–55/agent/mo (skips the Asterisk admin).
- **Custom / hybrid AI leg:** Twilio/SIP per-min + Retell (~$0.07–0.10/min) + LLM tokens —
  and you pay the AI on *every dial*, not just connects. LLM/AI-minutes are the new cost driver.

## Recommendation (given your "both" edge)

**Phase 0 — get a proven, compliant floor live fast + de-risk the AI edge, in parallel.**
- Stand up **Convoso** (or managed ViciDial if you want to keep the option to inject your own
  AI open from day one) so agents are taking calls in **weeks**, with the compliance + number-
  reputation you don't want to build. A non-technical partner can run this floor.
- Simultaneously, prototype your **AI-connect layer on the existing repo** (Retell custom-LLM
  turn loop already does answer + hold + screen). Measure whether *your* AI screening beats
  Voso.ai / raw dialing on connect→talk and close rates. This is cheap and reuses what's built.

**Phase 1 — decide own-vs-rent on evidence.**
- If Voso.ai (or Convoso's stack) gets you most of the value → stay on Convoso, save the build.
- If your AI screening is a real, measurable edge worth owning → move the floor to **ViciDial
  (managed-hosted)** and build the **hybrid** (Pattern A first: ViciDial dials, your AI screens
  its connects; keeps the proven abandonment engine in charge). The coding agents build the AI
  front-end + the DID→in-group warm-transfer bridge; a ViciDial integrator stands up the floor.

**Do not** go full-custom first: it's 2–4 months to an *unproven* floor carrying regulatory-
critical pacing code, and it delays the exact edge you're trying to prove.

### The riskiest engineering piece (whichever hybrid)
The **SIP bridge** — warm-transferring a live, AI-screened leg into an agent queue and passing
a context summary to the agent's screen (so the human doesn't open with "how can I help?").
Failure modes: one-way audio / NAT-RTP, double-recording, 8kHz-vs-16kHz ASR, conference race
on transfer, screen-pop race (write the lead *before* the transfer; match on ANI +
vendor_lead_code). **Budget a de-risking spike on the warm-transfer-into-queue path first.**

## Open decisions for you

1. **Own vs rent the AI** — is the AI-connect meant to be a *proprietary moat* (→ ViciDial
   hybrid / custom) or just a *capability you have* (→ Convoso + Voso.ai)?
2. **Who dials** in any hybrid — ViciDial/Convoso (proven engine owns abandonment, Pattern A)
   or your AI (you own abandonment, Pattern B). Start A.
3. **Who owns the accounts/infra** — partner or you (ties to the Supabase/VPS ownership
   question already raised).
4. **Consent posture** — AI-voice PEWC + recording disclosure (FL/CA all-party) must be
   settled before real dials, on any path.

*This document is engineering/business analysis, not legal advice. Validate all TCPA/TSR/DNC
and recording-consent specifics with qualified counsel before dialing at scale.*

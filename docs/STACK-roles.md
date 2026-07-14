# Stack Roles — who does what (V1 vs V3)

Clears up the recurring "are we still using Retell / Twilio?" question. Each layer is a
**different job**; adding LiveKit does not remove the carrier or the AI — it adds the piece V1
never had (live human agents in the browser).

| Layer | Job | V1 (the blank starter) | V3 (agent platform) |
|---|---|---|---|
| **Carrier / PSTN** | On-ramp to the phone network — actually dial/receive real numbers | Twilio (under Retell) | **Still required** — Twilio *or* Telnyx. LiveKit is **not** a carrier; it connects to one via SIP. |
| **AI screening leg** | Answer, hold (kill dead-air), detect live human + right-person, then release | **Retell** (custom-LLM) | **Your choice** — keep Retell, or move it into LiveKit Agents (see fork) |
| **Agent media** | The live human agent hears/talks in the **browser** (WebRTC) | *didn't exist* (V1 cold-transferred to a PSTN number) | **LiveKit** — the new piece |
| **Orchestration** | Pacing, routing, dispositions, dashboard, data | Node + Next.js + Supabase | same, extended |

## The one fork — the AI screening leg = the lean-vs-premium cost choice

- **Keep Retell** → turnkey, already working in the starter, but ~$0.15/min all-in = the cost
  model's **"premium"** row. Retell screens, then transfers the warm human into a LiveKit room
  where the agent picks up. Retell + LiveKit coexist. **Recommended to START** (fastest to live).
- **Move the AI into LiveKit Agents** → run your own STT + a cheap LLM (e.g. MiniMax/OpenRouter)
  + TTS as an agent inside the LiveKit room. This is the **"lean"** row (~$0.05/min), one unified
  stack, fully owned. **Recommended migration target** once the floor is proven — this is what
  makes building cheaper than Convoso.

Same decision, two names. You don't have to pick now; the screening logic in the starter's
`backend/server.js` carries over either way.

## Carrier choice

Keep **Twilio** (you already have it) to start, or move to **Telnyx** later for cheaper minutes
(it pairs cleanly with LiveKit — "LiveKit on Telnyx"). The carrier connects to LiveKit via a SIP
trunk; swapping carriers is a config change, not a rewrite.

## Phase 2a touches none of this

Phase 2a proves **only** the agent's low-latency browser audio via LiveKit (agent-to-agent
first). The carrier (Twilio/Telnyx → LiveKit SIP) and the AI screen leg get wired in Phase 2b/2c.
So the media proof starts today without settling the Retell decision.

# Cost & Scale Model — Build (LiveKit/custom) vs Convoso

A framework, not a quote. Plug your real answer-rate + handle-time. The headline: **building
bills on usage; Convoso bills per seat.** The per-seat license is the tax you're avoiding, and
it compounds with headcount — which is why build wins as you grow, *if* you keep the AI-screen
stack lean.

> Verify before committing: **LiveKit Cloud** audio/SIP per-minute (tiers change), and your
> actual **Convoso** quote (they custom-price with monthly minimums). Treat the numbers below as
> order-of-magnitude.

## Assumptions (per agent / month)

| | Value | Note |
|---|---|---|
| Productive dialing | 6 hrs/day × 21 days | |
| Connected calls | ~1,000/agent/mo | ~8/hr connected |
| Avg handle time | 5 min | consumer leg live this whole time |
| Answer→screen rate | ~20% | so ~5,000 dial attempts to get 1,000 connects |
| AI screen time | ~45 s per answered call, then **releases** | AI cost = screening window only |
| AI-engaged events | ~1,500/mo | connects + wrong-person + machines the AI hits |

## Per-agent monthly cost (build)

| Component | Lean stack | Premium stack | Driver |
|---|---|---|---|
| **Consumer SIP** (outbound minutes) | ~$38 | ~$38 | ~6,300 min × ~$0.006 (Telnyx/Twilio) |
| **AI screening** | **~$55** | ~$170 | ~1,125 AI-min. Lean = your own SIP + a cheap LLM (**OpenRouter/MiniMax — which you already run** — ~$0.05/min). Premium = Retell all-in ~$0.15/min |
| **LiveKit media** | ~$5–50 | ~$5–50 | ~10k participant-min. Cloud metered; **self-host ≈ fixed server cost only.** *Verify current Cloud pricing.* |
| **Per-agent variable** | **~$100–130** | ~$215–260 | |

Plus **fixed overhead** (all agents share): app VPS + Supabase + Next.js ~$50–150/mo · caller-ID
reputation monitoring ~$50–150/mo · DNC + litigator scrubbing ~$100–300/mo · a DID pool
(~30–50 numbers × ~$1) ~$30–50/mo. Call it **~$250–650/mo fixed**, shrinking per-agent as you scale.

## Totals — build vs Convoso

| Agents | Build (lean AI) | Build (premium AI) | Convoso (est.) | Convoso seat-license alone |
|---|---|---|---|---|
| **5** | ~$850–1,000/mo | ~$1,400–1,600 | ~$1,000–1,500+ *(min. commit bites here)* | ~$500 |
| **15** | ~$1,900–2,200 | ~$3,600–4,100 | ~$2,500–3,500+ | ~$1,500 |
| **30** | ~$3,600–4,100 | ~$7,000–8,000 | ~$5,000–7,000+ | ~$3,000 |

*(Convoso ≈ ~$100/seat license + ~$38 telecom + AI/add-ons, with monthly minimums; exact = their quote.)*

## Verdict

- **Building on a lean AI stack (your own SIP + a cheap LLM) is meaningfully cheaper than Convoso
  at 15–30 agents, and the gap widens with headcount** — because you pay usage, not a per-seat
  license. At 5 agents it's roughly a wash on monthly cost (Convoso's minimums hurt small teams too).
- **The lever is the AI model.** Retell's premium stack erases the savings; pointing the LLM
  adapter at MiniMax/OpenRouter (already in your world) is what makes the math work.
- **What building costs that Convoso doesn't:** the one-time build (2–4 months — but AI-assisted,
  so your *time* + compute, not a dev salary), and **you own the compliance engine** (PEWC gating +
  the ≤3% abandonment governor + DNC/litigator scrubbing are non-negotiable line items either way).
- **What you gain:** no per-seat tax, usage-based scaling, full ownership/customization, and the AI-
  screen differentiator as an asset you own.

**Numbers to pin down before Phase 2 commitments:** LiveKit Cloud actual per-minute at your
concurrency (or price a self-hosted SFU), your carrier's real US rate, and your lean-AI per-minute
once you pick the model — then this table becomes a real budget instead of a sketch.

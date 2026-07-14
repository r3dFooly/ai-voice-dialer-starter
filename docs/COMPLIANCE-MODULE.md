# Compliance module

> ⚠️ **This starter ships as a bare dialer.** By default there is **no** calling-window, DNC,
> or consent enforcement — only per-lead pacing (attempt caps + cooldown) and spend caps.

US outbound telemarketing is regulated by the **TCPA**: quiet hours (generally 8am–9pm in the
called party's local time), the National + internal **Do-Not-Call** lists, and prior express
consent for many call types — with statutory damages of **$500–$1,500 per call**. Many
industries and non-US jurisdictions add more. **You are responsible for your compliance
posture.** This module is a starting point, not legal advice.

## What "enabled" adds

Set `COMPLIANCE_MODULE_ENABLED=true` **and** apply migration `0007_compliance_dnc.sql`:

1. **DNC list** — a `dnc_list` table; leads on it are never called.
2. **Opt-in consent** — flips `retell_call_queue.consent_verified` default to `false`, and
   re-adds the `consent_verified = true` filter to the scheduler's hot-path index. New leads
   won't dial until you record consent.
3. **Calling window** — `is_lead_callable()` is replaced with a version that enforces a
   timezone-aware window (from `retell_hours_start` / `retell_hours_end` in `agency_settings`),
   operating days, and blocked dates — per the lead's `lead_timezone`.

The app layer mirrors this: `backend/compliance/` (`checkLead`) gates each lead before dial,
and returns `{ ok:true }` for everyone when disabled.

## Turning it on

```bash
# 1. apply the migration to your Supabase project
#    supabase/migrations/0007_compliance_dnc.sql
# 2. set in backend/.env
COMPLIANCE_MODULE_ENABLED=true
# 3. configure the window in agency_settings (or the dashboard):
#    retell_hours_start, retell_hours_end, retell_operating_days, retell_blocked_dates
# 4. seed your DNC list (dnc_list.phone_e164) and record consent on ingest.
```

## Important

- After enabling, **existing leads keep their `consent_verified` value**; only new leads pick
  up the `false` default. Backfill consent explicitly if needed.
- The calling window uses each lead's `lead_timezone` (default `America/New_York`). Set it
  correctly at ingest or every lead is treated as Eastern.

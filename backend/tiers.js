// Tiered retry cadence (Retell Task 15) — shared by scheduler.js (dial-time
// cadence + decay) and server.js (insert-time tier config + post-call retry).
//
// A lead's TIER decides three things:
//   1. its frequency caps (max daily/monthly/total attempts + cool-down), and
//   2. the *shape* of its retry cadence (attempts-per-day and the day-gap that
//      widens as the lead ages), and
//   3. the next dial time, rotated across morning/afternoon/evening so we never
//      hammer the same hour (TCPA good-practice + better contact rates).
//
// All "day" math is done in the LEAD's own timezone so cadence days line up with
// the lead's local calendar (and with the scheduler's per-lead 09:00–20:00
// calling-hours gate). Pure + dependency-free (Intl + a few env-config reads only)
// so it unit-tests without a DB or network. All business identity is config-driven
// (ENGAGED_LABELS / REALTIME_SOURCES envs) — the engine carries no vertical strings.

const DEFAULT_TZ = 'America/New_York';

// Sources whose lead_created_at is a TRUSTWORTHY real-time origination (only these
// earn the aggressive Tier-1 cadence — a backfilled/imported row's lead_created_at
// is its import date, not its true origination, so it can't prove freshness).
// CRM-neutral + config-driven via REALTIME_SOURCES (comma-separated, lowercased).
const REALTIME_SOURCES = String(process.env.REALTIME_SOURCES || 'webhook,api')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Free-text labels (mirrored onto lead_labels by any upstream CRM) that mark a lead
// as actively engaged and worth the moderate Tier-2 cadence. CRM-neutral + config-
// driven via ENGAGED_LABELS (comma-separated, lowercased substring match); empty by
// default so a fresh install has zero business-specific label coupling.
const ENGAGED_LABELS = String(process.env.ENGAGED_LABELS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Per-tier frequency caps. These are the source of truth: the scheduler uses
// them to gate dialing (so a decayed lead is governed by its CURRENT tier even
// if its stored columns are stale) and the ingest server stamps them onto new
// rows. Mirrors the Task 15 spec table exactly.
const TIER_CONFIG = {
  1: { max_daily_attempts: 3, max_monthly_attempts: 15, max_total_attempts: 30, cool_down_hours: 4 },
  2: { max_daily_attempts: 3, max_monthly_attempts: 15, max_total_attempts: 30, cool_down_hours: 4 },
  3: { max_daily_attempts: 1, max_monthly_attempts: 10, max_total_attempts: 20, cool_down_hours: 24 },
  4: { max_daily_attempts: 1, max_monthly_attempts: 10, max_total_attempts: 20, cool_down_hours: 24 },
};

// Time-of-day buckets used by the rotation rule (hours are lead-local, 24h).
const MORNING_HOUR = 9; // 09:00–12:00
const AFTERNOON_HOUR = 13; // 12:00–17:00
const EVENING_HOUR = 17; // 17:00–20:00

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Render an instant into wall-clock parts for an IANA timezone. An unknown zone
// falls back to ET so a bad lead_timezone can never throw inside a dial decision.
function tzParts(timezone, date) {
  const fmt = (tz) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(date);
  let parts;
  try {
    parts = fmt(timezone || DEFAULT_TZ);
  } catch {
    parts = fmt(DEFAULT_TZ);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl can emit 24 at midnight
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(hour),
    minute: Number(get('minute')),
    weekday: wdMap[get('weekday')],
  };
}

// UTC instant whose wall-clock in `timezone` equals the given local Y-M-D H:M.
// Iteratively corrects for the zone offset (two passes converge across DST).
function zonedWallClockToUtc(timezone, y, m, d, hour, minute = 0) {
  const targetAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = new Date(targetAsUtc);
  for (let i = 0; i < 3; i++) {
    const p = tzParts(timezone, guess);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = targetAsUtc - localAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

// The local calendar Y-M-D that is `addDays` after `now` in the given timezone.
function localDatePlusDays(timezone, now, addDays) {
  const p = tzParts(timezone, now);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  base.setUTCDate(base.getUTCDate() + addDays);
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

// UTC instant for (local calendar day of `now` + dayOffset) at `hour`:00 local.
function slotInTz(timezone, now, dayOffset, hour) {
  const { y, m, d } = localDatePlusDays(timezone, now, dayOffset);
  return zonedWallClockToUtc(timezone, y, m, d, hour, 0);
}

// Whole calendar days between two instants in a timezone (b's local date minus
// a's local date). Never negative.
function calendarDaysBetween(timezone, a, b) {
  const pa = tzParts(timezone, a);
  const pb = tzParts(timezone, b);
  const ua = Date.UTC(pa.year, pa.month - 1, pa.day);
  const ub = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.max(0, Math.round((ub - ua) / 86400000));
}

// Elapsed (not calendar) days between two instants. Used for the "within N days"
// recency windows in getTier.
function elapsedDays(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 86400000;
}

// Next time-of-day bucket after the lead's last attempt hour. Rotates
// morning → afternoon → evening → (next day) morning so we never re-dial the
// same window back-to-back. rollDay=true means the rotation wrapped past 20:00
// and the next slot must land on a later day.
function rotateHour(lastHour) {
  const h = Number(lastHour);
  if (!Number.isFinite(h)) return { hour: MORNING_HOUR, rollDay: false };
  if (h >= MORNING_HOUR && h < 12) return { hour: AFTERNOON_HOUR, rollDay: false };
  if (h >= 12 && h < EVENING_HOUR) return { hour: EVENING_HOUR, rollDay: false };
  if (h >= EVENING_HOUR && h < 20) return { hour: MORNING_HOUR, rollDay: true };
  return { hour: MORNING_HOUR, rollDay: false };
}

// Cadence phase for a tier at a given (0-based) day index since its anchor:
// how many attempts that day permits (perDay) and the day-gap to the next
// eligible day once the day's allotment is spent (gapDays). Tier 4 reuses the
// Tier 3 shape — a missed callback "falls to Tier 3 cadence".
function phaseFor(tier, dayIndex) {
  if (tier === 1) {
    if (dayIndex <= 0) return { perDay: 3, gapDays: 1 }; // day 1: 3 attempts, 4h apart
    if (dayIndex <= 13) return { perDay: 2, gapDays: 1 }; // days 2-14: TWICE DAILY (sustained — operator 2026-06-26)
    return { perDay: 1, gapDays: 2 }; // days 15-30: every other day
  }
  if (tier === 2) {
    if (dayIndex <= 0) return { perDay: 3, gapDays: 1 }; // engagement day: 3 attempts
    if (dayIndex <= 4) return { perDay: 2, gapDays: 1 }; // days 2-5: twice daily
    return { perDay: 1, gapDays: 2 }; // days 6+: every other day
  }
  // Tier 3 (and Tier 4 after a missed callback).
  if (dayIndex <= 6) return { perDay: 1, gapDays: 1 }; // week 1
  if (dayIndex <= 13) return { perDay: 1, gapDays: 2 }; // week 2
  return { perDay: 1, gapDays: 3 }; // weeks 3-4+
}

// The cadence anchor (day 0) for a tier.
function anchorFor(record /*, tier */) {
  // Voice-only schema carries no per-event engagement timestamps (the SMS /
  // appointment / handoff columns are cut), so every tier — including the engaged
  // Tier 2 — anchors its cadence to lead creation. An externally-labeled engaged
  // lead (see isEngaged) de-escalates purely by its age from creation.
  return parseDate(record.lead_created_at) || parseDate(record.created_at);
}

// Does this lead show a live engagement signal worth working on the moderate
// Tier-2 cadence? The voice-only schema drops the timestamped SMS / appointment /
// handoff engagement columns, so lead_labels is the only signal: a CRM-neutral
// free-text label set (see ENGAGED_LABELS). Matching is lowercased substring so
// upstream label-rotation variants still hit. Empty ENGAGED_LABELS → never engaged.
function isEngaged(record /*, now */) {
  if (ENGAGED_LABELS.length === 0) return false;
  const labels = (record.lead_labels || []).map((t) => String(t).toLowerCase());
  return labels.some((t) => ENGAGED_LABELS.some((k) => t.includes(k)));
}

// Classify a queue row into its retry tier. Order matters: an explicit Callback
// disposition wins, then a genuinely-fresh REAL-TIME lead, then an ENGAGED lead
// (the 2026-06-26 unlock — works for ANY source so backfilled rework leads are
// no longer stranded in the slow Tier-3 sweep), else the conservative tier.
//
// The Tier-1 SOURCE gate stays on purpose: the queue's lead_created_at is the
// IMPORT date for backfilled leads (their true origination isn't synced to the
// queue — ghl_created_at is null), so it can't prove freshness for non-real-time
// rows. Only a real-time webhook lead has a trustworthy lead_created_at, so only
// it can earn the aggressive Tier-1 cadence. Backfilled leads are tiered by
// ENGAGEMENT instead (warm -> Tier 2, cold -> Tier 3).
function getTier(record, now) {
  const nowD = now ?? new Date();
  if (record.disposition === 'Callback') return 4;

  // Tier 1: a fresh real-time lead within 30 days of creation.
  if (REALTIME_SOURCES.includes(String(record.source || '').toLowerCase())) {
    const created = parseDate(record.lead_created_at);
    if (created && elapsedDays(nowD, created) <= 30) return 1;
  }

  // Tier 2: an engaged lead, ANY source (matched by lead_labels — see isEngaged).
  if (isEngaged(record, nowD)) return 2;

  return 3;
}

// Frequency-cap config for a tier (defaults to Tier 3, the safest).
function tierConfig(tier) {
  return TIER_CONFIG[tier] || TIER_CONFIG[3];
}

// Direction A (cooldown-starvation fix): next_attempt_at must never be earlier
// than the cooldown floor (now + cool_down_hours). The dialer's fetch filter
// (`.lte('next_attempt_at', now)`) and the authoritative `is_lead_callable` RPC
// are two independent definitions of "ready"; when a cadence/seed slot lands
// INSIDE the cooldown window, the row reads as due for the fetch but
// is_lead_callable rejects it — so it silently eats a fetch-batch slot ahead of
// genuinely-callable leads (head-of-line starvation). Clamping at write time
// keeps the two signals in sync. Returns targetIso unchanged when cooldown is
// absent/zero. Pure.
function clampToCooldownFloor(targetIso, coolDownHours, now) {
  const nowD = now ?? new Date();
  const hours = Number(coolDownHours);
  if (!Number.isFinite(hours) || hours <= 0) return targetIso;
  const floorMs = nowD.getTime() + hours * 3600 * 1000;
  const targetMs = targetIso ? new Date(targetIso).getTime() : 0;
  return new Date(Math.max(targetMs, floorMs)).toISOString();
}

// When should the NEXT call happen, given the lead's tier and how many attempts
// it has already had today (daily_attempt_count, already incremented for the
// attempt just placed). Returns an ISO timestamp string in the future.
//
// Logic: find the cadence phase for the lead's age; if the phase still allows
// another attempt today AND the rotation hasn't wrapped past evening, schedule
// the next rotated bucket later today; otherwise jump to the next eligible day
// (phase gapDays out) at the next rotated bucket. Tier 4 uses the Tier 3 shape.
function getNextAttemptTime(record, tier, now) {
  const nowD = now ?? new Date();
  const tz = record.lead_timezone || DEFAULT_TZ;
  const cadenceTier = tier === 4 ? 3 : tier;

  const anchor = anchorFor(record, cadenceTier) || nowD;
  const dayIndex = calendarDaysBetween(tz, anchor, nowD);
  const { perDay, gapDays } = phaseFor(cadenceTier, dayIndex);

  const attemptsToday = record.daily_attempt_count ?? 0;
  const rot = rotateHour(record.last_attempt_hour);

  let dayOffset;
  if (attemptsToday < perDay && !rot.rollDay) {
    dayOffset = 0; // another slot fits later today
  } else {
    dayOffset = Math.max(1, gapDays); // move to the next eligible day
  }

  let target = slotInTz(tz, nowD, dayOffset, rot.hour);
  // Never schedule into the past: if today's rotated slot already passed, push
  // to the next eligible day at the same rotated bucket.
  if (target.getTime() <= nowD.getTime()) {
    target = slotInTz(tz, nowD, Math.max(1, gapDays), rot.hour);
  }
  // Direction A: a cadence slot may land sooner than the tier's cool-down (e.g.
  // a tier-3 "next morning" slot ~13h after an evening attempt vs a 24h
  // cool-down). Clamp to the cool-down floor so next_attempt_at agrees with
  // is_lead_callable and never starves the fetch batch. Uses the REAL tier's
  // cool-down (tier 4 → 24h), not the cadence tier.
  return clampToCooldownFloor(target.toISOString(), tierConfig(tier).cool_down_hours, nowD);
}

// Start of the next business day (Mon–Fri) at 09:00 in the lead's timezone.
// Used by the voicemail-per-day limit: after a voicemail we don't dial again
// until at least the next business morning (max 1 VM/day).
function nextBusinessDay9amInTz(now, timezone) {
  const tz = timezone || DEFAULT_TZ;
  const nowD = now ?? new Date();
  for (let add = 1; add <= 7; add++) {
    const { y, m, d } = localDatePlusDays(tz, nowD, add);
    const probe = zonedWallClockToUtc(tz, y, m, d, MORNING_HOUR, 0);
    const wd = tzParts(tz, probe).weekday;
    if (wd >= 1 && wd <= 5) return probe.toISOString();
  }
  const { y, m, d } = localDatePlusDays(tz, nowD, 1);
  return zonedWallClockToUtc(tz, y, m, d, MORNING_HOUR, 0).toISOString();
}

// Current lead-local hour (0–23) — stamped as last_attempt_hour on each dial so
// the next attempt rotates to a different time-of-day bucket.
function currentHourInTz(timezone, now) {
  return tzParts(timezone || DEFAULT_TZ, now ?? new Date()).hour;
}

module.exports = {
  DEFAULT_TZ,
  TIER_CONFIG,
  getTier,
  isEngaged,
  tierConfig,
  getNextAttemptTime,
  clampToCooldownFloor,
  nextBusinessDay9amInTz,
  currentHourInTz,
  rotateHour,
  phaseFor,
  anchorFor,
  calendarDaysBetween,
  elapsedDays,
  slotInTz,
  zonedWallClockToUtc,
  tzParts,
};

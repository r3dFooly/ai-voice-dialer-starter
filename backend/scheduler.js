// Retell Dialer Scheduler — long-running outbound-call worker.
//
// Polls public.retell_call_queue every POLL_INTERVAL_MS and fires ONE Retell
// outbound call at a time, gated by agency_settings (master toggle, operating
// window, blocked dates) and Retell spend caps. Owns no HTTP surface — call
// resolution (In_Progress -> Completed/Voicemail/...) is the webhook's job.
//
// Run under pm2:
//   pm2 start scheduler.js --name retell-scheduler && pm2 save
//
// Env (sourced via pm2 from /etc/openclaw.env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RETELL_API_KEY, RETELL_AGENT_ID
//
// --- Compliance posture (TCPA / FL mini-TCPA) -------------------------------
// Two conditions are enforced on EVERY dial, beyond the task's base query:
//   1. consent_verified = true  (prior express written consent — TCPA)
//   2. dnc_checked = true       (federal DNC scrub — see compliance-guardrails
//      §5). Nothing in the current pipeline sets dnc_checked, so by default the
//      dialer will NOT place calls until a DNC scrub populates it. This is
//      intentional: a dialer that violates TCPA is worse than one that waits.
//      Operators who scrub DNC upstream (e.g. inside GHL) can relax this by
//      setting RETELL_REQUIRE_DNC_CHECKED=false — an informed, logged choice.
// The agency-wide ET operating window is owned entirely by agency_settings
// (retell_hours_start / retell_hours_end), re-read on every poll so the
// dashboard's calling-hours control governs the scheduler directly. The TCPA
// compliance backstop is the PER-LEAD gate below: every dial is additionally
// clamped to 09:00–20:00 in the LEAD's own timezone (withinCallingHours), so a
// misconfigured agency window can never push a call outside a lead's legal
// hours.
//
// --- Contact frequency + per-lead timezone (Task 12) ------------------------
// Beyond the agency-wide ET window, every dial is gated by TCPA contact-
// frequency limits and the LEAD's own local calling hours:
//   * daily / monthly / total attempt caps + a per-lead cool-down, enforced
//     BOTH server-side (is_lead_callable RPC) and here at the application level
//     (defense-in-depth — a dialer that over-contacts is a TCPA violation).
//   * 09:00–20:00 in the lead's lead_timezone (default ET). A lead is dialed
//     only when BOTH the ET operating window AND its lead-local window are open.
//   * a lead at its lifetime cap is retired to dialer_status 'Max_Attempts_Reached'.
// Daily / monthly counters are reset via Supabase RPCs on ET calendar rollover.
//
// --- Tiered retry cadence (Task 15) -----------------------------------------
// Each lead's tier (see tiers.js) sets BOTH its frequency caps and the shape of
// its retry cadence (attempts-per-day + widening day-gaps as it ages), plus a
// morning/afternoon/evening rotation so we never re-dial the same hour. On every
// dial we stamp last_attempt_hour, pre-set next_attempt_at from the cadence, and
// re-stamp the tier's caps. A daily sweep decays aged-out Tier 1 leads to Tier 3.

// Adapters + config replace the original hardcoded the LLM/Retell/the notifier/Supabase
// wiring. All CRM-specific reads/writes go through leadSource; the compliance
// façade (OFF by default) is the only per-lead gate beyond the queue query.
const { config, agentDisplayName: agentPersonaName } = require('./config');
const { getLeadSource } = require('./adapters/leadSource');
const leadSource = getLeadSource();
const compliance = require('./compliance');
const {
  getTier,
  tierConfig,
  getNextAttemptTime,
  currentHourInTz,
  TIER_CONFIG,
} = require('./tiers');

// --- config -----------------------------------------------------------------

const RETELL_API_KEY = config.retell.apiKey;
const RETELL_AGENT_ID = config.retell.agentId;

const POLL_INTERVAL_MS = config.server.schedulerPollMs;
const RETELL_CREATE_CALL_URL = 'https://api.retellai.com/v2/create-phone-call';
const ET_TIMEZONE = 'America/New_York';

// B1: stale In_Progress reaper. In_Progress is resolved by the Retell webhook
// (call_ended/call_analyzed in server.js) — but handleCallEnded's
// 'await_analysis' branch leaves the row In_Progress when call_analyzed never
// arrives (webhook outage, signature failure, Retell drop). With the cap
// counting In_Progress rows, ONE such orphan deadlocks ALL dialing forever
// (live case: queue 07ea7b30… sat In_Progress ~1.8 days). Any row stuck
// beyond the TTL (default 30 min — no real call lasts that long) goes back to
// Pending with its attempt counters kept (markInProgress already spent the
// attempt) and a short re-dial buffer.
const STALE_CALL_TTL_MS = Number(process.env.RETELL_STALE_CALL_TTL_MS || 30 * 60_000);
const STALE_REAP_BUFFER_MS = 5 * 60_000; // reaped rows wait 5 min before re-dial
const STALE_REAP_CAP = 10; // per sweep — a mass-orphan event clears over a few ticks

// The dialer_status CHECK constraint does NOT include 'Failed'. A hard Retell
// rejection (non-429 4xx) takes the row out of rotation via the nearest allowed
// terminal status instead.
const TERMINAL_FAILURE_STATUS = 'Skipped';

// Per-attempt retry budgets for a single create-phone-call.
const MAX_RATE_LIMIT_RETRIES = 3; // 429 -> wait 10s
const MAX_SERVER_RETRIES = 3; // 5xx -> wait 30s
const MAX_NETWORK_RETRIES = 3; // network error -> wait 60s
const RATE_LIMIT_BACKOFF_MS = 10_000;
const SERVER_BACKOFF_MS = 30_000;
const NETWORK_BACKOFF_MS = 60_000;

// When a transient failure exhausts its retries, defer the row instead of
// burning a Pending slot forever; give up to Skipped once max_retries is hit.
const TRANSIENT_DEFER_MS = 5 * 60_000;

// --- contact-frequency + per-lead timezone (Task 12) ------------------------
const DEFAULT_LEAD_TZ = 'America/New_York'; // used when lead_timezone is null
const LEAD_HOURS_START = '09:00';
// 20:00 is treated as CLOSED (>= blocks it): FL mini-TCPA bans calls "after 8pm".
const LEAD_HOURS_END = '20:00';
// Task 21: a scheduled callback more than this far past its time is a missed
// appointment — downgraded to a Tier 3 data lead instead of dialed late.
const CALLBACK_MISS_GRACE_MS = 24 * 3600_000;
// How many top-priority Pending rows to pull per cycle. We still dial ONE; the
// surplus lets us skip leads that are capped or outside their local calling
// hours and fall through to the next eligible lead without waiting a poll.
const CANDIDATE_BATCH_SIZE = Number(process.env.RETELL_CANDIDATE_BATCH_SIZE || 25);
// Reset-watcher cadence — checks for an ET day/month rollover this often.
const RESET_WATCH_INTERVAL_MS = 60_000;

// --- Freshness-decay sweep (speed-to-lead integrity) -------------------------
// priority_score is stamped ONCE at ingest by scoreLead() (server.js) and is
// never re-evaluated, so a lead that scored 100 when it was <5 min old keeps
// 100 for weeks and pins the head of the priority-ordered dial queue forever —
// starving genuinely fresh leads (observed 2026-06-18: 19-day-old 100s sitting
// above never-called leads). This sweep re-scores Pending leads DOWN to their
// current-age bucket so freshness actually drives the queue. It is DECAY-ONLY
// (never raises) and touches ONLY rows still carrying a scoreLead-origin age
// value; engagement overrides (70/90) and the 20 floor are left untouched, and
// callbacks (priority 100) are excluded because they live in dialer_status
// 'Callback_Scheduled', not 'Pending'. The weekend-deferral score 80 IS decayed
// once such a lead ages past its bucket (it stays deferred via next_attempt_at,
// which the sweep never touches). CAVEAT: a dashboard "call now" that sets
// priority 100 on an OLD lead can be decayed by this sweep within one interval;
// to make an operator override decay-immune, set it to a value OUTSIDE this set
// (e.g. 101) — follow-up, the dashboard is out of this change's scope.
// 50 is the flat priority stamped on the one-time GHL backfill import (source
// 'ghl_backfill'); including it lets those weeks-old leads decay by current age
// so genuinely fresh form-submits sort above the backlog instead of behind it.
const RESCORE_DECAY_SET = [100, 95, 80, 60, 50, 40];
const RESCORE_INTERVAL_MS = Number(process.env.RETELL_RESCORE_INTERVAL_MS || 10 * 60 * 1000);
let lastRescoreMs = 0;

// agency_settings keys (mirrors dashboard/src/lib/dialer/types.ts).
const SETTING_KEYS = {
  enabled: 'retell_dialer_enabled',
  operating_days: 'retell_operating_days',
  hours_start: 'retell_hours_start',
  hours_end: 'retell_hours_end',
  daily_cap: 'retell_daily_cap',
  monthly_cap: 'retell_monthly_cap',
  blocked_dates: 'retell_blocked_dates',
  default_from_number: 'retell_default_from_number',
  // B1: previously documented-but-unread (the cap was hardcoded to 1 via a
  // bare inProgress > 0 check); now honored from the live row (value '1').
  max_concurrent: 'retell_max_concurrent',
};

// Defaults seeded into agency_settings when a key is absent, and used as the
// in-memory fallback when a row cannot be read. operating_days is stored as an
// integer array [1..5] to match the live dashboard contract (the task spec's
// string day-names would be silently dropped by the dashboard parser).
const DEFAULT_SETTINGS = {
  enabled: false, // Alex turns the dialer on manually.
  operating_days: [1, 2, 3, 4, 5], // Mon–Fri (0=Sun..6=Sat)
  hours_start: '09:00',
  hours_end: '20:00',
  daily_cap: 5.0,
  monthly_cap: 100.0,
  blocked_dates: [],
  default_from_number: '',
  max_concurrent: 1,
};

// value_type per key — mirrors dashboard valueTypeFor(). agency_settings.value_type
// has a CHECK constraint that accepts only 'Currency'|'Percent'|'Number'|'Text',
// so seeding 'Boolean'/'JSON'/'Time'/'String' here would be rejected. value_type
// is descriptive metadata only (readers parse by setting_key), so caps map to
// 'Currency' and everything else to 'Text', matching the dashboard.
const SETTING_VALUE_TYPES = {
  [SETTING_KEYS.enabled]: 'Text',
  [SETTING_KEYS.operating_days]: 'Text',
  [SETTING_KEYS.hours_start]: 'Text',
  [SETTING_KEYS.hours_end]: 'Text',
  [SETTING_KEYS.daily_cap]: 'Currency',
  [SETTING_KEYS.monthly_cap]: 'Currency',
  [SETTING_KEYS.blocked_dates]: 'Text',
  [SETTING_KEYS.default_from_number]: 'Text',
  [SETTING_KEYS.max_concurrent]: 'Number',
};

const DAY_NAME_TO_IDX = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// --- pure helpers (exported for testing) ------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTime(raw, fallback) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function parseNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Accept operating_days as integers (0..6) OR day-name strings; normalize to a
// Set of integer day indices. Tolerant of either storage format.
function parseOperatingDays(raw) {
  const arr = Array.isArray(raw) ? raw : parseJsonArray(raw);
  const out = new Set();
  for (const el of arr) {
    if (typeof el === 'number' && Number.isInteger(el) && el >= 0 && el <= 6) {
      out.add(el);
    } else if (typeof el === 'string') {
      const idx = DAY_NAME_TO_IDX[el.trim().toLowerCase()];
      if (idx !== undefined) out.add(idx);
    }
  }
  return out;
}

// Map the loaded agency_settings shape onto the compliance module's expected
// settings ({ hoursStart, hoursEnd, operatingDays[], blockedDates[] }). Used by
// compliance.checkLead — a pass-through when the compliance module is disabled.
function complianceSettings(settings) {
  return {
    hoursStart: settings.hours_start,
    hoursEnd: settings.hours_end,
    operatingDays: Array.from(parseOperatingDays(settings.operating_days)),
    blockedDates: settings.blocked_dates,
  };
}

// Render now() into ET parts: { weekday: 0..6, hhmm: "HH:MM", date: "YYYY-MM-DD" }.
function etParts(now) {
  const dt = now ?? new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl can emit 24 at midnight
  return {
    weekday: wdMap[get('weekday')],
    hhmm: `${hour}:${get('minute')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

// Decide whether dialing is permitted right now. Returns { open, reason, detail }.
function evaluateWindow(settings, now) {
  const { weekday, hhmm, date } = etParts(now);

  const days = parseOperatingDays(settings.operating_days);
  if (!days.has(weekday)) {
    return { open: false, reason: 'outside_days', detail: `ET weekday ${weekday} not in operating days` };
  }
  if (Array.isArray(settings.blocked_dates) && settings.blocked_dates.includes(date)) {
    return { open: false, reason: 'blocked_date', detail: `${date} is a blocked date` };
  }

  // Operating window comes straight from agency_settings (re-read every poll in
  // tick()), so the dashboard's calling-hours control governs the scheduler with
  // no hardcoded clamp. Per-lead TCPA enforcement (09:00–20:00 in the lead's own
  // timezone) still gates every individual dial — see withinCallingHours().
  const start = settings.hours_start;
  const end = settings.hours_end;
  if (hhmm < start || hhmm >= end) {
    return { open: false, reason: 'outside_hours', detail: `ET ${hhmm} outside ${start}–${end}` };
  }
  return { open: true, reason: 'active', detail: `ET ${hhmm}` };
}

// Render "HH:MM" wall-clock in an arbitrary IANA timezone. An invalid/unknown
// zone falls back to ET so a bad lead_timezone can never crash a dial decision.
function hhmmInTimeZone(timezone, now) {
  const dt = now ?? new Date();
  const fmt = (tz) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(dt);
  let parts;
  try {
    parts = fmt(timezone || DEFAULT_LEAD_TZ);
  } catch {
    parts = fmt(DEFAULT_LEAD_TZ);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl can emit 24 at midnight
  return `${hour}:${get('minute')}`;
}

// TCPA per-lead calling-hours gate: 09:00–20:00 in the lead's local timezone.
function withinCallingHours(timezone, now) {
  const hhmm = hhmmInTimeZone(timezone, now);
  return hhmm >= LEAD_HOURS_START && hhmm < LEAD_HOURS_END;
}

// Application-level mirror of the DB frequency caps (defense-in-depth alongside
// the is_lead_callable RPC). Defaults match the column defaults.
function withinCountLimits(r) {
  return (
    (r.daily_attempt_count ?? 0) < (r.max_daily_attempts ?? 2) &&
    (r.monthly_attempt_count ?? 0) < (r.max_monthly_attempts ?? 6) &&
    (r.total_attempt_count ?? 0) < (r.max_total_attempts ?? 10)
  );
}

// A lead at/over its lifetime attempt cap is retired, never re-dialed.
function isOverTotalCap(r) {
  return (r.total_attempt_count ?? 0) >= (r.max_total_attempts ?? 10);
}

// Cool-down honored: no prior attempt, or cool_down_hours elapsed since it.
function coolDownElapsed(r, now) {
  if (!r.last_attempt_at) return true;
  const last = new Date(r.last_attempt_at).getTime();
  if (Number.isNaN(last)) return true;
  const hours = r.cool_down_hours ?? 4;
  return last + hours * 3600_000 <= (now ?? new Date()).getTime();
}

// --- tiered cadence gates (Task 15) -----------------------------------------
// The lead's CURRENT tier (from getTier) is the authority for its caps, so a
// decayed lead is governed by its real tier even if its stored max_* columns
// are stale. These mirror the generic helpers above but read the tier config.
function withinTierLimits(r, cfg) {
  return (
    (r.daily_attempt_count ?? 0) < cfg.max_daily_attempts &&
    (r.monthly_attempt_count ?? 0) < cfg.max_monthly_attempts &&
    (r.total_attempt_count ?? 0) < cfg.max_total_attempts
  );
}

function coolDownElapsedHours(r, hours, now) {
  if (!r.last_attempt_at) return true;
  const last = new Date(r.last_attempt_at).getTime();
  if (Number.isNaN(last)) return true;
  return last + hours * 3600_000 <= (now ?? new Date()).getTime();
}

// Decide which counter resets are due given ET calendar rollover. Pure and
// testable: returns the actions to run plus the advanced marker state. Daily
// fires on any ET date change (midnight); monthly fires on the 1st of a new ET
// month. A null/absent prior state seeds markers without firing (boot case).
function computeResetActions(now, state) {
  const { date } = etParts(now ?? new Date());
  const month = date.slice(0, 7); // YYYY-MM
  const day = date.slice(8, 10); // DD
  const actions = { daily: false, monthly: false };
  const next = {
    lastDailyResetDate: state?.lastDailyResetDate ?? date,
    lastMonthlyResetMonth: state?.lastMonthlyResetMonth ?? month,
  };
  if (state && state.lastDailyResetDate !== date) {
    actions.daily = true;
    next.lastDailyResetDate = date;
  }
  if (day === '01' && state && state.lastMonthlyResetMonth !== month) {
    actions.monthly = true;
    next.lastMonthlyResetMonth = month;
  }
  return { actions, next };
}

// First name the agent uses to greet the lead, sourced from the QUEUE ROW's
// contact_name (RD.13) — never a GHL phone-number lookup, which had been
// greeting leads by the wrong name. An empty/NULL name, or the literal
// "Unknown" placeholder server.js stamps when GHL has no name, becomes
// "there" so the agent says "Hi there" rather than "Hi Unknown".
function firstName(contactName) {
  const raw = String(contactName ?? '').trim();
  if (!raw || raw.toLowerCase() === 'unknown') return 'there';
  const n = raw.split(/\s+/)[0];
  return n || 'there';
}

// P0-B CNAM-leak defense. Twilio CNAM (caller_name) is the phone LINE-OWNER name,
// not the lead — enrichment can leak it into GHL firstName -> contact_name, so
// greeting by contact_name would name the wrong person. Returns true when
// contact_name IS the CNAM line-owner name. Both are normalized to uppercase
// letters-only tokens (so "PULLEN,DEBORAH" / "PULLEN, DEBORAH" tokenize the same
// as "DEBORAH PULLEN"); a match is either identical token SETS, or one set fully
// contained in the other backed by >=2 shared tokens of >=3 chars. Conservative:
// returns false whenever unsure, so a legit name is never wiped.
function nameMatchesCnam(contactName, cnamName) {
  const norm = (s) => String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const a = [...new Set(norm(contactName))];
  const b = [...new Set(norm(cnamName))];
  if (!a.length || !b.length) return false;
  // Two tokens "share" if equal OR one is a >=4-char prefix of the other. Twilio
  // CNAM caps caller_name ~15 chars and TRUNCATES the given name (VERONICA->VERONI,
  // TIMOTHY->TIMOTH), so exact-token matching misses the common real-world shape.
  const tokShare = (x, y) =>
    x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y));
  const shared = a.filter((t) => b.some((u) => tokShare(t, u)));
  // Match when EITHER side's tokens are all covered by the other (identical set or
  // one contained in the other — handles reversed/comma order + truncation), backed
  // by >=2 shared tokens of >=3 chars so a lone shared first name never matches.
  const aAll = a.every((t) => b.some((u) => tokShare(t, u)));
  const bAll = b.every((t) => a.some((u) => tokShare(t, u)));
  const strong = shared.filter((t) => t.length >= 3).length;
  return (aAll || bAll) && strong >= 2;
}

// FB form names arrive lower/mixed-case; Twilio CNAM (and any CNAM-sourced
// pollution of contact_name) is ALL-CAPS. Only an ALL-CAPS name is treated as a
// CNAM suspect, so a correct lower/mixed-case form name is NEVER downgraded — even
// for a lead who owns their own phone (whose CNAM legitimately equals their name).
function isAllCapsName(s) {
  const t = String(s ?? '').trim();
  return /[A-Z]/.test(t) && t === t.toUpperCase() && !/^unknown$/i.test(t);
}

// Greeting name the agent uses. Neutral "there" ONLY when the stored contact_name is an
// ALL-CAPS CNAM line-owner name (matches cnam_name) — i.e. the name was polluted by
// the phone owner, not the lead. Otherwise the real first name (firstName handles
// empty/"Unknown" -> "there").
function resolveLeadName(record) {
  const cn = record && record.contact_name;
  if (isAllCapsName(cn) && nameMatchesCnam(cn, record && record.cnam_name)) return 'there';
  return firstName(cn);
}

// Display name for "your agent" on the call — the free-text assigned_agent from
// the queue row, falling back to the configured agent persona name when a lead
// is unassigned. (The original hardcoded a JC/KJ/AJ -> human-name map; blanked
// here so the code carries zero business identity.)
function agentDisplayName(assignedAgent) {
  return String(assignedAgent || '').trim() || agentPersonaName();
}

// Build the create-phone-call request body. Dynamic variables must be strings.
// Per-segment voicemail drop. voicemail_option is agent-level in Retell, so we
// attach the message per call. static_text = fixed message spoken in the agent
// voice at zero LLM cost (this is NOT ringless VM — the call rings first; AMD
// leaves the message). Blanked to config: one neutral default, optionally
// overridden per segment via a RETELL_VM_<SEGMENT> env var (e.g. RETELL_VM_ACA).
const VOICEMAIL_DEFAULT =
  process.env.RETELL_VM_TEXT ||
  `Hi, this is ${agentPersonaName()} calling from ${config.company.name || 'our office'} — ` +
    'we have some information ready for you. Please give us a call back when you have a moment. Thanks!';
function voicemailTextForVertical(segment) {
  const key = `RETELL_VM_${String(segment || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return process.env[key] || VOICEMAIL_DEFAULT;
}

function buildCallPayload(record, fromNumber, agentId) {
  // lead_context is a JSONB column carrying the vertical/enrichment fields surfaced by
  // the dashboard. Pass them through as strings so the Retell agent can
  // tailor the conversation for the vertical-eligibility-approaching leads.
  const ctx = record.lead_context || {};
  const dynamic = {
    // RD.13: lead_name comes straight from the queue row's contact_name (via
    // firstName), NOT a GHL contact lookup by phone — that lookup was naming
    // leads "Daryl"/"Dot" instead of who the row says they are.
    // CNAM-leak defense — if the stored name IS the line-owner CNAM name, greet neutrally.
    lead_name: resolveLeadName(record),
    agent_name: agentDisplayName(record.assigned_agent),
    product_interest: String(record.product_interest || record.segment || ''),
    segment: String(record.segment || ''),
    turning_65_when: String(ctx.turning_65_when ?? ''),
    months_until_65: String(ctx.months_until_65 ?? ''),
    t65_route: String(ctx.t65_route ?? ''),
    is_65_or_older: String(ctx.is_65_or_older ?? ''),
    source_survey: String(ctx.source_survey ?? ''),
  };
  return {
    from_number: fromNumber,
    to_number: record.phone_e164,
    override_agent_id: agentId,
    // Per-call, per-segment voicemail (see voicemailTextForVertical).
    agent_override: {
      agent: {
        voicemail_option: {
          action: { type: 'static_text', text: voicemailTextForVertical(record.segment) },
        },
      },
    },
    metadata: {
      queue_id: String(record.id),
      external_lead_id: record.external_lead_id ?? null,
      assigned_agent: record.assigned_agent ?? null,
    },
    retell_llm_dynamic_variables: dynamic,
  };
}

// --- runtime (require a live supabase client) -------------------------------

let supabase = null;
let running = true;

// Reset watcher: timer handle + ET calendar markers (seeded on startup so a
// reset fires only on a genuine ET rollover while we are running).
let resetTimer = null;
let resetState = null;

// Throttle repetitive state logs: only emit when the reason/detail changes.
let lastStateKey = null;
function noteState(reason, detail) {
  const key = `${reason}|${detail}`;
  if (key === lastStateKey) return;
  lastStateKey = key;
  console.log(`[retell-scheduler] ${reason}: ${detail}`);
}

// Dedupe consecutive identical skip lines so a long outside-calling-hours
// window does not spam the log every poll interval. Reset after a real dial.
let lastSkipLog = null;
function logSkip(msg) {
  if (msg === lastSkipLog) return;
  lastSkipLog = msg;
  console.log(`[retell-scheduler] ${msg}`);
}

// Read the retell_* settings, newest effective_from <= today per key, falling
// back to DEFAULT_SETTINGS. Mirrors dashboard fetchDialerSettings semantics.
async function loadSettings() {
  const today = etParts(new Date()).date;
  let data;
  let error;
  try {
    ({ data, error } = await supabase
      .from('agency_settings')
      .select('setting_key, setting_value, effective_from')
      .in('setting_key', Object.values(SETTING_KEYS))
      .order('effective_from', { ascending: false }));
  } catch (e) {
    error = e;
  }
  if (error) {
    // Fail safe: a settings-read failure must neither crash the poll loop nor
    // dial under an unknown config. Fall back to DEFAULT_SETTINGS — which pauses
    // the dialer (enabled=false) and carries the safe 09:00–20:00 ET operating
    // window — and LOG loudly so the failure is visible. The next poll re-reads.
    console.error(
      `[retell-scheduler] loadSettings failed; using safe defaults ` +
        `(dialer paused, hours ${DEFAULT_SETTINGS.hours_start}–${DEFAULT_SETTINGS.hours_end} ET): ` +
        `${error.message || error}`,
    );
    return { ...DEFAULT_SETTINGS };
  }

  const out = { ...DEFAULT_SETTINGS };
  const seen = new Set();
  for (const r of data ?? []) {
    if (seen.has(r.setting_key)) continue;
    if (r.effective_from && r.effective_from > today) continue;
    seen.add(r.setting_key);
    switch (r.setting_key) {
      case SETTING_KEYS.enabled:
        out.enabled = parseBoolean(r.setting_value);
        break;
      case SETTING_KEYS.operating_days:
        out.operating_days = parseJsonArray(r.setting_value);
        break;
      case SETTING_KEYS.hours_start:
        out.hours_start = parseTime(r.setting_value, DEFAULT_SETTINGS.hours_start);
        break;
      case SETTING_KEYS.hours_end:
        out.hours_end = parseTime(r.setting_value, DEFAULT_SETTINGS.hours_end);
        break;
      case SETTING_KEYS.daily_cap:
        out.daily_cap = parseNumber(r.setting_value, DEFAULT_SETTINGS.daily_cap);
        break;
      case SETTING_KEYS.monthly_cap:
        out.monthly_cap = parseNumber(r.setting_value, DEFAULT_SETTINGS.monthly_cap);
        break;
      case SETTING_KEYS.blocked_dates:
        out.blocked_dates = parseJsonArray(r.setting_value).filter(
          (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s),
        );
        break;
      case SETTING_KEYS.default_from_number:
        out.default_from_number = String(r.setting_value ?? '').trim();
        break;
      case SETTING_KEYS.max_concurrent:
        // Floor of 1: a zero/garbage value must pause-by-cap visibly, not
        // divide the loop's semantics — and never raise the cap by accident.
        out.max_concurrent = Math.max(
          1,
          Math.round(parseNumber(r.setting_value, DEFAULT_SETTINGS.max_concurrent)),
        );
        break;
    }
  }
  return out;
}

// Insert any missing retell_* settings rows with task defaults. Idempotent.
async function ensureDefaultSettings() {
  const { data, error } = await supabase
    .from('agency_settings')
    .select('setting_key')
    .in('setting_key', Object.values(SETTING_KEYS));
  if (error) throw new Error(`ensureDefaultSettings(read): ${error.message}`);

  const present = new Set((data ?? []).map((r) => r.setting_key));
  const toInsert = [];
  const serialize = (key) => {
    switch (key) {
      case SETTING_KEYS.enabled:
        return String(DEFAULT_SETTINGS.enabled);
      case SETTING_KEYS.operating_days:
        return JSON.stringify(DEFAULT_SETTINGS.operating_days);
      case SETTING_KEYS.hours_start:
        return DEFAULT_SETTINGS.hours_start;
      case SETTING_KEYS.hours_end:
        return DEFAULT_SETTINGS.hours_end;
      case SETTING_KEYS.daily_cap:
        return String(DEFAULT_SETTINGS.daily_cap);
      case SETTING_KEYS.monthly_cap:
        return String(DEFAULT_SETTINGS.monthly_cap);
      case SETTING_KEYS.blocked_dates:
        return JSON.stringify(DEFAULT_SETTINGS.blocked_dates);
      case SETTING_KEYS.default_from_number:
        return DEFAULT_SETTINGS.default_from_number;
      case SETTING_KEYS.max_concurrent:
        return String(DEFAULT_SETTINGS.max_concurrent);
      default:
        return '';
    }
  };
  for (const key of Object.values(SETTING_KEYS)) {
    if (present.has(key)) continue;
    toInsert.push({
      setting_key: key,
      setting_value: serialize(key),
      value_type: SETTING_VALUE_TYPES[key] || 'String',
      description: 'Retell dialer default (seeded by retell-scheduler)',
    });
  }
  if (toInsert.length === 0) return 0;

  const { error: insErr } = await supabase.from('agency_settings').insert(toInsert);
  if (insErr) throw new Error(`ensureDefaultSettings(insert): ${insErr.message}`);
  console.log(`[retell-scheduler] seeded ${toInsert.length} default agency_settings key(s)`);
  return toInsert.length;
}

async function countInProgress() {
  const { count, error } = await supabase
    .from('retell_call_queue')
    .select('id', { count: 'exact', head: true })
    .eq('dialer_status', 'In_Progress');
  if (error) throw new Error(`countInProgress: ${error.message}`);
  return count ?? 0;
}

// B1: reset In_Progress rows the webhook never resolved (see STALE_CALL_TTL_MS
// comment up top). Counters stay as markInProgress left them — the attempt was
// genuinely placed — and next_attempt_at gets a short buffer so the reaped row
// doesn't immediately outrank the rest of the queue. Mirrors the dispatcher's
// orphan-reaper pattern. Best-effort: a reap failure logs and never blocks the
// tick (the row just stays stuck until the next sweep).
async function reapStaleInProgress(now) {
  const ts = now ?? new Date();
  try {
    const cutoff = new Date(ts.getTime() - STALE_CALL_TTL_MS).toISOString();
    const { data: stale, error } = await supabase
      .from('retell_call_queue')
      .select('id, provider_call_id, updated_at')
      .eq('dialer_status', 'In_Progress')
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(STALE_REAP_CAP);
    if (error) throw new Error(error.message);
    if (!stale || stale.length === 0) return 0;
    let reaped = 0;
    for (const row of stale) {
      const { error: updErr } = await supabase
        .from('retell_call_queue')
        .update({
          dialer_status: 'Pending',
          next_attempt_at: new Date(ts.getTime() + STALE_REAP_BUFFER_MS).toISOString(),
          updated_at: ts.toISOString(),
        })
        .eq('id', row.id)
        .eq('dialer_status', 'In_Progress'); // races with a late webhook lose politely
      if (updErr) {
        console.error(`[retell-scheduler] B1 reap failed for queue ${row.id}: ${updErr.message}`);
        continue;
      }
      reaped += 1;
      console.warn(
        `[retell-scheduler] B1 reaped stale In_Progress queue ${row.id} ` +
          `(call ${row.provider_call_id || '-'}, stuck since ${row.updated_at}) -> Pending`,
      );
    }
    return reaped;
  } catch (err) {
    console.error(`[retell-scheduler] B1 reaper error: ${err.message || err}`);
    return 0;
  }
}

async function spendToday() {
  const { data, error } = await supabase.rpc('get_retell_spend_today');
  if (error) throw new Error(`get_retell_spend_today: ${error.message}`);
  return Number(data ?? 0);
}

async function spendMonth() {
  const { data, error } = await supabase.rpc('get_retell_spend_month');
  if (error) throw new Error(`get_retell_spend_month: ${error.message}`);
  return Number(data ?? 0);
}

// Columns every dial path needs (buildCallPayload, getTier, markInProgress).
// Shared by the normal queue poll and the Task 21 callback fast-path.
const QUEUE_DIAL_COLUMNS =
  'id, contact_name, phone_e164, assigned_agent, from_number, segment, ' +
  'product_interest, retry_count, max_retries, daily_attempt_count, ' +
  'monthly_attempt_count, total_attempt_count, max_daily_attempts, ' +
  'max_monthly_attempts, max_total_attempts, last_attempt_at, cool_down_hours, ' +
  'lead_timezone, lead_created_at, created_at, source, disposition, ' +
  'last_attempt_hour, vm_count, callback_scheduled_at, ' +
  'lead_context, external_lead_id, cnam_name';

// Age-only re-score. MUST mirror the age buckets of scoreLead() in server.js,
// minus its weekend-deferral branch (re-scoring an existing Pending lead must
// not re-defer it). Returns the priority_score a lead of this age would earn at
// ingest right now, or null if we can't tell its age.
function ageBucketScore(leadCreatedAtMs, nowMs) {
  if (!leadCreatedAtMs) return null;
  const ageMin = (nowMs - leadCreatedAtMs) / 60000;
  const ageHrs = ageMin / 60;
  const ageDays = ageHrs / 24;
  if (ageMin < 5) return 100;
  if (ageMin < 30) return 95;
  if (ageHrs < 8) return 60;
  // 8–24h must outrank the 1–3d bucket — freshness is monotonic (newer = higher
  // priority). 50 is already a RESCORE_DECAY_SET member so the sweep decays into
  // and out of it cleanly. MUST stay in lockstep with scoreLead() in server.js.
  if (ageHrs < 24) return 50;
  if (ageDays <= 3) return 40;
  return 20;
}

// Decay stale priority_score on Pending leads toward their current-age bucket so
// the speed-to-lead ordering in fetchCandidateLeads() reflects real freshness.
// DECAY-ONLY: a row is updated only when its age-bucket score is strictly LOWER
// than its stored score, and the UPDATE re-asserts (dialer_status='Pending' AND
// priority_score in the decay set) so a concurrent engagement bump (→90) or a
// row that just went In_Progress between the read and the write is never
// clobbered. priority_score is the ONLY column touched (next_attempt_at and all
// cadence/cooldown state are left exactly as-is).
async function rescoreStalePendingLeads(now) {
  const nowMs = (now ?? new Date()).getTime();
  const { data, error } = await supabase
    .from('retell_call_queue')
    .select('id, lead_created_at, priority_score')
    .eq('dialer_status', 'Pending')
    .in('priority_score', RESCORE_DECAY_SET)
    // Oldest-first so that if the queue ever exceeds the cap, the most stale
    // (most in need of decay) rows are processed this cycle, not left behind.
    .order('lead_created_at', { ascending: true, nullsFirst: false })
    .limit(5000);
  if (error) {
    console.error(`[retell-scheduler] freshness sweep query error: ${error.message}`);
    return { rescored: 0 };
  }
  const byNewScore = new Map();
  for (const row of data || []) {
    const created = row.lead_created_at ? new Date(row.lead_created_at).getTime() : null;
    const next = ageBucketScore(created, nowMs);
    if (next == null || next >= row.priority_score) continue; // decay only
    if (!byNewScore.has(next)) byNewScore.set(next, []);
    byNewScore.get(next).push(row.id);
  }
  let rescored = 0;
  for (const [score, ids] of byNewScore) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error: upErr } = await supabase
        .from('retell_call_queue')
        .update({ priority_score: score, updated_at: new Date().toISOString() })
        .in('id', chunk)
        .eq('dialer_status', 'Pending')
        .in('priority_score', RESCORE_DECAY_SET);
      if (upErr) {
        console.error(`[retell-scheduler] freshness sweep update error: ${upErr.message}`);
        continue;
      }
      rescored += chunk.length;
    }
  }
  if (rescored > 0) {
    console.log(`[retell-scheduler] freshness sweep: decayed priority_score on ${rescored} stale Pending lead(s)`);
  }
  return { rescored };
}

// Highest-priority, oldest-first batch of eligible Pending rows that are due
// and compliant. PostgREST cannot express the column-vs-column attempt caps or
// the cool_down_hours interval, so those (and the authoritative is_lead_callable
// gate) are applied per-row in tick(); this query handles the parts PostgREST
// CAN express, then orders by priority_score DESC, lead_created_at ASC.
async function fetchCandidateLeads() {
  const q = supabase
    .from('retell_call_queue')
    .select(QUEUE_DIAL_COLUMNS)
    .eq('dialer_status', 'Pending')
    .lte('next_attempt_at', new Date().toISOString());
  // Consent / DNC / calling-window enforcement is owned by the compliance module
  // (compliance.checkLead, applied per-row in tick()), OFF by default so the bare
  // starter dials every due Pending lead. The authoritative frequency/cooldown
  // gate (is_lead_callable) is still applied per-row.

  const { data, error } = await q
    // Speed-to-lead ordering (grilled 2026-06-16):
    //   1. priority_score DESC — a manual "call now" (dashboard sets priority 100)
    //      jumps the queue. Starvation-SAFE now: the next_attempt_at cool-down
    //      floor (PR #388) keeps cool-down-blocked rows OUT of this fetch, so a
    //      high score can no longer pin an un-callable row to the batch head.
    //   2. total_attempt_count ASC — never-called leads win, so a fresh lead is
    //      never stuck behind redials.
    //   3. lead_created_at DESC — newest form-submission first within a bucket.
    .order('priority_score', { ascending: false, nullsFirst: false })
    .order('total_attempt_count', { ascending: true, nullsFirst: true })
    .order('lead_created_at', { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_BATCH_SIZE);
  if (error) throw new Error(`fetchCandidateLeads: ${error.message}`);
  return data ?? [];
}

// --- Task 21: callback fast-path -------------------------------------------
// Due callbacks (dialer_status='Callback_Scheduled', callback_scheduled_at in the
// past) are honored BEFORE the normal queue and may fire even while a normal call
// is mid-dial — the single exception to the one-call-at-a-time rule. Compliance
// is unchanged: prior express consent is required, the lead-local 09:00–20:00
// calling window still gates the dial, and (by default) the DNC scrub flag too.
async function fetchDueCallbacks(now) {
  const q = supabase
    .from('retell_call_queue')
    .select(QUEUE_DIAL_COLUMNS)
    .eq('dialer_status', 'Callback_Scheduled')
    .lte('callback_scheduled_at', (now ?? new Date()).toISOString());
  // Consent / DNC / calling-window enforcement is owned by the compliance module
  // (applied per-row before the callback dial below), OFF by default.

  const { data, error } = await q
    .order('callback_scheduled_at', { ascending: true })
    .limit(CANDIDATE_BATCH_SIZE);
  if (error) throw new Error(`fetchDueCallbacks: ${error.message}`);
  return data ?? [];
}

// Callbacks in flight. Once a callback fires it becomes a normal In_Progress
// call but keeps disposition='Callback', so this counts callback-origin calls.
// Used to keep at most ONE callback mid-dial (two due at once queue sequentially).
async function countInProgressCallbacks() {
  const { count, error } = await supabase
    .from('retell_call_queue')
    .select('id', { count: 'exact', head: true })
    .eq('dialer_status', 'In_Progress')
    .eq('disposition', 'Callback');
  if (error) throw new Error(`countInProgressCallbacks: ${error.message}`);
  return count ?? 0;
}

// A callback whose window was missed by >24h is no longer an appointment: it
// drops to a low-priority data lead. disposition stays 'Callback' so getTier
// keeps it on the conservative Tier 3 cadence (Tier 4 reuses the Tier 3 shape).
async function downgradeMissedCallback(record, now) {
  const ts = (now ?? new Date()).toISOString();
  const { error } = await supabase
    .from('retell_call_queue')
    .update({
      dialer_status: 'Pending',
      callback_scheduled_at: null,
      callback_confirmed: false,
      priority_score: 20,
      next_attempt_at: ts,
      updated_at: ts,
    })
    .eq('id', record.id);
  if (error) throw new Error(`downgradeMissedCallback: ${error.message}`);
  console.log(
    `[retell-scheduler] callback for ${record.contact_name || record.id} missed by >24h ` +
      '-> downgraded to Tier 3 data lead',
  );
}

// Try to place ONE due callback this cycle. Returns true when a call was placed
// (the caller then skips the normal queue for this cycle). Missed (>24h) callbacks
// are downgraded in passing; callbacks outside the lead's local hours are skipped.
async function tryFireDueCallback(settings, now) {
  const nowD = now ?? new Date();
  const due = await fetchDueCallbacks(nowD);
  if (due.length === 0) return false;

  let spendChecked = false;
  for (const cb of due) {
    const scheduledMs = new Date(cb.callback_scheduled_at).getTime();
    if (Number.isNaN(scheduledMs)) continue;
    const tz = cb.lead_timezone || DEFAULT_LEAD_TZ;

    // Missed appointment window (>24h late) → drop to a data lead, move on.
    if (nowD.getTime() - scheduledMs > CALLBACK_MISS_GRACE_MS) {
      await downgradeMissedCallback(cb, nowD);
      continue;
    }
    // TCPA / FL mini-TCPA: only dial inside the lead's local 09:00–20:00 window.
    if (!withinCallingHours(tz, nowD)) {
      logSkip(`Callback for ${cb.contact_name || cb.id} due but outside calling hours in ${tz}`);
      continue;
    }
    // Compliance gate (DNC + calling window). OFF by default -> pass-through.
    const cbCompliance = await compliance.checkLead(cb, complianceSettings(settings));
    if (!cbCompliance.ok) {
      logSkip(`Callback for ${cb.contact_name || cb.id} held — compliance (${cbCompliance.reason})`);
      continue;
    }
    // Spend caps still bound callbacks. Checked once, lazily — only when there is
    // actually a callback ready to place.
    if (!spendChecked) {
      const today = await spendToday();
      if (today >= settings.daily_cap) {
        noteState('cap_daily', `spend $${today.toFixed(2)} >= daily cap $${settings.daily_cap.toFixed(2)} (callback held)`);
        return false;
      }
      const month = await spendMonth();
      if (month >= settings.monthly_cap) {
        noteState('cap_monthly', `spend $${month.toFixed(2)} >= monthly cap $${settings.monthly_cap.toFixed(2)} (callback held)`);
        return false;
      }
      spendChecked = true;
    }
    // At most one callback mid-dial: a second due callback waits its turn.
    if ((await countInProgressCallbacks()) > 0) {
      noteState('callback_in_progress', 'a callback is already mid-dial; queueing the next sequentially');
      return false;
    }
    const fromNumber = String(cb.from_number || config.retell.fromNumber || settings.default_from_number || '').trim();
    if (!fromNumber) {
      noteState('no_from_number', 'set RETELL_FROM_NUMBER / retell_default_from_number or row from_number (callback)');
      return false;
    }

    const tier = getTier(cb, nowD); // disposition='Callback' -> 4 (Tier 3 cadence)
    console.log(
      `[retell-scheduler] CALLBACK DUE: ${cb.contact_name || cb.id} scheduled for ${cb.callback_scheduled_at}`,
    );
    lastSkipLog = null; // a real dial re-arms skip-log dedupe
    await dial(cb, fromNumber, tier);
    return true; // one callback placed; do not also run the normal queue this cycle
  }
  return false;
}

// Authoritative DB gate — is_lead_callable(p_queue_id) checks ALL frequency
// limits (daily/monthly/total caps + cool-down) server-side. Fail-safe: any RPC
// error returns false so a gate failure never produces an out-of-policy dial.
async function isLeadCallable(id) {
  const { data, error } = await supabase.rpc('is_lead_callable', { p_queue_id: id });
  if (error) {
    console.error(`[retell-scheduler] is_lead_callable(${id}) error: ${error.message}`);
    return false;
  }
  return data === true;
}

// Retire a lead that has reached its lifetime attempt cap without converting.
async function retireMaxAttempts(record, lifetimeCap) {
  const cap = lifetimeCap ?? record.max_total_attempts ?? 10;
  const { error } = await supabase
    .from('retell_call_queue')
    .update({ dialer_status: 'Max_Attempts_Reached', updated_at: new Date().toISOString() })
    .eq('id', record.id);
  if (error) throw new Error(`retireMaxAttempts: ${error.message}`);
  console.log(
    `[retell-scheduler] queue ${record.id} -> Max_Attempts_Reached ` +
      `(${record.total_attempt_count ?? 0}/${cap} attempts)`,
  );
}

// Mark a row In_Progress AND record the attempt: increment the daily/monthly/
// total counters and stamp last_attempt_at. Counter increments are computed
// from the fetched snapshot (safe under the one-call-at-a-time invariant —
// nothing else dials, so no concurrent counter writer exists).
//
// Task 15: also stamp last_attempt_hour (lead-local) for time-of-day rotation,
// pre-set next_attempt_at from the tier cadence (a safety default the webhook
// may refine on resolution), and re-stamp the tier's frequency caps so a
// decayed lead's stored columns track its current tier (keeps is_lead_callable
// and the dashboard consistent with the live cadence).
async function markInProgress(record, callId, tier, now) {
  const ts = now ?? new Date();
  const cfg = tierConfig(tier);
  const tz = record.lead_timezone || 'America/New_York';
  // getNextAttemptTime treats daily_attempt_count as "attempts today including
  // the one just placed", so advance the snapshot before computing.
  const afterAttempt = {
    ...record,
    daily_attempt_count: (record.daily_attempt_count ?? 0) + 1,
    last_attempt_hour: currentHourInTz(tz, ts),
  };
  const { error } = await supabase
    .from('retell_call_queue')
    .update({
      dialer_status: 'In_Progress',
      provider_call_id: callId,
      daily_attempt_count: afterAttempt.daily_attempt_count,
      monthly_attempt_count: (record.monthly_attempt_count ?? 0) + 1,
      total_attempt_count: (record.total_attempt_count ?? 0) + 1,
      last_attempt_at: ts.toISOString(),
      last_attempt_hour: afterAttempt.last_attempt_hour,
      next_attempt_at: getNextAttemptTime(afterAttempt, tier, ts),
      max_daily_attempts: cfg.max_daily_attempts,
      max_monthly_attempts: cfg.max_monthly_attempts,
      max_total_attempts: cfg.max_total_attempts,
      cool_down_hours: cfg.cool_down_hours,
      updated_at: ts.toISOString(),
    })
    .eq('id', record.id);
  if (error) throw new Error(`markInProgress: ${error.message}`);
}

async function markTerminalFailure(id, reason) {
  const { error } = await supabase
    .from('retell_call_queue')
    .update({ dialer_status: TERMINAL_FAILURE_STATUS, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`markTerminalFailure: ${error.message}`);
  console.error(`[retell-scheduler] queue ${id} -> ${TERMINAL_FAILURE_STATUS}: ${reason}`);
}

// Transient give-up: bump retry_count and defer; retire to terminal once the
// row's own max_retries budget is spent.
async function deferTransient(record, reason) {
  const nextRetry = (record.retry_count ?? 0) + 1;
  if (nextRetry >= (record.max_retries ?? 3)) {
    await markTerminalFailure(record.id, `${reason} (max_retries exhausted)`);
    return;
  }
  const next = new Date(Date.now() + TRANSIENT_DEFER_MS).toISOString();
  const { error } = await supabase
    .from('retell_call_queue')
    .update({ retry_count: nextRetry, next_attempt_at: next, updated_at: new Date().toISOString() })
    .eq('id', record.id);
  if (error) throw new Error(`deferTransient: ${error.message}`);
  console.warn(`[retell-scheduler] queue ${record.id} deferred (${reason}); attempt ${nextRetry}`);
}

// Fire one create-phone-call, applying the spec's per-status retry policy.
// Returns one of:
//   { outcome: 'ok', callId }
//   { outcome: 'client_error', status, body }   -> terminal failure
//   { outcome: 'rate_limit' | 'server' | 'network' }  -> transient give-up
async function createPhoneCall(record, fromNumber) {
  const body = JSON.stringify(buildCallPayload(record, fromNumber, RETELL_AGENT_ID));
  let rate = 0;
  let server = 0;
  let net = 0;

  while (running) {
    let resp;
    try {
      resp = await fetch(RETELL_CREATE_CALL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RETELL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (netErr) {
      net += 1;
      console.error(`[retell-scheduler] network error (attempt ${net}): ${netErr.message}`);
      if (net > MAX_NETWORK_RETRIES) return { outcome: 'network' };
      await sleep(NETWORK_BACKOFF_MS);
      continue;
    }

    if (resp.ok) {
      const json = await resp.json().catch(() => ({}));
      if (!json.call_id) return { outcome: 'client_error', status: resp.status, body: 'missing call_id in response' };
      return { outcome: 'ok', callId: json.call_id };
    }

    if (resp.status === 429) {
      rate += 1;
      if (rate > MAX_RATE_LIMIT_RETRIES) return { outcome: 'rate_limit' };
      console.warn(`[retell-scheduler] 429 rate limited (attempt ${rate}); waiting 10s`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      continue;
    }

    if (resp.status >= 500) {
      server += 1;
      const txt = await resp.text().catch(() => '');
      console.error(`[retell-scheduler] ${resp.status} server error (attempt ${server}): ${txt}`);
      if (server > MAX_SERVER_RETRIES) return { outcome: 'server' };
      await sleep(SERVER_BACKOFF_MS);
      continue;
    }

    // Any other 4xx — hard rejection, do not retry.
    const txt = await resp.text().catch(() => '');
    return { outcome: 'client_error', status: resp.status, body: txt };
  }
  return { outcome: 'network' }; // shutting down mid-retry
}

async function dial(record, fromNumber, tier) {
  // RD.13: the dynamic lead_name we hand Retell is the queue row's contact_name
  // (mapped to "there" for empty/NULL/"Unknown", or an ALL-CAPS CNAM line-owner
  // name — resolveLeadName), so the log shows exactly what the agent will say and
  // matches the payload buildCallPayload sends.
  const leadName = resolveLeadName(record);
  console.log(`[retell-scheduler] dynamic lead_name=${leadName} for queue_id=${record.id}`);
  const result = await createPhoneCall(record, fromNumber);
  switch (result.outcome) {
    case 'ok':
      await markInProgress(record, result.callId, tier);
      console.log(`[retell-scheduler] dialing queue ${record.id} (tier ${tier}) -> call ${result.callId}`);
      return;
    case 'client_error':
      await markTerminalFailure(record.id, `Retell ${result.status}: ${result.body}`);
      return;
    case 'rate_limit':
    case 'server':
    case 'network':
      await deferTransient(record, `Retell ${result.outcome}`);
      return;
    default:
      await deferTransient(record, 'unknown outcome');
  }
}

// One scheduling cycle. Every early return is a "sleep and re-check" gate.
async function tick() {
  const settings = await loadSettings();

  // B1: queue hygiene runs every tick regardless of any gate below — a stuck
  // In_Progress row must clear even while the dialer is paused, so flipping
  // the toggle later never lands on a deadlocked queue.
  await reapStaleInProgress(new Date());

  if (!settings.enabled) {
    noteState('paused', 'master toggle OFF (retell_dialer_enabled)');
    return;
  }

  const now = new Date();

  // Task 21: due callbacks are honored FIRST and may fire even while a normal
  // call is in progress (the one exception to max_concurrent=1). They are gated
  // only by consent + the lead's local calling hours (+ spend caps), NOT by the
  // agency operating window — the lead chose the time. If one fires, we are done
  // for this cycle.
  if (await tryFireDueCallback(settings, now)) return;

  const window = evaluateWindow(settings, now);
  if (!window.open) {
    noteState(window.reason, window.detail);
    return;
  }

  // Concurrency cap (B1: now honors retell_max_concurrent — live value 1, so
  // behavior is unchanged: one call at a time, the webhook resolves
  // In_Progress rows and the reaper above clears the ones it never does).
  const inProgress = await countInProgress();
  if (inProgress >= settings.max_concurrent) {
    noteState('in_progress', `${inProgress}/${settings.max_concurrent} call(s) mid-dial; waiting for webhook`);
    return;
  }

  // Spend caps — daily then monthly. >= cap stops dialing this cycle.
  const today = await spendToday();
  if (today >= settings.daily_cap) {
    noteState('cap_daily', `spend $${today.toFixed(2)} >= daily cap $${settings.daily_cap.toFixed(2)}`);
    return;
  }
  const month = await spendMonth();
  if (month >= settings.monthly_cap) {
    noteState('cap_monthly', `spend $${month.toFixed(2)} >= monthly cap $${settings.monthly_cap.toFixed(2)}`);
    return;
  }

  // Freshness-decay sweep (speed-to-lead): collapse stale high scores so a fresh
  // form-submit wins the queue head instead of a weeks-old lead frozen at 100.
  // Throttled to RESCORE_INTERVAL_MS; a failure here must never block dialing.
  if (now.getTime() - lastRescoreMs >= RESCORE_INTERVAL_MS) {
    lastRescoreMs = now.getTime();
    try {
      await rescoreStalePendingLeads(now);
    } catch (e) {
      console.error('[retell-scheduler] freshness sweep threw (non-fatal)', e && e.message);
    }
  }

  const candidates = await fetchCandidateLeads();
  if (candidates.length === 0) {
    noteState('idle', 'no eligible Pending leads');
    return;
  }

  // Walk the priority-ordered batch and pick the first lead that clears every
  // contact-frequency, timezone, and from-number gate. We dial only ONE. Each
  // lead's TIER (Task 15) supplies its caps + cool-down, so the cadence is
  // authoritative even if the row's stored max_* columns are stale (decay).
  let chosen = null;
  let chosenFrom = null;
  let chosenTier = null;
  for (const rec of candidates) {
    const tier = getTier(rec, now);
    const cfg = tierConfig(tier);
    // Lifetime cap reached → retire so it is never dialed again, then move on.
    if ((rec.total_attempt_count ?? 0) >= cfg.max_total_attempts) {
      await retireMaxAttempts(rec, cfg.max_total_attempts);
      continue;
    }
    // App-level frequency safety net (mirrors the DB gate; cheap, no round-trip).
    if (!withinTierLimits(rec, cfg) || !coolDownElapsedHours(rec, cfg.cool_down_hours, now)) continue;
    // Authoritative DB gate — checks ALL limits server-side.
    if (!(await isLeadCallable(rec.id))) continue;
    // TCPA: only dial inside the lead's local 09:00–20:00 window.
    const tz = rec.lead_timezone || DEFAULT_LEAD_TZ;
    if (!withinCallingHours(tz, now)) {
      logSkip(`Skipping ${rec.contact_name || rec.id} — outside calling hours in ${tz}`);
      continue;
    }
    const fromNumber = String(rec.from_number || config.retell.fromNumber || settings.default_from_number || '').trim();
    if (!fromNumber) {
      noteState('no_from_number', 'set RETELL_FROM_NUMBER / retell_default_from_number or row from_number');
      continue;
    }
    // Compliance gate (DNC + calling window). OFF by default -> pass-through, so
    // the bare starter dials every eligible lead. Enable the compliance module to
    // enforce DNC + the lead's local calling window at the application layer.
    const cc = await compliance.checkLead(rec, complianceSettings(settings));
    if (!cc.ok) {
      logSkip(`Skipping ${rec.contact_name || rec.id} — compliance (${cc.reason})`);
      continue;
    }
    chosen = rec;
    chosenFrom = fromNumber;
    chosenTier = tier;
    break;
  }

  if (!chosen) {
    noteState('idle', 'no callable lead this cycle (caps / cool-down / calling hours)');
    return;
  }

  lastSkipLog = null; // a real dial re-arms skip-log dedupe
  noteState('active', `ET ${window.detail.replace('ET ', '')} — dialing`);
  await dial(chosen, chosenFrom, chosenTier);
}

// Tier decay (Task 15 step 7): any Tier 1 lead whose lead_created_at is now more
// than 30 days old is downgraded to Tier 3 frequency caps. Scoped to rows still
// carrying Tier 1 caps (max_total_attempts = 30) so re-running is cheap and
// idempotent. getTier already dials these as Tier 3 the moment they age out;
// this keeps the STORED columns (and is_lead_callable / dashboard) in sync.
async function downgradeDecayedTier1Leads(now) {
  const cutoffIso = new Date((now ?? new Date()).getTime() - 30 * 24 * 3600_000).toISOString();
  const t3 = tierConfig(3);
  const { data, error } = await supabase
    .from('retell_call_queue')
    .update({
      max_daily_attempts: t3.max_daily_attempts,
      max_monthly_attempts: t3.max_monthly_attempts,
      max_total_attempts: t3.max_total_attempts,
      cool_down_hours: t3.cool_down_hours,
      updated_at: new Date().toISOString(),
    })
    .in('source', String(process.env.REALTIME_SOURCES || 'webhook,api').split(',').map((s) => s.trim()))
    .eq('max_total_attempts', TIER_CONFIG[1].max_total_attempts)
    .lt('lead_created_at', cutoffIso)
    .select('id');
  if (error) {
    console.error(`[retell-scheduler] tier-decay sweep error: ${error.message}`);
    return;
  }
  const n = data?.length ?? 0;
  if (n > 0) console.log(`[retell-scheduler] tier decay: ${n} Tier 1 lead(s) -> Tier 3 caps (>30d old)`);
}

// Run any due counter resets (daily at ET midnight, monthly on the 1st of an ET
// month) via the Supabase RPCs. resetState advances even on RPC error so we do
// not hammer a failing RPC every minute; the next rollover re-arms it. The daily
// rollover also runs the Tier 1 -> Tier 3 decay sweep.
async function runResetsIfDue(now) {
  const { actions, next } = computeResetActions(now ?? new Date(), resetState);
  resetState = next;
  if (actions.daily) {
    const { error } = await supabase.rpc('reset_daily_attempt_counts');
    if (error) console.error(`[retell-scheduler] reset_daily_attempt_counts error: ${error.message}`);
    else console.log('[retell-scheduler] daily attempt counts reset (ET midnight)');
    await downgradeDecayedTier1Leads(now);
  }
  if (actions.monthly) {
    const { error } = await supabase.rpc('reset_monthly_attempt_counts');
    if (error) console.error(`[retell-scheduler] reset_monthly_attempt_counts error: ${error.message}`);
    else console.log('[retell-scheduler] monthly attempt counts reset (ET 1st of month)');
  }
}

// Arm the once-a-minute boundary watcher for the daily/monthly resets. Seeds
// resetState to the current ET day/month so resets fire on rollover, not boot.
function startResetSchedulers() {
  const { date } = etParts(new Date());
  resetState = { lastDailyResetDate: date, lastMonthlyResetMonth: date.slice(0, 7) };
  resetTimer = setInterval(() => {
    runResetsIfDue().catch((err) =>
      console.error('[retell-scheduler] reset watcher error:', err.message),
    );
  }, RESET_WATCH_INTERVAL_MS);
  if (resetTimer.unref) resetTimer.unref();
  console.log('[retell-scheduler] reset watcher armed (daily @ ET midnight, monthly @ ET 1st)');
}

async function mainLoop() {
  console.log(
    `[retell-scheduler] started; poll ${POLL_INTERVAL_MS}ms, ` +
      `compliance module ${compliance.enabled ? 'ENABLED' : 'off'}, operating hours from agency_settings ` +
      `(per-lead window ${LEAD_HOURS_START}–${LEAD_HOURS_END} lead-local)`,
  );
  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error('[retell-scheduler] tick error:', err.message);
    }
    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }
  console.log('[retell-scheduler] stopped');
}

function shutdown(signal) {
  console.log(`[retell-scheduler] ${signal} received; finishing current cycle`);
  running = false;
  if (resetTimer) {
    clearInterval(resetTimer);
    resetTimer = null;
  }
}

async function main() {
  const missing = [
    ['SUPABASE_URL', config.supabase.url],
    ['SUPABASE_SERVICE_ROLE_KEY', config.supabase.serviceRoleKey],
    ['RETELL_API_KEY', RETELL_API_KEY],
    ['RETELL_AGENT_ID', RETELL_AGENT_ID],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`[retell-scheduler] missing config/env: ${missing.join(', ')}`);
    process.exit(1);
  }

  // The supabase client is owned by the leadSource adapter — all retell_call_*
  // reads/writes below share it (assigned here so the module-level helpers and
  // the test hook __setSupabaseForTests point at the same client).
  supabase = leadSource.client;

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await ensureDefaultSettings();
  } catch (err) {
    console.error('[retell-scheduler] could not seed defaults:', err.message);
    process.exit(1);
  }
  startResetSchedulers();
  await mainLoop();
}

if (require.main === module) {
  main();
}

module.exports = {
  parseBoolean,
  parseJsonArray,
  parseTime,
  parseNumber,
  parseOperatingDays,
  etParts,
  evaluateWindow,
  hhmmInTimeZone,
  withinCallingHours,
  withinCountLimits,
  isOverTotalCap,
  coolDownElapsed,
  withinTierLimits,
  coolDownElapsedHours,
  computeResetActions,
  // Age-only freshness re-score bucket (must mirror scoreLead() in server.js).
  ageBucketScore,
  // B1 — stale In_Progress reaper.
  reapStaleInProgress,
  STALE_CALL_TTL_MS,
  __setSupabaseForTests: (client) => { supabase = client; },
  firstName,
  nameMatchesCnam,
  isAllCapsName,
  resolveLeadName,
  agentDisplayName,
  buildCallPayload,
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  SETTING_VALUE_TYPES,
  DEFAULT_LEAD_TZ,
  LEAD_HOURS_START,
  LEAD_HOURS_END,
  CALLBACK_MISS_GRACE_MS,
  QUEUE_DIAL_COLUMNS,
};

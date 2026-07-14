// Dialer feature — types and constants. Mirrors the
// retell_call_queue / retell_call_log shapes used by the voice dialer worker
// and the agency_settings key names that drive runtime behavior.

export type DialerStatus =
  | 'Pending'
  | 'In_Progress'
  | 'Completed'
  | 'Voicemail'
  | 'DNC'
  | 'No_Answer'
  | 'Skipped'
  | 'Removed';

export const DIALER_STATUSES: DialerStatus[] = [
  'Pending',
  'In_Progress',
  'Completed',
  'Voicemail',
  'DNC',
  'No_Answer',
  'Skipped',
  'Removed',
];

/** 1..3 map to the configured tier labels; 4 is Other/uncategorized. Derived —
 *  there is no `tier` column on retell_call_queue; see deriveTier() in
 *  queries.ts. */
export type DialerTier = 1 | 2 | 3 | 4;

/** JSONB enrichment blob on retell_call_queue.lead_context. Carries
 *  survey-origin fields surfaced in the dialer queue table and passed through
 *  to the voice provider as dynamic variables. All fields optional — older
 *  rows may have a partial or null blob. */
export type LeadContext = {
  source_survey?: string | null;
};

export type QueueRow = {
  id: string;
  contact_name: string;
  phone_e164: string;
  dialer_status: string;
  source: string;
  assigned_agent: string | null;
  priority_score: number;
  next_attempt_at: string;
  created_at: string;
  segment: string | null;
  product_interest: string | null;
  lead_context: LeadContext | null;
  // Retry/attempt accounting.
  tier: DialerTier;
  daily_attempt_count: number;
  monthly_attempt_count: number;
  total_attempt_count: number;
  max_daily_attempts: number;
  max_monthly_attempts: number;
  max_total_attempts: number;
  cool_down_hours: number;
  vm_count: number;
  last_attempt_at: string | null;
  consent_verified: boolean;
  dnc_checked: boolean;
  /** True once the row can no longer be dialed — attempt or VM cap reached. */
  exhausted: boolean;
};

// A call the dialer is on RIGHT NOW — a queue row in the In_Progress state.
// Drives the live-calls board (read-only from existing tables; no transcript).
export type ActiveCall = {
  id: string;
  contact_name: string | null;
  segment: string | null;
  product_interest: string | null;
  phone_e164: string | null;
  from_number: string | null;
  assigned_agent: string | null;
  provider_call_id: string | null;
  last_attempt_at: string | null;
};

export type CallDirection = 'inbound' | 'outbound';

export type CallHistoryRow = {
  id: string;
  provider_call_id: string;
  queue_id: string | null;
  created_at: string;
  duration_seconds: number | null;
  cost_cents: number | null;
  bant_score: number | null;
  disposition: string | null;
  sentiment: string | null;
  recording_url: string | null;
  transcript: string | null;
  call_summary: string | null;
  from_number: string | null;
  to_number: string;
  call_direction: string;
  disconnection_reason: string | null;
  transferred_to_agent: boolean | null;
  transfer_outcome: string | null;
  // Joined from queue when queue_id is present.
  contact_name: string | null;
  dnc_flagged: boolean;
};

export type DialerSettings = {
  enabled: boolean;
  operating_days: number[]; // 0=Sun..6=Sat
  hours_start: string; // "HH:MM"
  hours_end: string; // "HH:MM"
  daily_cap: number;
  monthly_cap: number;
  blocked_dates: string[]; // ISO yyyy-mm-dd strings
};

export const DEFAULT_DIALER_SETTINGS: DialerSettings = {
  enabled: false,
  operating_days: [1, 2, 3, 4, 5], // Mon-Fri
  hours_start: '09:00',
  hours_end: '18:00',
  daily_cap: 5.0,
  monthly_cap: 100.0,
  blocked_dates: [],
};

export const DIALER_SETTING_KEYS = {
  enabled: 'retell_dialer_enabled',
  operating_days: 'retell_operating_days',
  hours_start: 'retell_hours_start',
  hours_end: 'retell_hours_end',
  daily_cap: 'retell_daily_cap',
  monthly_cap: 'retell_monthly_cap',
  blocked_dates: 'retell_blocked_dates',
} as const;

export type DialerStatusIndicator = 'active' | 'paused' | 'outside_hours' | 'cap_reached';

export const DAY_LABELS: { idx: number; short: string; long: string }[] = [
  { idx: 1, short: 'Mon', long: 'Monday' },
  { idx: 2, short: 'Tue', long: 'Tuesday' },
  { idx: 3, short: 'Wed', long: 'Wednesday' },
  { idx: 4, short: 'Thu', long: 'Thursday' },
  { idx: 5, short: 'Fri', long: 'Friday' },
  { idx: 6, short: 'Sat', long: 'Saturday' },
  { idx: 0, short: 'Sun', long: 'Sunday' },
];

export type DailySpendPoint = { day: string; spend: number };

export type QueueFilters = {
  status?: string;
  source?: string;
  start_date?: string;
  end_date?: string;
};

// ---------------------------------------------------------------------------
// Retry settings — agency_settings rows keyed retell_tier* / retell_vm*.
// Tier 1 carries a decay window; tiers 2/3 do not. All stored as Number.
// (The retell_* setting keys are intentionally kept as-is.)
// ---------------------------------------------------------------------------

export type TierConfig = {
  daily_max: number;
  monthly_max: number;
  lifetime_max: number;
  cooldown_hours: number;
  decay_days?: number;
};

export type VmLimits = {
  max_per_day: number;
  max_lifetime: number;
};

export type RetrySettings = {
  tier1: Required<TierConfig>;
  tier2: TierConfig;
  tier3: TierConfig;
  vm: VmLimits;
};

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  tier1: { daily_max: 3, monthly_max: 15, lifetime_max: 30, cooldown_hours: 4, decay_days: 30 },
  tier2: { daily_max: 2, monthly_max: 15, lifetime_max: 30, cooldown_hours: 4 },
  tier3: { daily_max: 1, monthly_max: 10, lifetime_max: 20, cooldown_hours: 24 },
  vm: { max_per_day: 1, max_lifetime: 2 },
};

/** setting_key → bounds for blur validation. Mirrors the task's min/max spec. */
export type RetryFieldKey =
  | 'retell_tier1_daily_max'
  | 'retell_tier1_monthly_max'
  | 'retell_tier1_lifetime_max'
  | 'retell_tier1_cooldown_hours'
  | 'retell_tier1_decay_days'
  | 'retell_tier2_daily_max'
  | 'retell_tier2_monthly_max'
  | 'retell_tier2_lifetime_max'
  | 'retell_tier2_cooldown_hours'
  | 'retell_tier3_daily_max'
  | 'retell_tier3_monthly_max'
  | 'retell_tier3_lifetime_max'
  | 'retell_tier3_cooldown_hours'
  | 'retell_vm_max_per_day'
  | 'retell_vm_max_lifetime';

export const RETRY_FIELD_BOUNDS: Record<RetryFieldKey, { min: number; max: number }> = {
  retell_tier1_daily_max: { min: 1, max: 10 },
  retell_tier1_monthly_max: { min: 1, max: 50 },
  retell_tier1_lifetime_max: { min: 1, max: 100 },
  retell_tier1_cooldown_hours: { min: 1, max: 48 },
  retell_tier1_decay_days: { min: 1, max: 365 },
  retell_tier2_daily_max: { min: 1, max: 10 },
  retell_tier2_monthly_max: { min: 1, max: 50 },
  retell_tier2_lifetime_max: { min: 1, max: 100 },
  retell_tier2_cooldown_hours: { min: 1, max: 48 },
  retell_tier3_daily_max: { min: 1, max: 10 },
  retell_tier3_monthly_max: { min: 1, max: 50 },
  retell_tier3_lifetime_max: { min: 1, max: 100 },
  retell_tier3_cooldown_hours: { min: 1, max: 48 },
  retell_vm_max_per_day: { min: 0, max: 5 },
  retell_vm_max_lifetime: { min: 0, max: 10 },
};

export type QueueStats = {
  total: number;
  pending: number;
  in_progress: number;
  completed_today: number;
  tier1: number;
  tier2: number;
  tier3: number;
  calls_remaining_today: number;
};

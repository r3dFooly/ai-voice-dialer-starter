-- 0002_agency_settings.sql
-- Generic key/value settings store for the dialer. Effective-dated: a key can
-- have multiple rows over time; vw_agency_settings_current exposes the row that
-- is in effect today. The dashboard reads/writes through this table; the
-- backend reads the caps + toggles at dial time.
--
-- NOTE (faithful to source): value_type is CHECKed to Currency|Percent|Number|Text.
-- Booleans and JSON arrays are therefore stored as 'Text' (e.g. 'false',
-- '[1,2,3,4,5]') and parsed in application code. Keep that convention.

create table public.agency_settings (
  id             uuid primary key default gen_random_uuid(),
  setting_key    text not null,
  setting_value  text not null,
  value_type     text not null check (value_type = any (array['Currency','Percent','Number','Text'])),
  description    text,
  effective_from date not null default current_date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (setting_key, effective_from)
);

create index idx_agency_settings_key_effective
  on public.agency_settings using btree (setting_key, effective_from desc);

create trigger trg_agency_settings_updated_at
  before update on public.agency_settings
  for each row execute function public.update_updated_at_column();

-- Current-value view: newest effective row per key, as of today.
create or replace view public.vw_agency_settings_current as
  select distinct on (setting_key)
    setting_key, setting_value, value_type, description, effective_from, notes
  from public.agency_settings
  where effective_from <= current_date
  order by setting_key, effective_from desc;

-- ---------------------------------------------------------------------------
-- Seed — NEUTRAL defaults only. No business identity, no live phone numbers.
-- Dialer ships DISABLED and with a BLANK caller ID (the scheduler skips every
-- lead until retell_default_from_number is set — that is intentional).
-- ---------------------------------------------------------------------------
insert into public.agency_settings (setting_key, setting_value, value_type, description) values
  -- master + spend caps (core)
  ('retell_dialer_enabled',       'false',   'Text',     'Master on/off toggle for the AI dialer'),
  ('retell_daily_cap',            '5.00',    'Currency', 'Max daily spend in USD'),
  ('retell_monthly_cap',          '100.00',  'Currency', 'Max monthly spend in USD'),
  ('retell_max_concurrent',       '1',       'Number',   'Max simultaneous calls'),
  ('retell_max_retries',          '3',       'Number',   'Max call attempts per lead'),
  ('retell_default_from_number',  '',        'Text',     'Default outbound caller ID (E.164) — SET THIS before enabling'),
  -- voicemail caps (core)
  ('retell_vm_max_per_day',       '1',       'Number',   'Max voicemails to same lead per day'),
  ('retell_vm_max_lifetime',      '2',       'Number',   'Max voicemails to same lead ever'),
  -- retry-tier cadence (core) — labels are cosmetic/config-driven in the UI
  ('retell_tier1_daily_max',      '3',       'Number',   'Tier 1 max calls per day'),
  ('retell_tier1_monthly_max',    '15',      'Number',   'Tier 1 max calls per month'),
  ('retell_tier1_lifetime_max',   '30',      'Number',   'Tier 1 max lifetime calls'),
  ('retell_tier1_cooldown_hours', '4',       'Number',   'Tier 1 hours between calls'),
  ('retell_tier1_decay_days',     '30',      'Number',   'Days before a Tier 1 lead decays to Tier 3'),
  ('retell_tier2_daily_max',      '2',       'Number',   'Tier 2 max calls per day'),
  ('retell_tier2_monthly_max',    '15',      'Number',   'Tier 2 max calls per month'),
  ('retell_tier2_lifetime_max',   '30',      'Number',   'Tier 2 max lifetime calls'),
  ('retell_tier2_cooldown_hours', '4',       'Number',   'Tier 2 hours between calls'),
  ('retell_tier3_daily_max',      '1',       'Number',   'Tier 3 max calls per day'),
  ('retell_tier3_monthly_max',    '10',      'Number',   'Tier 3 max calls per month'),
  ('retell_tier3_lifetime_max',   '20',      'Number',   'Tier 3 max lifetime calls'),
  ('retell_tier3_cooldown_hours', '24',      'Number',   'Tier 3 hours between calls'),
  -- transfer targets (BLANK — set to E.164 numbers to enable warm transfer)
  ('retell_transfer_primary',     '',        'Text',     'Primary warm-transfer number (E.164)'),
  ('retell_transfer_fallback',    '',        'Text',     'Fallback warm-transfer number (E.164)'),
  -- calling-window keys — ONLY enforced when the optional compliance module is
  -- enabled (see 0007 + backend/compliance/). Seeded here so the dashboard
  -- controls render; the default is_lead_callable() ignores them.
  ('retell_hours_start',          '09:00',   'Text',     'Earliest local time to call (compliance module)'),
  ('retell_hours_end',            '20:00',   'Text',     'Latest local time to call (compliance module)'),
  ('retell_operating_days',       '[1,2,3,4,5]', 'Text', 'Weekdays the dialer runs, 0=Sun (compliance module)'),
  ('retell_blocked_dates',        '[]',      'Text',     'ISO dates to skip (compliance module)');

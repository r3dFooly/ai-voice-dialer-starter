-- 0003_retell_call_queue.sql
-- The outbound work queue. One row per lead-to-dial. The scheduler drains this
-- table (highest priority_score, soonest next_attempt_at) and the server writes
-- call outcomes back onto it.
--
-- Voice-only: all SMS / appointment / no-show / handoff columns from the source
-- system are intentionally omitted. CRM-specific columns are renamed to
-- lead-source-neutral names (external_* / lead_labels) and are populated by the
-- active LeadSource adapter.
--
-- COMPLIANCE NOTE: consent_verified defaults TRUE here — this is a bare dialer.
-- The scheduler index below therefore does NOT filter on consent. Enable the
-- optional compliance module (0007) to flip this to an opt-in consent model.

create table public.retell_call_queue (
  id                    uuid primary key default gen_random_uuid(),

  -- identity
  contact_name          text not null,
  phone_e164            text not null,

  -- scheduling / priority
  priority_score        integer not null default 20,
  dialer_status         text not null default 'Pending'
    check (dialer_status = any (array[
      'Pending','In_Progress','Completed','Voicemail','No_Answer','DNC',
      'Transferred','Callback_Scheduled','Skipped','Removed',
      'Max_VM_Reached','Max_Attempts_Reached','Failed'])),
  next_attempt_at       timestamptz not null default now(),

  -- consent / suppression (defaults dial-everything for the bare dialer)
  consent_verified      boolean not null default true,
  dnc_checked           boolean not null default false,

  -- provenance (lead-source-neutral; populated by the LeadSource adapter)
  source                text not null default 'manual'
    check (source = any (array['webhook','manual','csv_import','api','retention','callback'])),
  external_lead_id      text,          -- adapter's record id (e.g. CRM contact id)
  lead_labels           text[],        -- adapter's tags/labels
  segment               text,          -- free-text business line / campaign (was "vertical")
  product_interest      text,
  assigned_agent        text,          -- free text (no fixed roster)
  from_number           text,

  -- call linkage + results
  provider_call_id      text,          -- voice provider's call id (Retell)
  disposition           text
    check (disposition = any (array[
      'Transferred','Callback','DNC','Not_Qualified','Completed','Voicemail','No_Answer','Hung_Up'])),
  sentiment             text check (sentiment = any (array['Positive','Neutral','Negative'])),
  bant_score            integer,       -- generic 0-100 sales-qualification score
  call_summary          text,
  recording_url         text,
  cost_cents            integer,
  duration_seconds      integer,

  -- attempt accounting (drives is_lead_callable pacing)
  retry_count           integer not null default 0,
  max_retries           integer not null default 3,
  daily_attempt_count   integer not null default 0,
  monthly_attempt_count integer not null default 0,
  total_attempt_count   integer not null default 0,
  max_daily_attempts    integer not null default 2,
  max_monthly_attempts  integer not null default 6,
  max_total_attempts    integer not null default 10,
  cool_down_hours       integer not null default 4,
  last_attempt_at       timestamptz,
  last_attempt_hour     integer,
  vm_count              integer not null default 0,
  lead_timezone         text default 'America/New_York',

  -- callbacks
  callback_scheduled_at timestamptz,
  callback_confirmed    boolean not null default false,

  -- writeback bookkeeping (adapter marks when results pushed to lead source)
  external_feedback_sent boolean not null default false,

  -- freshness inputs for priority decay
  lead_created_at       timestamptz default now(),
  external_created_at   timestamptz,

  -- arbitrary per-lead context surfaced to the prompt + dashboard
  lead_context          jsonb default '{}'::jsonb,

  -- optional telephony enrichment (Twilio Lookup adapter; null without creds)
  line_type             text,
  carrier_name          text,
  cnam_name             text,
  cnam_type             text,
  lookup_at             timestamptz,
  lookup_error          text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The scheduler's hot path: highest priority, due now, still Pending.
-- (No consent_verified filter — see compliance note above.)
create index idx_rcq_scheduler on public.retell_call_queue
  using btree (priority_score desc, next_attempt_at)
  where (dialer_status = 'Pending');

create index idx_rcq_status   on public.retell_call_queue using btree (dialer_status);
create index idx_rcq_provider on public.retell_call_queue using btree (provider_call_id);

create trigger trg_retell_call_queue_updated_at
  before update on public.retell_call_queue
  for each row execute function public.update_updated_at_column();

-- 0004_retell_call_log.sql
-- Immutable-ish record of every call attempt (inbound + outbound). Powers the
-- call-history table and the spend RPCs. Idempotency is enforced in application
-- code (select-then-update by provider_call_id) — there is intentionally NO
-- unique constraint on provider_call_id, matching the source system.

create table public.retell_call_log (
  id                    uuid primary key default gen_random_uuid(),
  queue_id              uuid references public.retell_call_queue(id) on delete set null,
  provider_call_id      text not null,                 -- voice provider's call id
  call_direction        text not null default 'outbound'
    check (call_direction = any (array['inbound','outbound'])),
  from_number           text,
  to_number             text not null,
  duration_seconds      integer,
  cost_cents            integer,
  disconnection_reason  text,
  transcript            text,
  bant_score            integer,
  disposition           text,
  sentiment             text,
  call_summary          text,
  recording_url         text,
  transferred_to_agent  boolean default false,
  transfer_outcome      text,
  external_feedback_sent boolean not null default false, -- pushed back to lead source?
  callback_requested_at timestamptz,
  callback_time_raw     text,
  created_at            timestamptz not null default now()
);

create index idx_rcl_queue on public.retell_call_log using btree (queue_id);
create index idx_rcl_date  on public.retell_call_log using btree (created_at desc);
create index idx_rcl_cost  on public.retell_call_log using btree (created_at) where (cost_cents > 0);

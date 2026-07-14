-- 0007_compliance_dnc.sql   *** OPTIONAL — OFF BY DEFAULT ***
-- =============================================================================
-- Apply this migration ONLY if you enable the compliance module
-- (COMPLIANCE_MODULE_ENABLED=true in the backend). It layers telemarketing
-- guardrails back onto the bare dialer:
--   1. A DNC (do-not-call) suppression list.
--   2. An opt-in consent model (flips consent_verified default to false).
--   3. Timezone-aware calling-window enforcement inside is_lead_callable().
--
-- ⚠️  LEGAL: This starter ships WITHOUT calling-window / DNC / consent
-- enforcement in its default path. Outbound telemarketing in the US is subject
-- to the TCPA (quiet hours, DNC scrubbing, consent) with statutory damages of
-- $500–$1,500 PER CALL. Before dialing real numbers at scale you are
-- responsible for your own compliance posture. This module is a starting
-- point, not legal advice.
-- =============================================================================

-- 1. DNC suppression list -----------------------------------------------------
create table if not exists public.dnc_list (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text not null unique,
  reason      text,
  created_at  timestamptz not null default now()
);
alter table public.dnc_list enable row level security;
create policy dnc_list_service_all on public.dnc_list
  for all to service_role using (true) with check (true);

-- 2. Opt-in consent: new leads are NOT callable until consent is recorded.
alter table public.retell_call_queue alter column consent_verified set default false;

-- Re-add the consent filter to the scheduler's hot-path index.
drop index if exists idx_rcq_scheduler;
create index idx_rcq_scheduler on public.retell_call_queue
  using btree (priority_score desc, next_attempt_at)
  where (dialer_status = 'Pending' and consent_verified = true);

-- 3. Calling-window + consent + DNC enforcement inside is_lead_callable().
create or replace function public.is_lead_callable(p_queue_id uuid)
returns boolean
language plpgsql
as $$
declare
  rec record;
  hours_since_last numeric;
  lead_local_time  time;
  cfg_hours_start  time := '09:00';
  cfg_hours_end    time := '20:00';
begin
  select setting_value::time into cfg_hours_start
    from public.agency_settings where setting_key = 'retell_hours_start'
    order by effective_from desc limit 1;
  select setting_value::time into cfg_hours_end
    from public.agency_settings where setting_key = 'retell_hours_end'
    order by effective_from desc limit 1;

  select * into rec from public.retell_call_queue where id = p_queue_id;

  if rec is null then return false; end if;
  if rec.dialer_status <> 'Pending' then return false; end if;
  if rec.consent_verified = false then return false; end if;      -- consent gate
  if rec.next_attempt_at > now() then return false; end if;

  if rec.daily_attempt_count   >= rec.max_daily_attempts   then return false; end if;
  if rec.monthly_attempt_count >= rec.max_monthly_attempts then return false; end if;
  if rec.total_attempt_count   >= rec.max_total_attempts   then return false; end if;

  if rec.last_attempt_at is not null then
    hours_since_last := extract(epoch from (now() - rec.last_attempt_at)) / 3600.0;
    if hours_since_last < rec.cool_down_hours then return false; end if;
  end if;

  -- DNC suppression
  if exists (select 1 from public.dnc_list d where d.phone_e164 = rec.phone_e164) then
    return false;
  end if;

  -- timezone-aware calling window
  lead_local_time := (now() at time zone coalesce(rec.lead_timezone, 'America/New_York'))::time;
  if lead_local_time < cfg_hours_start or lead_local_time > cfg_hours_end then
    return false;
  end if;

  return true;
end;
$$;

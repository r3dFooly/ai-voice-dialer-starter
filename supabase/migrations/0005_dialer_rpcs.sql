-- 0005_dialer_rpcs.sql
-- The three functions the runtime hard-depends on.
--
-- is_lead_callable() is FAIL-SAFE: the scheduler treats a false return as
-- "skip this lead". If this function is missing or errors, NOTHING dials — so
-- it must exist before the scheduler runs.
--
-- v1 is PACING-ONLY: status + due-time + per-lead attempt caps + cooldown.
-- It intentionally does NOT enforce consent or calling-hours (that is the
-- optional compliance module's job — see 0007, which REPLACES this function).

create or replace function public.is_lead_callable(p_queue_id uuid)
returns boolean
language plpgsql
as $$
declare
  rec record;
  hours_since_last numeric;
begin
  select * into rec from public.retell_call_queue where id = p_queue_id;

  if rec is null then return false; end if;
  if rec.dialer_status <> 'Pending' then return false; end if;
  if rec.next_attempt_at > now() then return false; end if;

  -- per-lead attempt caps
  if rec.daily_attempt_count   >= rec.max_daily_attempts   then return false; end if;
  if rec.monthly_attempt_count >= rec.max_monthly_attempts then return false; end if;
  if rec.total_attempt_count   >= rec.max_total_attempts   then return false; end if;

  -- cooldown between attempts
  if rec.last_attempt_at is not null then
    hours_since_last := extract(epoch from (now() - rec.last_attempt_at)) / 3600.0;
    if hours_since_last < rec.cool_down_hours then return false; end if;
  end if;

  return true;
end;
$$;

-- Spend rollups from the call log (dashboard cards + scheduler cap checks).
create or replace function public.get_retell_spend_today()
returns numeric
language sql
stable
as $$
  select coalesce(sum(cost_cents), 0) / 100.0
  from public.retell_call_log
  where created_at >= current_date;
$$;

create or replace function public.get_retell_spend_month()
returns numeric
language sql
stable
as $$
  select coalesce(sum(cost_cents), 0) / 100.0
  from public.retell_call_log
  where created_at >= date_trunc('month', current_date);
$$;

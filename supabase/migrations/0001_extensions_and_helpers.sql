-- 0001_extensions_and_helpers.sql
-- Base extensions + shared helper function.
-- Applied first; everything else depends on gen_random_uuid() and the
-- updated_at touch trigger defined here.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- BEFORE-UPDATE trigger helper: stamps updated_at = now() on every row update.
-- Reused by agency_settings / retell_call_queue.
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

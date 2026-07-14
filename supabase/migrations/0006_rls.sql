-- 0006_rls.sql
-- Row-level security. The backend uses the service-role key (bypasses RLS).
-- The dashboard reads server-side, also with the service role, but RLS is
-- enabled defensively so the anon/publishable key can never read call data.
--
-- Policy model (minimal):
--   * service_role  -> full access (backend + dashboard server actions)
--   * authenticated -> read-only SELECT (in case you expose a signed-in client)
-- Adjust to your app's auth model as needed.

-- Supabase provisions service_role / authenticated / anon automatically. Guard
-- their creation so this migration also applies on a bare Postgres (local tests,
-- `supabase db reset`, self-hosted). On a real Supabase project these already
-- exist and the guards skip.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin noinherit bypassrls; end if;
end;
$$;

alter table public.agency_settings   enable row level security;
alter table public.retell_call_queue enable row level security;
alter table public.retell_call_log   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['agency_settings','retell_call_queue','retell_call_log']
  loop
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true);',
      t || '_service_all', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true);',
      t || '_auth_read', t);
  end loop;
end;
$$;

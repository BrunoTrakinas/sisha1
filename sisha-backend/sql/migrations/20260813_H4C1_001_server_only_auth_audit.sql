-- SISHA1 V2 - H4C1 - SERVER-ONLY AUTH REGISTRY + AUDIT LOG
-- Date: 2026-08-13
--
-- Purpose:
--   * authorized_users is a backend authorization registry and must not be
--     queryable/mutable with anon/authenticated PostgREST roles.
--   * system_audit_logs contains security/audit evidence and must not accept
--     direct reads/inserts from anon/authenticated roles.
--   * Backend access is performed through the already configured Supabase
--     server secret/service-role client.
--
-- This migration DOES NOT:
--   * remove the legacy senha column;
--   * change SISHA_AUTH_MODE;
--   * change Supabase Auth users/passwords;
--   * change business tables or UI/UX.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- Fail closed if the expected live objects are not present.
do $preflight$
begin
  if to_regclass('public.authorized_users') is null then
    raise exception 'H4C1: public.authorized_users not found';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'H4C1: public.system_audit_logs not found';
  end if;
end;
$preflight$;

-- These registries are backend-only. Service-role/secret-key requests bypass
-- RLS; browser/anon/authenticated requests receive no policy path.
alter table public.authorized_users enable row level security;
alter table public.system_audit_logs enable row level security;

-- Remove every policy from the two server-only tables so an older permissive
-- policy cannot survive a migration/redeploy.
do $drop_policies$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('authorized_users', 'system_audit_logs')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end;
$drop_policies$;

revoke all on table public.authorized_users from public, anon, authenticated;
revoke all on table public.system_audit_logs from public, anon, authenticated;

-- Explicit server privileges. Supabase service-role/secret key is never sent
-- to the frontend and is already required by H2/H2-HF1 administrative flows.
grant select, insert, update, delete on table public.authorized_users to service_role;
grant select, insert, update, delete on table public.system_audit_logs to service_role;

-- bigint identity/serial sequence used by system_audit_logs.id.
do $sequence_grant$
begin
  if to_regclass('public.system_audit_logs_id_seq') is not null then
    revoke all on sequence public.system_audit_logs_id_seq from public, anon, authenticated;
    grant usage, select on sequence public.system_audit_logs_id_seq to service_role;
  end if;
end;
$sequence_grant$;

comment on table public.authorized_users is
'SISHA1 V2 server-only authorization registry. Browser roles have no direct table access; backend uses Supabase server secret/service role.';

comment on table public.system_audit_logs is
'SISHA1 V2 server-only security/audit ledger. Browser roles have no direct table access; backend uses Supabase server secret/service role.';

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4C1_001',
  'H4C1: authorized_users e system_audit_logs restritos ao backend service_role; policies publicas removidas.'
)
on conflict (version) do update
set description = excluded.description;

-- Migration-level verification. Any unsafe policy/grant aborts the transaction.
do $verify$
declare
  v_policies bigint;
  v_unsafe_grants bigint;
begin
  select count(*)
    into v_policies
  from pg_policies
  where schemaname = 'public'
    and tablename in ('authorized_users', 'system_audit_logs');

  if v_policies <> 0 then
    raise exception 'H4C1: expected zero RLS policies on server-only tables, found %', v_policies;
  end if;

  select count(*)
    into v_unsafe_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('authorized_users', 'system_audit_logs')
    and grantee in ('anon', 'authenticated');

  if v_unsafe_grants <> 0 then
    raise exception 'H4C1: anon/authenticated grants remain on server-only tables: %', v_unsafe_grants;
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'authorized_users'
      and c.relrowsecurity = true
  ) then
    raise exception 'H4C1: RLS not enabled on authorized_users';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'system_audit_logs'
      and c.relrowsecurity = true
  ) then
    raise exception 'H4C1: RLS not enabled on system_audit_logs';
  end if;
end;
$verify$;

commit;

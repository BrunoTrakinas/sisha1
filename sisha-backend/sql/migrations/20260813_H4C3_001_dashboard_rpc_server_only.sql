-- SISHA1 V2 - H4C3
-- Fecha a ultima RPC conhecida do SISHA que ainda podia ser executada por
-- PUBLIC/anon/authenticated. O Dashboard continua acessivel somente pela API
-- autenticada do backend, que agora usa SUPABASE_SECRET_KEY/service_role.
--
-- Nao altera calculos, tabelas, dados, UI/UX ou regras logisticas.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

do $guard$
begin
  if to_regprocedure('public.rpc_dashboard_stats()') is null then
    raise exception 'H4C3: rpc_dashboard_stats() nao existe no banco.';
  end if;
end;
$guard$;

-- A funcao e SECURITY INVOKER/read-only; fixamos o search_path e fechamos
-- apenas quem pode executa-la. service_role continua usando os privilegios
-- administrativos do backend.
alter function public.rpc_dashboard_stats()
  set search_path to pg_catalog, public;

revoke execute on function public.rpc_dashboard_stats() from public;
revoke execute on function public.rpc_dashboard_stats() from anon;
revoke execute on function public.rpc_dashboard_stats() from authenticated;
grant execute on function public.rpc_dashboard_stats() to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4C3_001',
  'H4C3: rpc_dashboard_stats restrita ao backend service_role e stats server-only.'
)
on conflict (version) do update
set description = excluded.description;

do $verify$
declare
  v_anon boolean;
  v_auth boolean;
  v_service boolean;
  v_security_definer boolean;
begin
  select has_function_privilege(
    'anon', 'public.rpc_dashboard_stats()', 'EXECUTE'
  ) into v_anon;

  select has_function_privilege(
    'authenticated', 'public.rpc_dashboard_stats()', 'EXECUTE'
  ) into v_auth;

  select has_function_privilege(
    'service_role', 'public.rpc_dashboard_stats()', 'EXECUTE'
  ) into v_service;

  select p.prosecdef
    into v_security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = 'public.rpc_dashboard_stats()'::regprocedure;

  if v_anon or v_auth or not v_service then
    raise exception 'H4C3: privilegios de rpc_dashboard_stats ficaram incorretos.';
  end if;

  if v_security_definer then
    raise exception 'H4C3: rpc_dashboard_stats deve permanecer SECURITY INVOKER.';
  end if;
end;
$verify$;

commit;

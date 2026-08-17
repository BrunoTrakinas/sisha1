-- SISHA1 V2 - H4C4
-- HF1: guard de privileges corrigido para evitar predicate reordering do PostgreSQL.
-- Data-plane do schema public restrito ao backend.
--
-- Premissa validada no codigo: o frontend nao cria cliente Supabase e todos os
-- dados do SISHA passam pelas rotas autenticadas do backend. Supabase Auth
-- continua usando SUPABASE_KEY em supabaseAuthService.js.
--
-- Esta migration:
--   * nao altera dados, colunas ou regras de negocio;
--   * nao altera as policies RLS existentes;
--   * revoga acesso direto a TABLE/VIEW/SEQUENCE para PUBLIC/anon/authenticated;
--   * garante service_role nos objetos existentes;
--   * fecha os DEFAULT PRIVILEGES para futuros objetos criados pelo role que
--     executa as migrations no schema public.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- Objetos existentes. Em PostgreSQL, ALL TABLES cobre tabelas, views e
-- materialized views aceitas pelo comando GRANT/REVOKE ON TABLE.
revoke all privileges on all tables in schema public from public;
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all tables in schema public from authenticated;
grant all privileges on all tables in schema public to service_role;

revoke all privileges on all sequences in schema public from public;
revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all sequences in schema public from authenticated;
grant all privileges on all sequences in schema public to service_role;

-- Objetos futuros criados pelo role que esta aplicando a migration.
alter default privileges in schema public
  revoke all privileges on tables from public;
alter default privileges in schema public
  revoke all privileges on tables from anon;
alter default privileges in schema public
  revoke all privileges on tables from authenticated;
alter default privileges in schema public
  grant all privileges on tables to service_role;

alter default privileges in schema public
  revoke all privileges on sequences from public;
alter default privileges in schema public
  revoke all privileges on sequences from anon;
alter default privileges in schema public
  revoke all privileges on sequences from authenticated;
alter default privileges in schema public
  grant all privileges on sequences to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4C4_001',
  'H4C4: data-plane public server-only; tabelas, views e sequences sem acesso direto por anon/authenticated.'
)
on conflict (version) do update
set description = excluded.description;

-- Guards: nenhum privilegio explicito em relacoes/sequences public pode restar
-- para PUBLIC/anon/authenticated. O service_role deve conseguir SELECT nas
-- relacoes e USAGE nas sequences existentes.
do $verify$
declare
  v_public_leaks bigint := 0;
  v_service_table_failures bigint := 0;
  v_service_sequence_failures bigint := 0;
begin
  select count(*)
  into v_public_leaks
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  left join pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and (
      a.grantee = 0
      or r.rolname in ('anon', 'authenticated')
    );

  if v_public_leaks <> 0 then
    raise exception 'H4C4: ainda existem % privilegios publicos em relacoes/sequences do schema public.', v_public_leaks;
  end if;

  -- IMPORTANTE:
  -- PostgreSQL nao garante ordem de avaliacao dos predicados do WHERE.
  -- Portanto, nao chamamos has_*_privilege diretamente sobre pg_class junto
  -- com relkind: o planner poderia avaliar a funcao antes do filtro e passar
  -- um INDEX/objeto invalido. Os CTEs MATERIALIZED abaixo primeiro isolam os
  -- OIDs de objetos compativeis e so depois executam a checagem.

  with target_relations as materialized (
    select c.oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
  )
  select count(*)
  into v_service_table_failures
  from target_relations t
  where not has_table_privilege('service_role', t.oid, 'SELECT');

  if v_service_table_failures <> 0 then
    raise exception 'H4C4: service_role ficou sem SELECT em % relacoes public.', v_service_table_failures;
  end if;

  with target_sequences as materialized (
    select c.oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
  )
  select count(*)
  into v_service_sequence_failures
  from target_sequences s
  where not has_sequence_privilege('service_role', s.oid, 'USAGE');

  if v_service_sequence_failures <> 0 then
    raise exception 'H4C4: service_role ficou sem USAGE em % sequences public.', v_service_sequence_failures;
  end if;
end;
$verify$;

commit;

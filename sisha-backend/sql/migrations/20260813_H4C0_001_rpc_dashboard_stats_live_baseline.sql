-- SISHA1 V2 — H4C0 HIGIENE / BASELINE DA RPC DO DASHBOARD
-- Data: 2026-08-13
-- Origem: definição viva recuperada em modo READ_ONLY pelo H4A.
-- Objetivo:
--   1) retirar a definição antiga/solta de rpc_dashboard_stats.sql;
--   2) manter no repositório a versão REAL atualmente usada pelo Supabase;
--   3) preservar o comportamento atual do dashboard.
--
-- Esta migration NÃO altera tabelas de negócio, UI/UX ou regras logísticas.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

create or replace function public.rpc_dashboard_stats()
returns table(
  total_ppu numeric,
  total_ppu_pns bigint,
  total_oda numeric,
  total_oda_pds bigint,
  total_odc numeric,
  total_odc_pds bigint,
  valor_total_estoque_gbp numeric,
  pns_precificados bigint
)
language plpgsql
as $function$
declare
    v_total_ppu numeric := 0;
    v_total_ppu_pns bigint := 0;
    v_total_oda numeric := 0;
    v_total_oda_pds bigint := 0;
    v_total_odc numeric := 0;
    v_total_odc_pds bigint := 0;
    v_valor_total_estoque_gbp numeric := 0;
    v_pns_precificados bigint := 0;
begin
    select
        coalesce(sum(quantidade), 0),
        count(distinct upper(trim(pn)))
    into v_total_ppu, v_total_ppu_pns
    from public.estoque_ppu;

    select
        coalesce(sum(qtd_pendente), 0),
        count(distinct upper(trim(documento_referencia)))
    into v_total_oda, v_total_oda_pds
    from public.leonardo_spares;

    if to_regclass('public.odc_requests') is not null then
        execute $sql$
            select
                coalesce(sum(
                    coalesce(nullif(to_jsonb(t)->>'quantidade', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd_pendente', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd_solicitada', '')::numeric, 0)
                ), 0),
                count(distinct upper(trim(coalesce(to_jsonb(t)->>'pd', to_jsonb(t)->>'documento_referencia', ''))))
            from public.odc_requests t
        $sql$
        into v_total_odc, v_total_odc_pds;

    elsif to_regclass('public.pd_odc') is not null then
        execute $sql$
            select
                coalesce(sum(
                    coalesce(nullif(to_jsonb(t)->>'quantidade', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd_pendente', '')::numeric, 0) +
                    coalesce(nullif(to_jsonb(t)->>'qtd_solicitada', '')::numeric, 0)
                ), 0),
                count(distinct upper(trim(coalesce(to_jsonb(t)->>'pd', to_jsonb(t)->>'documento_referencia', ''))))
            from public.pd_odc t
        $sql$
        into v_total_odc, v_total_odc_pds;
    end if;

    if to_regclass('public.v_estoque_ppu_valorizado') is not null then
        select
            coalesce(sum(valor_total_estimado), 0),
            count(*) filter (where valor_unitario_referencia is not null)
        into v_valor_total_estoque_gbp, v_pns_precificados
        from public.v_estoque_ppu_valorizado;
    end if;

    return query
    select
        v_total_ppu,
        v_total_ppu_pns,
        v_total_oda,
        v_total_oda_pds,
        v_total_odc,
        v_total_odc_pds,
        v_valor_total_estoque_gbp,
        v_pns_precificados;
end;
$function$;

comment on function public.rpc_dashboard_stats() is
'SISHA1 V2: estatísticas consolidadas do dashboard — baseline vivo versionado no H4C0.';

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4C0_001',
  'H4C0: baseline vivo da RPC rpc_dashboard_stats e organização do SQL durável em migrations.'
)
on conflict (version) do update
set description = excluded.description;

do $verify$
declare
  v_result text;
begin
  select pg_get_function_result(
    'public.rpc_dashboard_stats()'::regprocedure
  )
  into v_result;

  if v_result not ilike '%total_odc%'
     or v_result not ilike '%valor_total_estoque_gbp%'
     or v_result not ilike '%pns_precificados%' then
    raise exception 'H4C0: assinatura inesperada de rpc_dashboard_stats(): %', v_result;
  end if;
end;
$verify$;

commit;

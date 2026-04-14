-- SISHA-1v2 | Função RPC para estatísticas do dashboard
-- Executar no SQL Editor do Supabase antes de depender exclusivamente do modo RPC.

create or replace function public.rpc_dashboard_stats()
returns table (
    total_ppu numeric,
    total_ppu_pns bigint,
    total_oda numeric,
    total_oda_pds bigint
)
language sql
as $$
    with ppu as (
        select
            coalesce(sum(quantidade), 0) as total_ppu,
            count(distinct upper(trim(pn))) as total_ppu_pns
        from public.estoque_ppu
    ),
    oda as (
        select
            coalesce(sum(qtd_pendente), 0) as total_oda,
            count(distinct upper(trim(documento_referencia))) as total_oda_pds
        from public.leonardo_spares
    )
    select
        ppu.total_ppu,
        ppu.total_ppu_pns,
        oda.total_oda,
        oda.total_oda_pds
    from ppu
    cross join oda;
$$;

comment on function public.rpc_dashboard_stats() is
'SISHA-1v2: agrega estatísticas do dashboard (PPU e ODA) direto no PostgreSQL.';

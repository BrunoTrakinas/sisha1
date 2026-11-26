-- R5 — PRECHECK SOMENTE LEITURA. Nenhum payload de material retorna ao cliente.
with s as (
  select jsonb_agg(to_jsonb(p) order by p.id) as rows, count(*) as n,
    min(p.data_atualizacao) as first_updated, max(p.data_atualizacao) as last_updated
  from public.estoque_ppu p
), c as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'localizacao_normalizada',p.localizacao_normalizada,'ativo',p.ativo,
    'contabiliza_ppu',p.contabiliza_ppu,'destino_contabilizacao',p.destino_contabilizacao,
    'situacao_operacional',p.situacao_operacional
  ) order by p.id),'[]'::jsonb) as policies,count(*) as n
  from public.ppu_localizacoes_config p
)
select current_setting('TimeZone') as timezone,
  s.n as row_count,c.n as policy_count,s.first_updated,s.last_updated,
  encode(pg_catalog.sha256(pg_catalog.convert_to(s.rows::text,'UTF8')),'hex') as rows_sha256,
  encode(pg_catalog.sha256(pg_catalog.convert_to(c.policies::text,'UTF8')),'hex') as policies_sha256,
  jsonb_array_length(s.rows)=s.n as row_count_ok,
  jsonb_array_length(c.policies)=c.n as policy_count_ok
from s cross join c;

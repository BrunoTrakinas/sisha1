-- SISHA1V2 — CeIMSPA / Itens Sem Demanda
-- O saldo físico é contabilizado por PI; os PNs/REFs são referências de pesquisa do mesmo saldo.

alter table if exists public.estoque_ceimspa
  add column if not exists quantidade_existente numeric,
  add column if not exists referencias jsonb not null default '[]'::jsonb,
  add column if not exists referencias_text text,
  add column if not exists arquivo_fonte text;

comment on column public.estoque_ceimspa.referencias is
  'Referências/PNs vinculados ao mesmo PI no inventário CEIMSPA Sem Demanda. Não representam saldos independentes.';
comment on column public.estoque_ceimspa.referencias_text is
  'Índice textual auxiliar para pesquisa dos PNs/REFs do mesmo PI.';
comment on column public.estoque_ceimspa.quantidade_existente is
  'Quantidade existente informada no snapshot Sem Demanda; saldo disponível permanece em quantidade.';

create index if not exists idx_estoque_ceimspa_sem_demanda_pi
  on public.estoque_ceimspa (fonte_identificacao, pi);

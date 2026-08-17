-- SISHA1V2 C2.4 — Gravação única e idempotente de documento comercial
-- Escopo: impedir duplicação de rfq_cotacoes quando o mesmo job é salvo mais de uma vez.
-- Não altera o parser comercial nem a precedência de preços.

begin;

alter table if exists public.rfq_cotacoes
  add column if not exists rfq_import_job_id uuid,
  add column if not exists rfq_import_row_key text;

-- FK adicionada de forma defensiva para bancos já existentes.
do $$
begin
  if to_regclass('public.rfq_cotacoes') is not null
     and to_regclass('public.rfq_import_jobs') is not null
     and not exists (
       select 1
       from pg_constraint
       where conname = 'rfq_cotacoes_import_job_fk'
         and conrelid = 'public.rfq_cotacoes'::regclass
     ) then
    alter table public.rfq_cotacoes
      add constraint rfq_cotacoes_import_job_fk
      foreign key (rfq_import_job_id)
      references public.rfq_import_jobs(id)
      on delete restrict;
  end if;
end $$;

-- Barreira física contra segundo POST/duplo clique/race.
-- Cada linha da revisão recebe ROW:0001, ROW:0002... dentro do job persistente.
create unique index if not exists uq_rfq_cotacoes_import_job_row
  on public.rfq_cotacoes(rfq_import_job_id, rfq_import_row_key)
  where rfq_import_job_id is not null and rfq_import_row_key is not null;

create index if not exists idx_rfq_cotacoes_import_job
  on public.rfq_cotacoes(rfq_import_job_id)
  where rfq_import_job_id is not null;

comment on column public.rfq_cotacoes.rfq_import_job_id is
  'Job persistente que originou esta linha comercial. C2.4 usa este vínculo para idempotência e rastreabilidade.';
comment on column public.rfq_cotacoes.rfq_import_row_key is
  'Chave estável da linha dentro da revisão do job (ROW:0001...). Não representa PN nem item documental.';

commit;

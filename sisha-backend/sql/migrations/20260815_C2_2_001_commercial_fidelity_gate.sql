-- SISHA1V2 C2.2 — Fidelity Gate para documentos comerciais
-- Preserva o dado documental original e separa valores derivados/normalizados.

begin;

alter table if exists public.rfq_cotacoes
  add column if not exists quotation_printed_date date,
  add column if not exists document_item_number integer,
  add column if not exists lead_time_original text,
  add column if not exists stock_context_note text,
  add column if not exists source_description_status text;

comment on column public.rfq_cotacoes.quotation_printed_date is 'Data em que a Quotation foi impressa, distinta da data comercial da cotação.';
comment on column public.rfq_cotacoes.document_item_number is 'Número do item exatamente como organizado no documento comercial de origem.';
comment on column public.rfq_cotacoes.lead_time_original is 'Prazo como expresso pela fonte (ex.: 53 WEEK(S)); lead_time_dias é apenas derivado operacional.';
comment on column public.rfq_cotacoes.stock_context_note is 'Ressalva documental sobre disponibilidade de estoque na data da cotação.';
comment on column public.rfq_cotacoes.source_description_status is 'SOURCE_PRESENT ou SOURCE_MISSING; nunca autoriza inventar nomenclatura ausente na fonte.';

commit;

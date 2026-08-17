-- SISHA1V2 C2 — Documentos Comerciais Leonardo
-- Escopo: enriquecer rfq_cotacoes sem criar uma segunda verdade comercial.
-- O documento continua sendo revisado por Admin/Dono antes da gravação.

begin;

alter table if exists public.rfq_cotacoes
  add column if not exists documento_tipo text,
  add column if not exists contrato_referencia text,
  add column if not exists termos_pagamento text,
  add column if not exists termos_entrega text,
  add column if not exists items_total numeric,
  add column if not exists packing_delivery_percent numeric,
  add column if not exists packing_delivery_value numeric,
  add column if not exists final_amount numeric,
  add column if not exists material_reference text,
  add column if not exists material_reference_status text,
  add column if not exists price_status text,
  add column if not exists valor_total_item numeric,
  add column if not exists preco_base numeric,
  add column if not exists desconto_percentual numeric,
  add column if not exists one_time_only boolean not null default false,
  add column if not exists limite_quantidade numeric,
  add column if not exists prazo_condicao date,
  add column if not exists match_mode text not null default 'EXACT',
  add column if not exists pn_original_solicitado text,
  add column if not exists correcao_pn_tipo text,
  add column if not exists source_page integer,
  add column if not exists source_excerpt text,
  add column if not exists condicao_item text;

comment on column public.rfq_cotacoes.documento_tipo is 'Classificação do documento comercial original: Quotation, carta de preço, carta Repair/Overhaul ou genérico.';
comment on column public.rfq_cotacoes.match_mode is 'EXACT para PN exato; PATTERN para referência documental com wildcard, que nunca deve ser assumida como PN exato.';
comment on column public.rfq_cotacoes.one_time_only is 'Preço/condição excepcional aplicável somente ao escopo e prazo expressos no documento.';
comment on column public.rfq_cotacoes.source_excerpt is 'Trecho curto da evidência documental que sustenta a linha, preservado para revisão humana.';

commit;

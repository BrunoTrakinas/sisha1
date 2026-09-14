-- SISHA1V2 — LOCREC 001 — Snapshot consultivo / reconciliação Recibo x LOCREC
-- O LOCREC NÃO cria estoque, não altera recebimentos, não altera estoque_ppu e não altera estoque_ceimspa.
-- Ele é preservado como evidência consultiva versionada para o motor de reconciliação do SISHA.

create table if not exists public.locrec_importacoes (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null unique,
  file_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED')),
  imported_at timestamptz not null default now(),
  imported_by_auth_user_id text null,
  imported_by_email text null,
  summary jsonb not null default '{}'::jsonb
);

create unique index if not exists ux_locrec_importacoes_active
  on public.locrec_importacoes ((status))
  where status = 'ACTIVE';

create table if not exists public.locrec_itens (
  id bigserial primary key,
  import_id uuid not null references public.locrec_importacoes(id) on delete restrict,
  sheet_name text not null,
  source_row integer not null,
  numero_recibo text not null,
  pd text null,
  pn text not null,
  qtd_documental numeric(18,6) not null check (qtd_documental > 0),
  qtd_auditada_original numeric(18,6) null,
  qtd_auditada_aplicada numeric(18,6) not null default 0 check (qtd_auditada_aplicada >= 0),
  loc_escolhida text null,
  loc_normalizada text null,
  destino_indicado text not null default 'PENDENTE' check (destino_indicado in ('PENDENTE','PPU','CAIXA','CEIMSPA')),
  box_code text null,
  nip text null,
  data_auditoria text null,
  restante_original numeric(18,6) null,
  restante_calculado numeric(18,6) null,
  source_fingerprint text not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_locrec_itens_import on public.locrec_itens(import_id);
create index if not exists ix_locrec_itens_receipt_pn on public.locrec_itens(numero_recibo, pn);
create index if not exists ix_locrec_itens_pn on public.locrec_itens(pn);
create index if not exists ix_locrec_itens_box on public.locrec_itens(box_code) where box_code is not null;

alter table public.locrec_importacoes enable row level security;
alter table public.locrec_itens enable row level security;

revoke all on public.locrec_importacoes from anon, authenticated;
revoke all on public.locrec_itens from anon, authenticated;
grant select, insert, update on public.locrec_importacoes to service_role;
grant select, insert on public.locrec_itens to service_role;
grant usage, select on sequence public.locrec_itens_id_seq to service_role;

create or replace view public.v_sisha_locrec_atual as
select
  i.*,
  imp.source_hash,
  imp.file_name,
  imp.imported_at
from public.locrec_itens i
join public.locrec_importacoes imp on imp.id = i.import_id
where imp.status = 'ACTIVE';

revoke all on public.v_sisha_locrec_atual from anon, authenticated;
grant select on public.v_sisha_locrec_atual to service_role;

create or replace function public.rpc_import_locrec_snapshot(
  p_source_hash text,
  p_file_name text,
  p_imported_by_auth_user_id text,
  p_imported_by_email text,
  p_summary jsonb,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_import_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('sisha_locrec_snapshot'));

  if coalesce(trim(p_source_hash), '') = '' then
    raise exception 'source_hash obrigatório';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'items inválido';
  end if;

  select id into v_import_id
  from public.locrec_importacoes
  where source_hash = p_source_hash
  limit 1;

  if v_import_id is not null then
    update public.locrec_importacoes set status = 'SUPERSEDED' where status = 'ACTIVE' and id <> v_import_id;
    update public.locrec_importacoes
       set status = 'ACTIVE',
           imported_at = now(),
           imported_by_auth_user_id = p_imported_by_auth_user_id,
           imported_by_email = p_imported_by_email,
           summary = coalesce(p_summary, '{}'::jsonb)
     where id = v_import_id;
    return jsonb_build_object('import_id', v_import_id, 'reused', true, 'inserted_items', 0);
  end if;

  update public.locrec_importacoes set status = 'SUPERSEDED' where status = 'ACTIVE';

  insert into public.locrec_importacoes(
    source_hash, file_name, status, imported_by_auth_user_id, imported_by_email, summary
  ) values (
    p_source_hash,
    coalesce(nullif(trim(p_file_name), ''), 'LOCREC.xlsx'),
    'ACTIVE',
    p_imported_by_auth_user_id,
    p_imported_by_email,
    coalesce(p_summary, '{}'::jsonb)
  ) returning id into v_import_id;

  insert into public.locrec_itens(
    import_id, sheet_name, source_row, numero_recibo, pd, pn, qtd_documental,
    qtd_auditada_original, qtd_auditada_aplicada, loc_escolhida, loc_normalizada,
    destino_indicado, box_code, nip, data_auditoria, restante_original,
    restante_calculado, source_fingerprint
  )
  select
    v_import_id,
    x.sheet_name,
    x.source_row,
    x.numero_recibo,
    x.pd,
    x.pn,
    x.qtd_documental,
    x.qtd_auditada_original,
    greatest(0, least(x.qtd_documental, coalesce(x.qtd_auditada_aplicada, 0))),
    x.loc_escolhida,
    x.loc_normalizada,
    coalesce(nullif(x.destino_indicado, ''), 'PENDENTE'),
    x.box_code,
    x.nip,
    x.data_auditoria,
    x.restante_original,
    x.restante_calculado,
    x.source_fingerprint
  from jsonb_to_recordset(p_items) as x(
    sheet_name text,
    source_row integer,
    numero_recibo text,
    pd text,
    pn text,
    qtd_documental numeric,
    qtd_auditada_original numeric,
    qtd_auditada_aplicada numeric,
    loc_escolhida text,
    loc_normalizada text,
    destino_indicado text,
    box_code text,
    nip text,
    data_auditoria text,
    restante_original numeric,
    restante_calculado numeric,
    source_fingerprint text
  );

  return jsonb_build_object('import_id', v_import_id, 'reused', false, 'inserted_items', jsonb_array_length(p_items));
end;
$$;

revoke all on function public.rpc_import_locrec_snapshot(text,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.rpc_import_locrec_snapshot(text,text,text,text,jsonb,jsonb) to service_role;

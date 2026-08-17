-- SISHA1V2 — HF PPU 002 HF1 — Custódia Externa / Caixas CEIMSPA
-- Objetivo: preservar a fotografia oficial do InventarioPPUGeralLoc e aplicar, em camada separada,
-- a custódia física externa do PPU registrada pelo Backend_Auditoria_Paiol.xlsx.
-- HF1: preserva PN visível/original do Excel em pn_original.
-- Nenhuma linha desta migration altera ou apaga estoque_ppu.

create table if not exists public.ppu_custodia_externa_importacoes (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null unique,
  file_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED')),
  imported_at timestamptz not null default now(),
  imported_by_auth_user_id text null,
  imported_by_email text null,
  summary jsonb not null default '{}'::jsonb
);

create unique index if not exists ux_ppu_custodia_externa_active
  on public.ppu_custodia_externa_importacoes ((status))
  where status = 'ACTIVE';

create table if not exists public.ppu_custodia_externa_itens (
  id bigserial primary key,
  import_id uuid not null references public.ppu_custodia_externa_importacoes(id) on delete restrict,
  box_code text not null,
  sheet_name text not null,
  source_row integer not null,
  evidence_at text null,
  pn text not null,
  pn_original text null,
  nsn_original text null,
  nsn_normalized text null,
  nomenclature text null,
  quantity numeric(18,6) not null check (quantity > 0),
  sn text null,
  original_location text not null,
  original_location_normalized text not null,
  auditor_name text null,
  auditor_nip text null,
  group_key text not null,
  source_fingerprint text not null,
  created_at timestamptz not null default now()
);

alter table public.ppu_custodia_externa_itens add column if not exists pn_original text null;

create index if not exists ix_ppu_custodia_externa_itens_import on public.ppu_custodia_externa_itens(import_id);
create index if not exists ix_ppu_custodia_externa_itens_pn on public.ppu_custodia_externa_itens(pn);
create index if not exists ix_ppu_custodia_externa_itens_group on public.ppu_custodia_externa_itens(import_id, group_key);
create index if not exists ix_ppu_custodia_externa_itens_box on public.ppu_custodia_externa_itens(import_id, box_code);

create table if not exists public.ppu_custodia_externa_decisoes (
  id bigserial primary key,
  import_id uuid not null references public.ppu_custodia_externa_importacoes(id) on delete restrict,
  group_key text not null,
  decision text not null check (decision in ('CONFIRMAR_CUSTODIA','IGNORAR_MOVIMENTACAO')),
  reason text not null,
  decided_at timestamptz not null default now(),
  decided_by_auth_user_id text null,
  decided_by_email text null
);

create index if not exists ix_ppu_custodia_externa_decisoes_current
  on public.ppu_custodia_externa_decisoes(import_id, group_key, decided_at desc, id desc);

alter table public.ppu_custodia_externa_importacoes enable row level security;
alter table public.ppu_custodia_externa_itens enable row level security;
alter table public.ppu_custodia_externa_decisoes enable row level security;

revoke all on public.ppu_custodia_externa_importacoes from anon, authenticated;
revoke all on public.ppu_custodia_externa_itens from anon, authenticated;
revoke all on public.ppu_custodia_externa_decisoes from anon, authenticated;
grant select, insert, update on public.ppu_custodia_externa_importacoes to service_role;
grant select, insert on public.ppu_custodia_externa_itens to service_role;
grant select, insert on public.ppu_custodia_externa_decisoes to service_role;
grant usage, select on sequence public.ppu_custodia_externa_itens_id_seq to service_role;
grant usage, select on sequence public.ppu_custodia_externa_decisoes_id_seq to service_role;

create or replace view public.v_sisha_ppu_custodia_externa_atual as
select
  i.id,
  i.import_id,
  i.box_code,
  i.sheet_name,
  i.source_row,
  i.evidence_at,
  i.pn,
  i.pn_original,
  i.nsn_original,
  i.nsn_normalized,
  i.nomenclature,
  i.quantity,
  i.sn,
  i.original_location,
  i.original_location_normalized,
  i.auditor_name,
  i.auditor_nip,
  i.group_key,
  i.source_fingerprint,
  imp.source_hash,
  imp.file_name,
  imp.imported_at
from public.ppu_custodia_externa_itens i
join public.ppu_custodia_externa_importacoes imp on imp.id = i.import_id
where imp.status = 'ACTIVE';

revoke all on public.v_sisha_ppu_custodia_externa_atual from anon, authenticated;
grant select on public.v_sisha_ppu_custodia_externa_atual to service_role;

create or replace view public.v_sisha_ppu_custodia_externa_decisao_atual as
select distinct on (d.import_id, d.group_key)
  d.id,
  d.import_id,
  d.group_key,
  d.decision,
  d.reason,
  d.decided_at,
  d.decided_by_auth_user_id,
  d.decided_by_email
from public.ppu_custodia_externa_decisoes d
order by d.import_id, d.group_key, d.decided_at desc, d.id desc;

revoke all on public.v_sisha_ppu_custodia_externa_decisao_atual from anon, authenticated;
grant select on public.v_sisha_ppu_custodia_externa_decisao_atual to service_role;

create or replace function public.rpc_import_ppu_custodia_externa_snapshot(
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
  v_reused boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('sisha_ppu_custodia_externa_snapshot'));

  if coalesce(trim(p_source_hash), '') = '' then
    raise exception 'source_hash obrigatório';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'items inválido';
  end if;

  select id into v_import_id
  from public.ppu_custodia_externa_importacoes
  where source_hash = p_source_hash
  limit 1;

  if v_import_id is not null then
    v_reused := true;
    update public.ppu_custodia_externa_importacoes
       set status = 'SUPERSEDED'
     where status = 'ACTIVE' and id <> v_import_id;
    update public.ppu_custodia_externa_importacoes
       set status = 'ACTIVE',
           imported_at = now(),
           imported_by_auth_user_id = p_imported_by_auth_user_id,
           imported_by_email = p_imported_by_email,
           summary = coalesce(p_summary, '{}'::jsonb)
     where id = v_import_id;
    return jsonb_build_object('import_id', v_import_id, 'reused', true, 'inserted_items', 0);
  end if;

  update public.ppu_custodia_externa_importacoes set status = 'SUPERSEDED' where status = 'ACTIVE';

  insert into public.ppu_custodia_externa_importacoes(
    source_hash, file_name, status, imported_by_auth_user_id, imported_by_email, summary
  ) values (
    p_source_hash, coalesce(nullif(trim(p_file_name), ''), 'Backend_Auditoria_Paiol.xlsx'), 'ACTIVE',
    p_imported_by_auth_user_id, p_imported_by_email, coalesce(p_summary, '{}'::jsonb)
  ) returning id into v_import_id;

  insert into public.ppu_custodia_externa_itens(
    import_id, box_code, sheet_name, source_row, evidence_at, pn, pn_original,
    nsn_original, nsn_normalized, nomenclature, quantity, sn,
    original_location, original_location_normalized, auditor_name, auditor_nip,
    group_key, source_fingerprint
  )
  select
    v_import_id,
    x.box_code,
    x.sheet_name,
    x.source_row,
    x.evidence_at,
    x.pn,
    coalesce(nullif(trim(x.pn_original), ''), x.pn),
    x.nsn_original,
    x.nsn_normalized,
    x.nomenclature,
    x.quantity,
    x.sn,
    x.original_location,
    x.original_location_normalized,
    x.auditor_name,
    x.auditor_nip,
    x.group_key,
    x.source_fingerprint
  from jsonb_to_recordset(p_items) as x(
    box_code text,
    sheet_name text,
    source_row integer,
    evidence_at text,
    pn text,
    pn_original text,
    nsn_original text,
    nsn_normalized text,
    nomenclature text,
    quantity numeric,
    sn text,
    original_location text,
    original_location_normalized text,
    auditor_name text,
    auditor_nip text,
    group_key text,
    source_fingerprint text
  );

  return jsonb_build_object('import_id', v_import_id, 'reused', v_reused, 'inserted_items', jsonb_array_length(p_items));
end;
$$;

revoke all on function public.rpc_import_ppu_custodia_externa_snapshot(text,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.rpc_import_ppu_custodia_externa_snapshot(text,text,text,text,jsonb,jsonb) to service_role;

create or replace function public.rpc_decidir_ppu_custodia_externa(
  p_import_id uuid,
  p_group_key text,
  p_decision text,
  p_reason text,
  p_decided_by_auth_user_id text,
  p_decided_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_decision not in ('CONFIRMAR_CUSTODIA','IGNORAR_MOVIMENTACAO') then
    raise exception 'decisão inválida';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'motivo obrigatório';
  end if;
  if not exists (
    select 1
    from public.ppu_custodia_externa_itens i
    join public.ppu_custodia_externa_importacoes imp on imp.id = i.import_id
    where i.import_id = p_import_id
      and i.group_key = p_group_key
      and imp.status = 'ACTIVE'
  ) then
    raise exception 'grupo não pertence à importação ativa';
  end if;

  insert into public.ppu_custodia_externa_decisoes(
    import_id, group_key, decision, reason, decided_by_auth_user_id, decided_by_email
  ) values (
    p_import_id, p_group_key, p_decision, trim(p_reason), p_decided_by_auth_user_id, p_decided_by_email
  ) returning id into v_id;

  return jsonb_build_object('decision_id', v_id, 'import_id', p_import_id, 'group_key', p_group_key, 'decision', p_decision);
end;
$$;

revoke all on function public.rpc_decidir_ppu_custodia_externa(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.rpc_decidir_ppu_custodia_externa(uuid,text,text,text,text,text) to service_role;

-- SISHA1 — R5 — Histórico integral do Inventário PPU.
-- PREPARAÇÃO: não executa captura, importação, baixa de recibo ou alteração de saldo.
-- A captura inicial é uma operação explícita e separada. R6 deve reutilizar a mesma
-- trava e persistir snapshot + substituição do estoque + reconciliação numa transação.
begin;

create table public.ppu_inventario_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_type text not null check (snapshot_type in ('BASELINE_LEGADO','IMPORTACAO')),
  previous_snapshot_id uuid unique references public.ppu_inventario_snapshots(id) on delete restrict,
  import_log_id uuid unique references public.import_logs(id) on delete restrict,
  source_file_name text,
  source_file_sha256 text unique,
  observed_on date,
  captured_at timestamptz not null default now(),
  row_count integer not null check (row_count > 0),
  policy_count integer not null check (policy_count >= 0),
  rows_payload jsonb not null,
  policies_payload jsonb not null,
  rows_sha256 text not null,
  policies_sha256 text not null,
  constraint ppu_snapshot_not_self check (previous_snapshot_id is distinct from id),
  constraint ppu_snapshot_payload_valid check (
    jsonb_typeof(rows_payload) = 'array'
    and jsonb_typeof(policies_payload) = 'array'
    and jsonb_array_length(rows_payload) = row_count
    and jsonb_array_length(policies_payload) = policy_count
  ),
  constraint ppu_snapshot_hash_valid check (
    rows_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(rows_payload::text,'UTF8')),'hex')
    and policies_sha256 = encode(pg_catalog.sha256(pg_catalog.convert_to(policies_payload::text,'UTF8')),'hex')
  ),
  constraint ppu_snapshot_source_valid check (
    (snapshot_type = 'BASELINE_LEGADO'
      and previous_snapshot_id is null and import_log_id is null
      and source_file_name is null and source_file_sha256 is null and observed_on is null)
    or
    (snapshot_type = 'IMPORTACAO'
      and previous_snapshot_id is not null and import_log_id is not null
      and source_file_name is not null and length(btrim(source_file_name)) > 0
      and source_file_sha256 is not null and source_file_sha256 ~ '^[0-9a-f]{64}$'
      and observed_on is not null)
  )
);
create unique index ux_ppu_snapshot_legacy_baseline
  on public.ppu_inventario_snapshots(snapshot_type)
  where snapshot_type = 'BASELINE_LEGADO';

alter table public.ppu_inventario_snapshots enable row level security;
revoke all on table public.ppu_inventario_snapshots from public, anon, authenticated, service_role;
grant select, insert on table public.ppu_inventario_snapshots to service_role;

-- Defesa adicional contra alteração acidental do histórico, inclusive por administradores SQL.
create function public.sisha_ppu_snapshot_immutable() returns trigger
language plpgsql security invoker set search_path = pg_catalog
as $$
begin
  raise exception 'Histórico do Inventário PPU é somente de inclusão';
end;
$$;
revoke all on function public.sisha_ppu_snapshot_immutable() from public, anon, authenticated, service_role;
create trigger trg_ppu_snapshot_immutable
before update or delete or truncate on public.ppu_inventario_snapshots
for each statement execute function public.sisha_ppu_snapshot_immutable();

-- Captura somente a situação realmente disponível no banco. A data operacional legada
-- permanece nula: timestamps de importação e atualização não são datas de observação.
-- Ambos os hashes esperados são obrigatórios para prevenir uma captura de base inesperada.
create function public.sisha_capture_ppu_legacy_baseline(
  p_expected_rows_sha256 text,
  p_expected_policies_sha256 text
) returns jsonb
language plpgsql security invoker
set search_path = pg_catalog
set timezone = 'UTC'
as $$
declare
  v_rows jsonb;
  v_policies jsonb;
  v_row_count integer;
  v_policy_count integer;
  v_rows_sha256 text;
  v_policies_sha256 text;
  v_existing public.ppu_inventario_snapshots%rowtype;
  v_id uuid;
begin
  if p_expected_rows_sha256 is null or p_expected_rows_sha256 !~ '^[0-9a-f]{64}$'
     or p_expected_policies_sha256 is null or p_expected_policies_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Hashes esperados obrigatórios';
  end if;

  -- Mesma chave e mesma ordem de tabelas devem ser reutilizadas pela RPC transacional de R6.
  perform pg_advisory_xact_lock(hashtext('sisha_ppu_inventory_reconciliation')::bigint);
  lock table public.estoque_ppu, public.ppu_localizacoes_config in share mode;

  select jsonb_agg(to_jsonb(p) order by p.id), count(*)::integer
    into v_rows, v_row_count from public.estoque_ppu p;
  if v_row_count <= 0 then raise exception 'Inventário vazio não pode se tornar baseline'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'localizacao_normalizada',p.localizacao_normalizada,
    'ativo',p.ativo,
    'contabiliza_ppu',p.contabiliza_ppu,
    'destino_contabilizacao',p.destino_contabilizacao,
    'situacao_operacional',p.situacao_operacional
  ) order by p.id),'[]'::jsonb),count(*)::integer
  into v_policies,v_policy_count from public.ppu_localizacoes_config p;

  v_rows_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(v_rows::text,'UTF8')),'hex');
  v_policies_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(v_policies::text,'UTF8')),'hex');

  if v_rows_sha256 <> p_expected_rows_sha256 or v_policies_sha256 <> p_expected_policies_sha256 then
    raise exception 'Baseline alterado desde a auditoria; repetir auditoria antes de capturar';
  end if;

  select s.* into v_existing from public.ppu_inventario_snapshots s
    where s.snapshot_type = 'BASELINE_LEGADO';
  if found then
    if v_existing.rows_sha256 <> v_rows_sha256 or v_existing.policies_sha256 <> v_policies_sha256 then
      raise exception 'Baseline legado já preservado e diferente do estado vigente';
    end if;
    return jsonb_build_object('status','BASELINE_REUSED','snapshot_id',v_existing.id,
      'row_count',v_existing.row_count,'policy_count',v_existing.policy_count,
      'rows_sha256',v_existing.rows_sha256,'policies_sha256',v_existing.policies_sha256,
      'observed_on',v_existing.observed_on);
  end if;

  insert into public.ppu_inventario_snapshots (
    snapshot_type,row_count,policy_count,rows_payload,policies_payload,rows_sha256,policies_sha256
  ) values (
    'BASELINE_LEGADO',v_row_count,v_policy_count,v_rows,v_policies,v_rows_sha256,v_policies_sha256
  ) returning id into v_id;
  return jsonb_build_object('status','BASELINE_CAPTURED','snapshot_id',v_id,
    'row_count',v_row_count,'policy_count',v_policy_count,
    'rows_sha256',v_rows_sha256,'policies_sha256',v_policies_sha256,'observed_on',null);
end;
$$;
revoke all on function public.sisha_capture_ppu_legacy_baseline(text,text) from public, anon, authenticated, service_role;
grant execute on function public.sisha_capture_ppu_legacy_baseline(text,text) to service_role;

-- Comparação quantitativa de duas versões, inclusive localizações excluídas e
-- quantidades não positivas. Não representa identidade serial nem prova de recebimento.
create function public.sisha_ppu_snapshot_diff(p_before uuid,p_after uuid)
returns table (
  pn text, localizacao_normalizada text,
  quantidade_anterior numeric, quantidade_nova numeric, delta numeric,
  linhas_anterior bigint, linhas_nova bigint,
  ppu_anterior boolean, ppu_novo boolean
)
language plpgsql stable security invoker set search_path = pg_catalog
as $$
declare
  v_before public.ppu_inventario_snapshots%rowtype;
  v_after public.ppu_inventario_snapshots%rowtype;
begin
  select s.* into v_before from public.ppu_inventario_snapshots s where s.id=p_before;
  if not found then raise exception 'Snapshot anterior não encontrado'; end if;
  select s.* into v_after from public.ppu_inventario_snapshots s where s.id=p_after;
  if not found then raise exception 'Snapshot posterior não encontrado'; end if;

  return query
  with a as (
    select upper(regexp_replace(btrim(x.pn),'[[:space:]]+','','g')) as p,
      coalesce(public.sisha_normalize_location(x.localizacao),'') as l,
      sum(coalesce(x.quantidade,0)) as q, count(*) as n
    from jsonb_to_recordset(v_before.rows_payload) x(pn text,localizacao text,quantidade numeric)
    group by 1,2
  ), b as (
    select upper(regexp_replace(btrim(x.pn),'[[:space:]]+','','g')) as p,
      coalesce(public.sisha_normalize_location(x.localizacao),'') as l,
      sum(coalesce(x.quantidade,0)) as q, count(*) as n
    from jsonb_to_recordset(v_after.rows_payload) x(pn text,localizacao text,quantidade numeric)
    group by 1,2
  ), c as (
    select coalesce(a.p,b.p) as p, coalesce(a.l,b.l) as l,
      coalesce(a.q,0) as qa, coalesce(b.q,0) as qb,
      coalesce(a.n,0::bigint) as na, coalesce(b.n,0::bigint) as nb
    from a full join b on a.p=b.p and a.l=b.l
  ), pa as (
    select x.localizacao_normalizada as l, (x.ativo and x.contabiliza_ppu) as allowed
    from jsonb_to_recordset(v_before.policies_payload) x(localizacao_normalizada text,ativo boolean,contabiliza_ppu boolean)
  ), pb as (
    select x.localizacao_normalizada as l, (x.ativo and x.contabiliza_ppu) as allowed
    from jsonb_to_recordset(v_after.policies_payload) x(localizacao_normalizada text,ativo boolean,contabiliza_ppu boolean)
  )
  select c.p,nullif(c.l,''),c.qa,c.qb,c.qb-c.qa,c.na,c.nb,pa.allowed,pb.allowed
    from c left join pa on pa.l=c.l left join pb on pb.l=c.l
    order by c.p,c.l;
end;
$$;
revoke all on function public.sisha_ppu_snapshot_diff(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.sisha_ppu_snapshot_diff(uuid,uuid) to service_role;

commit;

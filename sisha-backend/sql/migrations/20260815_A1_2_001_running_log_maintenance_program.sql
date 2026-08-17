-- SISHA1 V2 — A1.2 TBO / HORAS / CICLOS / NECESSIDADE PROGRAMADA
-- Data: 2026-08-15
-- Objetivo:
-- 1) importar LIVRO DOS MOTORES como histórico de utilização por aeronave;
-- 2) permitir vínculo Admin/Dono entre indicador técnico e PN/SN;
-- 3) preservar vinculações append-only e expor somente a confirmação vigente;
-- 4) preparar necessidades programadas sem misturá-las automaticamente ao Gerador.

begin;

do $check$
begin
  if to_regclass('public.aircraft_availability_snapshots') is null then
    raise exception 'A1.2: A1.1 não aplicado.';
  end if;
  if to_regclass('public.aircraft_maintenance_indicators') is null then
    raise exception 'A1.2: indicadores A1.1 ausentes.';
  end if;
  if to_regclass('public.equipamentos_serializados') is null then
    raise exception 'A1.2: Livro de Equipamentos ausente.';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'A1.2: auditoria H3/H4 ausente.';
  end if;
end
$check$;

create table if not exists public.aircraft_running_log_snapshots (
  id bigserial primary key,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  source_observed_at date not null,
  aircraft_hours numeric(14,4),
  landings numeric(14,4),
  autorotations numeric(14,4),
  rotor_stop_starts numeric(14,4),
  engine_1_hours numeric(14,4),
  engine_1_starts numeric(14,4),
  engine_1_power_turbine_cycles numeric(14,4),
  engine_1_gas_generator_cycles numeric(14,4),
  engine_2_hours numeric(14,4),
  engine_2_starts numeric(14,4),
  engine_2_power_turbine_cycles numeric(14,4),
  engine_2_gas_generator_cycles numeric(14,4),
  source_document text not null,
  source_sheet text not null,
  source_block_row integer not null check (source_block_row > 0),
  source_date_cell text,
  source_sha256 text not null,
  source_cells jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  imported_by text,
  request_id text,
  imported_at timestamptz not null default now(),
  unique (source_sha256, source_sheet, source_block_row)
);

create index if not exists idx_aircraft_running_log_current
  on public.aircraft_running_log_snapshots (aircraft_code, source_observed_at desc, imported_at desc, id desc);

alter table public.aircraft_running_log_snapshots enable row level security;

create or replace view public.v_sisha_aircraft_current_running_log
with (security_invoker = true)
as
select distinct on (r.aircraft_code)
  r.*
from public.aircraft_running_log_snapshots r
order by r.aircraft_code, r.source_observed_at desc, r.imported_at desc, r.id desc;

create table if not exists public.equipment_maintenance_binding_confirmations (
  id bigserial primary key,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  indicator_key text not null,
  source_cell text not null,
  indicator_label text not null,
  indicator_section text,
  source_indicator_id bigint references public.aircraft_maintenance_indicators(id) on delete set null,
  source_snapshot_id bigint references public.aircraft_availability_snapshots(id) on delete set null,
  source_document text,
  source_observed_at timestamptz,
  source_value_type text,
  source_value_numeric numeric,
  source_due_date date,
  source_quality_status text,

  equipment_id bigint references public.equipamentos_serializados(id) on delete set null,
  pn text not null,
  sn text,
  nomenclatura text,
  quantidade numeric(12,4) not null default 1 check (quantidade > 0),
  maintenance_action text not null check (maintenance_action in ('OVERHAUL','REPAIR','REPLACEMENT','INSPECTION','OTHER')),
  planning_enabled boolean not null default true,
  confirmation_reason text not null check (length(btrim(confirmation_reason)) >= 5),
  confirmed_by text not null,
  confirmed_role text not null check (lower(confirmed_role) in ('admin','dono')),
  request_id text,
  confirmed_at timestamptz not null default now()
);

create index if not exists idx_equipment_maintenance_binding_current
  on public.equipment_maintenance_binding_confirmations (aircraft_code, indicator_key, source_cell, confirmed_at desc, id desc);
create index if not exists idx_equipment_maintenance_binding_pn
  on public.equipment_maintenance_binding_confirmations (pn, sn);

alter table public.equipment_maintenance_binding_confirmations enable row level security;

create or replace view public.v_sisha_current_maintenance_bindings
with (security_invoker = true)
as
select distinct on (c.aircraft_code, c.indicator_key, c.source_cell)
  c.id as confirmation_id,
  c.aircraft_code,
  c.indicator_key,
  c.source_cell,
  c.indicator_label,
  c.indicator_section,
  c.source_indicator_id,
  c.source_snapshot_id,
  c.source_document,
  c.source_observed_at,
  c.source_value_type,
  c.source_value_numeric,
  c.source_due_date,
  c.source_quality_status,
  c.equipment_id,
  c.pn,
  c.sn,
  c.nomenclatura,
  c.quantidade,
  c.maintenance_action,
  c.planning_enabled,
  c.confirmation_reason,
  c.confirmed_by,
  c.confirmed_role,
  c.confirmed_at
from public.equipment_maintenance_binding_confirmations c
order by c.aircraft_code, c.indicator_key, c.source_cell, c.confirmed_at desc, c.id desc;

create or replace function public.sisha_import_aircraft_running_log_atomic(
  p_source_document text,
  p_source_sha256 text,
  p_snapshots jsonb,
  p_actor_email text default null,
  p_actor_role text default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text := lower(btrim(coalesce(p_actor_role, '')));
  v_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_row jsonb;
  v_count integer := 0;
begin
  if v_role not in ('admin','dono') then
    raise exception 'A1.2: somente Admin/Dono pode importar LIVRO DOS MOTORES.';
  end if;
  if v_email = '' then raise exception 'A1.2: ator autenticado obrigatório.'; end if;
  if length(btrim(coalesce(p_source_sha256, ''))) <> 64 then raise exception 'A1.2: SHA-256 inválido.'; end if;
  if p_snapshots is null or jsonb_typeof(p_snapshots) <> 'array' then raise exception 'A1.2: snapshots inválidos.'; end if;

  for v_row in select value from jsonb_array_elements(p_snapshots)
  loop
    if btrim(coalesce(v_row->>'aircraft_code','')) !~ '^[0-9]{4}$' then
      raise exception 'A1.2: aeronave inválida no running log.';
    end if;
    if nullif(v_row->>'source_observed_at','') is null then
      raise exception 'A1.2: data observacional obrigatória.';
    end if;

    insert into public.aircraft_running_log_snapshots (
      aircraft_code, source_observed_at,
      aircraft_hours, landings, autorotations, rotor_stop_starts,
      engine_1_hours, engine_1_starts, engine_1_power_turbine_cycles, engine_1_gas_generator_cycles,
      engine_2_hours, engine_2_starts, engine_2_power_turbine_cycles, engine_2_gas_generator_cycles,
      source_document, source_sheet, source_block_row, source_date_cell, source_sha256,
      source_cells, quality, imported_by, request_id
    ) values (
      btrim(v_row->>'aircraft_code'), (v_row->>'source_observed_at')::date,
      nullif(v_row->>'aircraft_hours','')::numeric,
      nullif(v_row->>'landings','')::numeric,
      nullif(v_row->>'autorotations','')::numeric,
      nullif(v_row->>'rotor_stop_starts','')::numeric,
      nullif(v_row->>'engine_1_hours','')::numeric,
      nullif(v_row->>'engine_1_starts','')::numeric,
      nullif(v_row->>'engine_1_power_turbine_cycles','')::numeric,
      nullif(v_row->>'engine_1_gas_generator_cycles','')::numeric,
      nullif(v_row->>'engine_2_hours','')::numeric,
      nullif(v_row->>'engine_2_starts','')::numeric,
      nullif(v_row->>'engine_2_power_turbine_cycles','')::numeric,
      nullif(v_row->>'engine_2_gas_generator_cycles','')::numeric,
      coalesce(nullif(btrim(p_source_document),''),'LIVRO DOS MOTORES.xlsx'),
      coalesce(nullif(btrim(v_row->>'source_sheet'),''), btrim(v_row->>'aircraft_code')),
      (v_row->>'source_block_row')::integer,
      nullif(btrim(v_row->>'source_date_cell'),''),
      lower(btrim(p_source_sha256)),
      case when jsonb_typeof(v_row->'source_cells')='object' then v_row->'source_cells' else '{}'::jsonb end,
      case when jsonb_typeof(v_row->'quality')='object' then v_row->'quality' else '{}'::jsonb end,
      v_email,
      nullif(btrim(coalesce(p_request_id,'')),'')
    )
    on conflict (source_sha256, source_sheet, source_block_row) do update set
      source_observed_at = excluded.source_observed_at,
      aircraft_hours = excluded.aircraft_hours,
      landings = excluded.landings,
      autorotations = excluded.autorotations,
      rotor_stop_starts = excluded.rotor_stop_starts,
      engine_1_hours = excluded.engine_1_hours,
      engine_1_starts = excluded.engine_1_starts,
      engine_1_power_turbine_cycles = excluded.engine_1_power_turbine_cycles,
      engine_1_gas_generator_cycles = excluded.engine_1_gas_generator_cycles,
      engine_2_hours = excluded.engine_2_hours,
      engine_2_starts = excluded.engine_2_starts,
      engine_2_power_turbine_cycles = excluded.engine_2_power_turbine_cycles,
      engine_2_gas_generator_cycles = excluded.engine_2_gas_generator_cycles,
      source_cells = excluded.source_cells,
      quality = excluded.quality,
      imported_by = excluded.imported_by,
      request_id = excluded.request_id,
      imported_at = now();
    v_count := v_count + 1;
  end loop;

  insert into public.system_audit_logs(actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility)
  values (
    v_email, v_role, 'IMPORT_AIRCRAFT_RUNNING_LOG', 'AIRCRAFT_RUNNING_LOG', lower(btrim(p_source_sha256)),
    format('LIVRO DOS MOTORES importado: %s snapshot(s).', v_count),
    jsonb_build_object('source_document', p_source_document, 'source_sha256', lower(btrim(p_source_sha256)), 'snapshots', v_count, 'request_id', p_request_id),
    'INFO', 'GOD'
  );

  return jsonb_build_object('snapshots', v_count, 'source_sha256', lower(btrim(p_source_sha256)));
end;
$function$;

create or replace function public.sisha_confirm_maintenance_binding_atomic(
  p_aircraft_code text,
  p_indicator_key text,
  p_source_cell text,
  p_pn text,
  p_sn text default null,
  p_quantity numeric default 1,
  p_maintenance_action text default 'OVERHAUL',
  p_planning_enabled boolean default true,
  p_confirmation_reason text default null,
  p_actor_email text default null,
  p_actor_role text default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_aircraft text := upper(btrim(coalesce(p_aircraft_code,'')));
  v_key text := btrim(coalesce(p_indicator_key,''));
  v_cell text := upper(btrim(coalesce(p_source_cell,'')));
  v_pn text := upper(regexp_replace(btrim(coalesce(p_pn,'')), '\s+', '', 'g'));
  v_sn text := nullif(upper(regexp_replace(btrim(coalesce(p_sn,'')), '\s+', '', 'g')), '');
  v_action text := upper(btrim(coalesce(p_maintenance_action,'OVERHAUL')));
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_indicator record;
  v_equipment_id bigint;
  v_equipment_nomenclatura text;
  v_match_count integer := 0;
  v_confirmation_id bigint;
begin
  if v_role not in ('admin','dono') then raise exception 'A1.2: somente Admin/Dono pode confirmar vínculo.'; end if;
  if v_email = '' then raise exception 'A1.2: ator autenticado obrigatório.'; end if;
  if v_aircraft !~ '^[0-9]{4}$' then raise exception 'A1.2: aeronave inválida.'; end if;
  if v_key = '' or v_cell = '' then raise exception 'A1.2: indicador/célula obrigatórios.'; end if;
  if v_pn = '' then raise exception 'A1.2: PN obrigatório.'; end if;
  if coalesce(p_quantity,0) <= 0 then raise exception 'A1.2: quantidade deve ser maior que zero.'; end if;
  if v_action not in ('OVERHAUL','REPAIR','REPLACEMENT','INSPECTION','OTHER') then raise exception 'A1.2: ação de manutenção inválida.'; end if;
  if length(btrim(coalesce(p_confirmation_reason,''))) < 5 then raise exception 'A1.2: motivo da vinculação obrigatório.'; end if;

  select * into v_indicator
  from public.v_sisha_aircraft_current_maintenance_indicators i
  where i.aircraft_code = v_aircraft
    and i.indicator_key = v_key
    and upper(i.source_cell) = v_cell
  limit 1;
  if not found then raise exception 'A1.2: indicador atual não encontrado; atualize a fonte antes de vincular.'; end if;

  if v_sn is not null then
    select count(*) into v_match_count
    from public.equipamentos_serializados e
    where upper(regexp_replace(btrim(coalesce(e.pn,'')), '\s+', '', 'g')) = v_pn
      and upper(regexp_replace(btrim(coalesce(e.sn,'')), '\s+', '', 'g')) = v_sn
      and coalesce(e.ativo,true)=true;
    if v_match_count <> 1 then
      raise exception 'A1.2: PN+SN deve resolver exatamente um equipamento ativo; encontrado %.', v_match_count;
    end if;
    select e.id, e.nomenclatura into v_equipment_id, v_equipment_nomenclatura
    from public.equipamentos_serializados e
    where upper(regexp_replace(btrim(coalesce(e.pn,'')), '\s+', '', 'g')) = v_pn
      and upper(regexp_replace(btrim(coalesce(e.sn,'')), '\s+', '', 'g')) = v_sn
      and coalesce(e.ativo,true)=true
    limit 1;
  end if;

  insert into public.equipment_maintenance_binding_confirmations (
    aircraft_code, indicator_key, source_cell, indicator_label, indicator_section,
    source_indicator_id, source_snapshot_id, source_document, source_observed_at,
    source_value_type, source_value_numeric, source_due_date, source_quality_status,
    equipment_id, pn, sn, nomenclatura, quantidade, maintenance_action, planning_enabled,
    confirmation_reason, confirmed_by, confirmed_role, request_id
  ) values (
    v_aircraft, v_key, v_cell, v_indicator.label, v_indicator.section,
    v_indicator.id, v_indicator.snapshot_id, v_indicator.source_document, v_indicator.source_observed_at,
    v_indicator.value_type, v_indicator.value_numeric, v_indicator.due_date, v_indicator.quality_status,
    v_equipment_id, v_pn, v_sn, v_equipment_nomenclatura, p_quantity, v_action, coalesce(p_planning_enabled,true),
    btrim(p_confirmation_reason), v_email, v_role, nullif(btrim(coalesce(p_request_id,'')),'')
  ) returning id into v_confirmation_id;

  insert into public.system_audit_logs(actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility)
  values (
    v_email, v_role, 'CONFIRM_MAINTENANCE_BINDING', 'MAINTENANCE_BINDING', v_confirmation_id::text,
    format('Indicador %s/%s vinculado ao PN %s%s.', v_aircraft, v_key, v_pn, case when v_sn is not null then ' SN '||v_sn else '' end),
    jsonb_build_object(
      'confirmation_id', v_confirmation_id, 'aircraft_code', v_aircraft, 'indicator_key', v_key, 'source_cell', v_cell,
      'pn', v_pn, 'sn', v_sn, 'equipment_id', v_equipment_id, 'quantity', p_quantity,
      'maintenance_action', v_action, 'planning_enabled', coalesce(p_planning_enabled,true),
      'confirmation_reason', btrim(p_confirmation_reason), 'request_id', p_request_id
    ),
    'INFO', 'GOD'
  );

  return jsonb_build_object(
    'confirmation_id', v_confirmation_id, 'aircraft_code', v_aircraft, 'indicator_key', v_key, 'source_cell', v_cell,
    'pn', v_pn, 'sn', v_sn, 'equipment_id', v_equipment_id, 'quantity', p_quantity,
    'maintenance_action', v_action, 'planning_enabled', coalesce(p_planning_enabled,true)
  );
end;
$function$;

revoke all on table public.aircraft_running_log_snapshots from public, anon, authenticated;
grant select, insert, update on table public.aircraft_running_log_snapshots to service_role;
revoke all on sequence public.aircraft_running_log_snapshots_id_seq from public, anon, authenticated;
grant usage, select on sequence public.aircraft_running_log_snapshots_id_seq to service_role;
revoke all on table public.v_sisha_aircraft_current_running_log from public, anon, authenticated;
grant select on table public.v_sisha_aircraft_current_running_log to service_role;

revoke all on table public.equipment_maintenance_binding_confirmations from public, anon, authenticated;
grant select, insert on table public.equipment_maintenance_binding_confirmations to service_role;
revoke all on sequence public.equipment_maintenance_binding_confirmations_id_seq from public, anon, authenticated;
grant usage, select on sequence public.equipment_maintenance_binding_confirmations_id_seq to service_role;
revoke all on table public.v_sisha_current_maintenance_bindings from public, anon, authenticated;
grant select on table public.v_sisha_current_maintenance_bindings to service_role;

revoke all on function public.sisha_import_aircraft_running_log_atomic(text,text,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.sisha_import_aircraft_running_log_atomic(text,text,jsonb,text,text,text) to service_role;
revoke all on function public.sisha_confirm_maintenance_binding_atomic(text,text,text,text,text,numeric,text,boolean,text,text,text,text) from public, anon, authenticated;
grant execute on function public.sisha_confirm_maintenance_binding_atomic(text,text,text,text,text,numeric,text,boolean,text,text,text,text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260815_A1_2_001',
  'A1.2: LIVRO DOS MOTORES histórico + vínculo Admin/Dono de TBO/horas/ciclos a PN/SN + base de necessidades programadas seletivas.'
)
on conflict (version) do update set description = excluded.description;

commit;

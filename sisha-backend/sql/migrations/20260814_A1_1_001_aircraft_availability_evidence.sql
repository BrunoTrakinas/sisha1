-- SISHA1 V2 — A1.1 DISPONIBILIDADE / EVIDÊNCIA OPERACIONAL
-- Data: 2026-08-14
-- Objetivo:
--   * Persistir snapshots históricos do Mapa de Disponibilidade por aeronave.
--   * Preservar horas, situação D/I, motivo e motores como evidência rastreável.
--   * Preservar indicadores técnicos (horas/ciclos/datas/TBO) com célula/origem.
--   * Habilitar a regra MT aditiva somente quando houver evidência estruturada de ANV I.
--
-- Segurança:
--   * server-only; browser roles não acessam diretamente as tabelas/views/RPC.
--   * importação em uma única função transacional com auditoria obrigatória.
--   * reimportar o MESMO arquivo (mesmo SHA-256) atualiza apenas a interpretação
--     daquele mesmo snapshot; não cria duplicidade histórica.

begin;

do $check$
begin
  if to_regclass('public.sisha_schema_migrations') is null then
    raise exception 'A1.1: registry public.sisha_schema_migrations ausente. Aplique H4B antes.';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'A1.1: public.system_audit_logs ausente. H3/H4 de auditoria precisa estar aplicado.';
  end if;
end
$check$;

create table if not exists public.aircraft_availability_snapshots (
  id bigserial primary key,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  status text not null default 'UNKNOWN' check (status in ('D', 'I', 'UNKNOWN')),
  reason text,
  aircraft_hours numeric(14,4),
  last_flight_date date,
  last_frv text,
  source_observed_at timestamptz,
  engine_1_sn text,
  engine_1_hours numeric(14,4),
  engine_2_sn text,
  engine_2_hours numeric(14,4),
  source_document text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-fA-F]{64}$'),
  source_sheet text not null,
  quality_summary jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  imported_by text,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_sha256, aircraft_code)
);

create table if not exists public.aircraft_maintenance_indicators (
  id bigserial primary key,
  snapshot_id bigint not null references public.aircraft_availability_snapshots(id) on delete cascade,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  section text not null,
  label text not null,
  indicator_key text not null,
  value_type text not null check (value_type in (
    'HOURS_REMAINING',
    'CYCLES_REMAINING',
    'DUE_DATE',
    'TBO_HOURS_REMAINING',
    'TBO_DUE_DATE',
    'NUMERIC',
    'TEXT',
    'ERROR'
  )),
  value_numeric numeric(18,4),
  value_text text,
  due_date date,
  unit text,
  source_cell text not null,
  raw_value text,
  raw_format text,
  quality_status text not null default 'WARNING' check (quality_status in ('VALID', 'WARNING', 'ERROR')),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (snapshot_id, source_cell, indicator_key)
);

create index if not exists idx_aircraft_availability_aircraft_observed
  on public.aircraft_availability_snapshots (aircraft_code, source_observed_at desc, imported_at desc);

create index if not exists idx_aircraft_availability_status
  on public.aircraft_availability_snapshots (status, aircraft_code);

create index if not exists idx_aircraft_maintenance_current_lookup
  on public.aircraft_maintenance_indicators (aircraft_code, indicator_key, quality_status);

create index if not exists idx_aircraft_maintenance_due_date
  on public.aircraft_maintenance_indicators (due_date)
  where due_date is not null;

alter table public.aircraft_availability_snapshots enable row level security;
alter table public.aircraft_maintenance_indicators enable row level security;

create or replace view public.v_sisha_aircraft_current_availability
with (security_invoker = true)
as
select distinct on (s.aircraft_code)
  s.id as snapshot_id,
  s.aircraft_code,
  s.status,
  s.reason,
  s.aircraft_hours,
  s.last_flight_date,
  s.last_frv,
  s.source_observed_at,
  s.engine_1_sn,
  s.engine_1_hours,
  s.engine_2_sn,
  s.engine_2_hours,
  s.source_document,
  s.source_sha256,
  s.source_sheet,
  s.quality_summary,
  s.imported_at
from public.aircraft_availability_snapshots s
order by
  s.aircraft_code,
  coalesce(s.source_observed_at, s.imported_at) desc,
  s.imported_at desc,
  s.id desc;

create or replace view public.v_sisha_aircraft_current_maintenance_indicators
with (security_invoker = true)
as
select
  i.id,
  i.snapshot_id,
  i.aircraft_code,
  i.section,
  i.label,
  i.indicator_key,
  i.value_type,
  i.value_numeric,
  i.value_text,
  i.due_date,
  i.unit,
  i.source_cell,
  i.raw_value,
  i.raw_format,
  i.quality_status,
  s.status as aircraft_status,
  s.reason as aircraft_unavailability_reason,
  s.aircraft_hours,
  s.source_observed_at,
  s.source_document,
  s.source_sha256,
  s.imported_at
from public.aircraft_maintenance_indicators i
join public.v_sisha_aircraft_current_availability s
  on s.snapshot_id = i.snapshot_id;

create or replace function public.sisha_import_aircraft_availability_atomic(
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
  v_snapshot jsonb;
  v_indicator jsonb;
  v_snapshot_id bigint;
  v_aircraft text;
  v_status text;
  v_snapshot_count integer := 0;
  v_indicator_count integer := 0;
  v_unavailable integer := 0;
  v_available integer := 0;
  v_unknown integer := 0;
  v_details jsonb;
begin
  if nullif(btrim(coalesce(p_source_document, '')), '') is null then
    raise exception 'A1.1: documento-fonte é obrigatório.';
  end if;
  if coalesce(p_source_sha256, '') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'A1.1: SHA-256 do documento é inválido.';
  end if;
  if p_snapshots is null or jsonb_typeof(p_snapshots) <> 'array' or jsonb_array_length(p_snapshots) = 0 then
    raise exception 'A1.1: nenhum snapshot de aeronave foi informado.';
  end if;

  for v_snapshot in select value from jsonb_array_elements(p_snapshots)
  loop
    v_aircraft := btrim(coalesce(v_snapshot->>'aircraft_code', ''));
    v_status := upper(btrim(coalesce(v_snapshot->>'status', 'UNKNOWN')));

    if v_aircraft !~ '^[0-9]{4}$' then
      raise exception 'A1.1: código de aeronave inválido: %', v_aircraft;
    end if;
    if v_status not in ('D', 'I', 'UNKNOWN') then
      raise exception 'A1.1: situação inválida para aeronave %: %', v_aircraft, v_status;
    end if;

    insert into public.aircraft_availability_snapshots (
      aircraft_code,
      status,
      reason,
      aircraft_hours,
      last_flight_date,
      last_frv,
      source_observed_at,
      engine_1_sn,
      engine_1_hours,
      engine_2_sn,
      engine_2_hours,
      source_document,
      source_sha256,
      source_sheet,
      quality_summary,
      source_payload,
      imported_by,
      imported_at,
      updated_at
    ) values (
      v_aircraft,
      v_status,
      nullif(btrim(coalesce(v_snapshot->>'reason', '')), ''),
      nullif(v_snapshot->>'aircraft_hours', '')::numeric,
      nullif(v_snapshot->>'last_flight_date', '')::date,
      nullif(btrim(coalesce(v_snapshot->>'last_frv', '')), ''),
      nullif(v_snapshot->>'source_observed_at', '')::timestamptz,
      nullif(btrim(coalesce(v_snapshot->>'engine_1_sn', '')), ''),
      nullif(v_snapshot->>'engine_1_hours', '')::numeric,
      nullif(btrim(coalesce(v_snapshot->>'engine_2_sn', '')), ''),
      nullif(v_snapshot->>'engine_2_hours', '')::numeric,
      btrim(p_source_document),
      lower(p_source_sha256),
      coalesce(nullif(btrim(v_snapshot->>'source_sheet'), ''), v_aircraft),
      case when jsonb_typeof(v_snapshot->'quality') = 'object' then v_snapshot->'quality' else '{}'::jsonb end,
      v_snapshot - 'indicators',
      nullif(btrim(coalesce(p_actor_email, '')), ''),
      now(),
      now()
    )
    on conflict (source_sha256, aircraft_code) do update set
      status = excluded.status,
      reason = excluded.reason,
      aircraft_hours = excluded.aircraft_hours,
      last_flight_date = excluded.last_flight_date,
      last_frv = excluded.last_frv,
      source_observed_at = excluded.source_observed_at,
      engine_1_sn = excluded.engine_1_sn,
      engine_1_hours = excluded.engine_1_hours,
      engine_2_sn = excluded.engine_2_sn,
      engine_2_hours = excluded.engine_2_hours,
      source_document = excluded.source_document,
      source_sheet = excluded.source_sheet,
      quality_summary = excluded.quality_summary,
      source_payload = excluded.source_payload,
      imported_by = excluded.imported_by,
      updated_at = now()
    returning id into v_snapshot_id;

    delete from public.aircraft_maintenance_indicators
     where snapshot_id = v_snapshot_id;

    if jsonb_typeof(v_snapshot->'indicators') = 'array' then
      for v_indicator in select value from jsonb_array_elements(v_snapshot->'indicators')
      loop
        if nullif(btrim(coalesce(v_indicator->>'label', '')), '') is null
           or nullif(btrim(coalesce(v_indicator->>'source_cell', '')), '') is null then
          continue;
        end if;

        insert into public.aircraft_maintenance_indicators (
          snapshot_id,
          aircraft_code,
          section,
          label,
          indicator_key,
          value_type,
          value_numeric,
          value_text,
          due_date,
          unit,
          source_cell,
          raw_value,
          raw_format,
          quality_status,
          raw_payload
        ) values (
          v_snapshot_id,
          v_aircraft,
          coalesce(nullif(btrim(v_indicator->>'section'), ''), 'OUTROS'),
          btrim(v_indicator->>'label'),
          coalesce(nullif(btrim(v_indicator->>'indicator_key'), ''), btrim(v_indicator->>'source_cell')),
          coalesce(nullif(upper(btrim(v_indicator->>'value_type')), ''), 'TEXT'),
          nullif(v_indicator->>'value_numeric', '')::numeric,
          nullif(v_indicator->>'value_text', ''),
          nullif(v_indicator->>'due_date', '')::date,
          nullif(upper(btrim(coalesce(v_indicator->>'unit', ''))), ''),
          upper(btrim(v_indicator->>'source_cell')),
          nullif(v_indicator->>'raw_value', ''),
          nullif(v_indicator->>'raw_format', ''),
          coalesce(nullif(upper(btrim(v_indicator->>'quality_status')), ''), 'WARNING'),
          v_indicator
        );
        v_indicator_count := v_indicator_count + 1;
      end loop;
    end if;

    v_snapshot_count := v_snapshot_count + 1;
    if v_status = 'D' then v_available := v_available + 1;
    elsif v_status = 'I' then v_unavailable := v_unavailable + 1;
    else v_unknown := v_unknown + 1;
    end if;
  end loop;

  v_details := jsonb_build_object(
    'source_document', p_source_document,
    'source_sha256', lower(p_source_sha256),
    'snapshots', v_snapshot_count,
    'indicators', v_indicator_count,
    'available', v_available,
    'unavailable', v_unavailable,
    'unknown', v_unknown,
    'request_id', p_request_id
  );

  -- Auditoria obrigatória DENTRO da mesma transação: se falhar, tudo faz rollback.
  insert into public.system_audit_logs (
    actor_email,
    actor_role,
    action,
    entity,
    entity_id,
    summary,
    details,
    level,
    visibility
  ) values (
    nullif(lower(btrim(coalesce(p_actor_email, ''))), ''),
    nullif(lower(btrim(coalesce(p_actor_role, ''))), ''),
    'IMPORT_AIRCRAFT_AVAILABILITY',
    'AIRCRAFT_AVAILABILITY',
    left(lower(p_source_sha256), 20),
    format('Mapa de Disponibilidade importado: %s aeronaves, %s indicadores.', v_snapshot_count, v_indicator_count),
    v_details,
    'INFO',
    'GOD'
  );

  return v_details;
end;
$function$;

-- Browser nunca acessa diretamente esta evidência operacional.
revoke all on table public.aircraft_availability_snapshots from public, anon, authenticated;
revoke all on table public.aircraft_maintenance_indicators from public, anon, authenticated;
grant select, insert, update, delete on table public.aircraft_availability_snapshots to service_role;
grant select, insert, update, delete on table public.aircraft_maintenance_indicators to service_role;

revoke all on sequence public.aircraft_availability_snapshots_id_seq from public, anon, authenticated;
revoke all on sequence public.aircraft_maintenance_indicators_id_seq from public, anon, authenticated;
grant usage, select on sequence public.aircraft_availability_snapshots_id_seq to service_role;
grant usage, select on sequence public.aircraft_maintenance_indicators_id_seq to service_role;

revoke all on table public.v_sisha_aircraft_current_availability from public, anon, authenticated;
revoke all on table public.v_sisha_aircraft_current_maintenance_indicators from public, anon, authenticated;
grant select on table public.v_sisha_aircraft_current_availability to service_role;
grant select on table public.v_sisha_aircraft_current_maintenance_indicators to service_role;

revoke all on function public.sisha_import_aircraft_availability_atomic(text, text, jsonb, text, text, text) from public;
revoke all on function public.sisha_import_aircraft_availability_atomic(text, text, jsonb, text, text, text) from anon;
revoke all on function public.sisha_import_aircraft_availability_atomic(text, text, jsonb, text, text, text) from authenticated;
grant execute on function public.sisha_import_aircraft_availability_atomic(text, text, jsonb, text, text, text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260814_A1_1_001',
  'A1.1: snapshots históricos D/I + indicadores técnicos/TBO do Mapa de Disponibilidade; importação ACID server-only e auditada.'
)
on conflict (version) do update set description = excluded.description;

commit;

-- SISHA1 V2 — A1.1A VALIDAÇÃO ADMINISTRATIVA DO ESTADO OPERACIONAL
-- Evidência importada permanece imutável. Admin/Dono acrescenta confirmação histórica.

begin;

do $check$
begin
  if to_regclass('public.aircraft_availability_snapshots') is null then
    raise exception 'A1.1A: A1.1 não aplicado (aircraft_availability_snapshots ausente).';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'A1.1A: auditoria H3/H4 ausente.';
  end if;
end
$check$;

create table if not exists public.aircraft_operational_state_confirmations (
  id bigserial primary key,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  operational_state text not null check (operational_state in (
    'AVAILABLE',
    'UNAVAILABLE',
    'PRESERVED',
    'IN_INSPECTION',
    'IN_MODERNIZATION',
    'WAITING_MATERIAL',
    'OUT_OF_OPERATIONAL_FLEET',
    'TO_CONFIRM'
  )),
  operational_location text,
  admin_note text,
  mt_additive_eligible boolean not null default false,
  flight_projection_enabled boolean not null default true,
  confirmation_reason text not null check (length(btrim(confirmation_reason)) >= 5),

  -- Snapshot bruto que existia no instante da confirmação.
  source_snapshot_id bigint references public.aircraft_availability_snapshots(id) on delete set null,
  raw_status text check (raw_status is null or raw_status in ('D', 'I', 'UNKNOWN')),
  raw_reason text,
  source_document text,
  source_sha256 text,
  source_observed_at timestamptz,

  confirmed_by text not null,
  confirmed_role text not null check (lower(confirmed_role) in ('admin', 'dono')),
  request_id text,
  confirmed_at timestamptz not null default now()
);

create index if not exists idx_aircraft_operational_state_current
  on public.aircraft_operational_state_confirmations (aircraft_code, confirmed_at desc, id desc);

alter table public.aircraft_operational_state_confirmations enable row level security;

create or replace view public.v_sisha_aircraft_effective_operational_state
with (security_invoker = true)
as
with aircraft_codes as (
  select aircraft_code from public.aircraft_availability_snapshots
  union
  select aircraft_code from public.aircraft_operational_state_confirmations
),
raw_current as (
  select distinct on (s.aircraft_code)
    s.id as snapshot_id,
    s.aircraft_code,
    s.status as raw_status,
    s.reason as raw_reason,
    s.aircraft_hours,
    s.source_observed_at,
    s.source_document,
    s.source_sha256,
    s.imported_at
  from public.aircraft_availability_snapshots s
  order by s.aircraft_code, coalesce(s.source_observed_at, s.imported_at) desc, s.imported_at desc, s.id desc
),
admin_current as (
  select distinct on (c.aircraft_code)
    c.id as admin_confirmation_id,
    c.aircraft_code,
    c.operational_state as admin_operational_state,
    c.operational_location,
    c.admin_note,
    c.mt_additive_eligible,
    c.flight_projection_enabled,
    c.confirmation_reason,
    c.confirmed_by,
    c.confirmed_role,
    c.confirmed_at
  from public.aircraft_operational_state_confirmations c
  order by c.aircraft_code, c.confirmed_at desc, c.id desc
)
select
  a.aircraft_code,
  r.snapshot_id,
  r.raw_status,
  r.raw_reason,
  r.aircraft_hours,
  r.source_observed_at,
  r.source_document,
  r.source_sha256,
  c.admin_confirmation_id,
  c.admin_operational_state,
  c.operational_location,
  c.admin_note,
  c.mt_additive_eligible,
  c.flight_projection_enabled,
  c.confirmation_reason,
  c.confirmed_by,
  c.confirmed_role,
  c.confirmed_at
from aircraft_codes a
left join raw_current r on r.aircraft_code = a.aircraft_code
left join admin_current c on c.aircraft_code = a.aircraft_code;

create or replace function public.sisha_confirm_aircraft_operational_state_atomic(
  p_aircraft_code text,
  p_operational_state text,
  p_operational_location text default null,
  p_admin_note text default null,
  p_mt_additive_eligible boolean default false,
  p_flight_projection_enabled boolean default true,
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
  v_aircraft text := upper(btrim(coalesce(p_aircraft_code, '')));
  v_state text := upper(btrim(coalesce(p_operational_state, '')));
  v_role text := lower(btrim(coalesce(p_actor_role, '')));
  v_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_snapshot public.aircraft_availability_snapshots%rowtype;
  v_confirmation_id bigint;
  v_details jsonb;
begin
  if v_aircraft !~ '^[0-9]{4}$' then
    raise exception 'A1.1A: aeronave inválida.';
  end if;
  if v_state not in ('AVAILABLE','UNAVAILABLE','PRESERVED','IN_INSPECTION','IN_MODERNIZATION','WAITING_MATERIAL','OUT_OF_OPERATIONAL_FLEET','TO_CONFIRM') then
    raise exception 'A1.1A: estado operacional inválido.';
  end if;
  if v_role not in ('admin', 'dono') then
    raise exception 'A1.1A: somente Admin/Dono pode confirmar estado operacional.';
  end if;
  if v_email = '' then
    raise exception 'A1.1A: ator autenticado é obrigatório.';
  end if;
  if length(btrim(coalesce(p_confirmation_reason, ''))) < 5 then
    raise exception 'A1.1A: motivo da confirmação é obrigatório.';
  end if;

  select * into v_snapshot
  from public.aircraft_availability_snapshots s
  where s.aircraft_code = v_aircraft
  order by coalesce(s.source_observed_at, s.imported_at) desc, s.imported_at desc, s.id desc
  limit 1;

  insert into public.aircraft_operational_state_confirmations (
    aircraft_code,
    operational_state,
    operational_location,
    admin_note,
    mt_additive_eligible,
    flight_projection_enabled,
    confirmation_reason,
    source_snapshot_id,
    raw_status,
    raw_reason,
    source_document,
    source_sha256,
    source_observed_at,
    confirmed_by,
    confirmed_role,
    request_id
  ) values (
    v_aircraft,
    v_state,
    nullif(btrim(coalesce(p_operational_location, '')), ''),
    nullif(btrim(coalesce(p_admin_note, '')), ''),
    coalesce(p_mt_additive_eligible, false),
    coalesce(p_flight_projection_enabled, true),
    btrim(p_confirmation_reason),
    v_snapshot.id,
    v_snapshot.status,
    v_snapshot.reason,
    v_snapshot.source_document,
    v_snapshot.source_sha256,
    v_snapshot.source_observed_at,
    v_email,
    v_role,
    nullif(btrim(coalesce(p_request_id, '')), '')
  ) returning id into v_confirmation_id;

  v_details := jsonb_build_object(
    'confirmation_id', v_confirmation_id,
    'aircraft_code', v_aircraft,
    'operational_state', v_state,
    'mt_additive_eligible', coalesce(p_mt_additive_eligible, false),
    'flight_projection_enabled', coalesce(p_flight_projection_enabled, true),
    'raw_status', v_snapshot.status,
    'raw_reason', v_snapshot.reason,
    'source_snapshot_id', v_snapshot.id,
    'source_document', v_snapshot.source_document,
    'request_id', p_request_id
  );

  insert into public.system_audit_logs (
    actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility
  ) values (
    v_email,
    v_role,
    'CONFIRM_AIRCRAFT_OPERATIONAL_STATE',
    'AIRCRAFT_OPERATIONAL_STATE',
    v_aircraft,
    format('Estado operacional administrativo da aeronave %s confirmado como %s.', v_aircraft, v_state),
    v_details || jsonb_build_object('confirmation_reason', btrim(p_confirmation_reason)),
    'INFO',
    'GOD'
  );

  return v_details;
end;
$function$;

revoke all on table public.aircraft_operational_state_confirmations from public, anon, authenticated;
grant select, insert on table public.aircraft_operational_state_confirmations to service_role;

revoke all on sequence public.aircraft_operational_state_confirmations_id_seq from public, anon, authenticated;
grant usage, select on sequence public.aircraft_operational_state_confirmations_id_seq to service_role;

revoke all on table public.v_sisha_aircraft_effective_operational_state from public, anon, authenticated;
grant select on table public.v_sisha_aircraft_effective_operational_state to service_role;

revoke all on function public.sisha_confirm_aircraft_operational_state_atomic(text,text,text,text,boolean,boolean,text,text,text,text) from public, anon, authenticated;
grant execute on function public.sisha_confirm_aircraft_operational_state_atomic(text,text,text,text,boolean,boolean,text,text,text,text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260814_A1_1A_001',
  'A1.1A: confirmações administrativas append-only do estado operacional da frota; evidência bruta preservada; MT e projeção passam a respeitar decisão humana auditada.'
)
on conflict (version) do update set description = excluded.description;

commit;

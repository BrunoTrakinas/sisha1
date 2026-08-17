-- SISHA1 V2 — A3 MOTOR DE CONFIABILIDADE
-- Data: 2026-08-15
-- Objetivo:
-- 1) consolidar ciclos fechados do A2 sem reescrever a evidência operacional;
-- 2) confirmar leituras de utilização e relógio técnico de reparo de forma append-only;
-- 3) separar MTTR técnico de TAT;
-- 4) registrar resultado REPAIRED/NFF/IRREPARABLE, reparador e fabricante quando comprovados;
-- 5) habilitar MTBF, MTBUR, TAT, NFF e repeat removal sem antecipar previsão/prescrição do A4.

begin;

do $check$
begin
  if to_regclass('public.equipment_operational_intervals') is null then
    raise exception 'A3: A2 não aplicado; equipment_operational_intervals ausente.';
  end if;
  if to_regclass('public.aircraft_running_log_snapshots') is null then
    raise exception 'A3: A1.2 não aplicado; aircraft_running_log_snapshots ausente.';
  end if;
  if to_regclass('public.equipamentos_serializados') is null then
    raise exception 'A3: Livro de Equipamentos ausente.';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'A3: auditoria H3/H4 ausente.';
  end if;
  if to_regclass('public.sisha_schema_migrations') is null then
    raise exception 'A3: ledger de migrations ausente.';
  end if;
end
$check$;

create table if not exists public.equipment_reliability_cycle_confirmations (
  id bigserial primary key,
  interval_id bigint not null references public.equipment_operational_intervals(id) on delete restrict,
  equipment_id bigint not null references public.equipamentos_serializados(id) on delete restrict,
  pn text not null,
  sn text not null,
  aircraft_code text not null,
  position_code text not null,
  usage_counter text not null,
  usage_metric text,
  installed_at timestamptz not null,
  removed_at timestamptz not null,
  removal_reason text,
  failure_status text not null,
  test_result text,

  usage_start_value numeric,
  usage_end_value numeric,
  usage_delta numeric check (usage_delta is null or usage_delta >= 0),
  usage_unit text check (usage_unit is null or usage_unit in ('HOURS','CYCLES','CALENDAR_DAYS')),
  usage_source text check (usage_source is null or usage_source in ('ADMIN_CONFIRMED','A2_TIMESTAMPS')),

  technical_result text check (technical_result is null or technical_result in ('REPAIRED','NFF','IRREPARABLE')),
  repair_started_at timestamptz,
  repair_completed_at timestamptz,
  available_at timestamptz,
  repairer text,
  manufacturer text,
  source_document text,
  confirmation_reason text not null,

  confirmed_by text not null,
  confirmed_role text not null,
  confirmed_at timestamptz not null default now(),
  request_id text,
  operation_id uuid not null,

  check ((repair_started_at is null and repair_completed_at is null) or (repair_started_at is not null and repair_completed_at is not null)),
  check (repair_completed_at is null or repair_completed_at >= repair_started_at),
  check (repair_started_at is null or repair_started_at >= removed_at),
  check (available_at is null or available_at >= removed_at),
  check (available_at is null or repair_completed_at is null or available_at >= repair_completed_at)
);

create unique index if not exists uq_equipment_reliability_cycle_confirmation_operation
  on public.equipment_reliability_cycle_confirmations(operation_id);
create index if not exists idx_equipment_reliability_cycle_confirmation_interval
  on public.equipment_reliability_cycle_confirmations(interval_id, confirmed_at desc);
create index if not exists idx_equipment_reliability_cycle_confirmation_identity
  on public.equipment_reliability_cycle_confirmations(pn, sn, confirmed_at desc);
create index if not exists idx_equipment_reliability_cycle_confirmation_aircraft
  on public.equipment_reliability_cycle_confirmations(aircraft_code, confirmed_at desc);

alter table public.equipment_reliability_cycle_confirmations enable row level security;

create or replace view public.v_sisha_a3_current_cycle_confirmations
with (security_invoker = true)
as
select distinct on (c.interval_id)
  c.*
from public.equipment_reliability_cycle_confirmations c
order by c.interval_id, c.confirmed_at desc, c.id desc;

create or replace function public.sisha_a3_confirm_reliability_cycle_atomic(
  p_interval_id bigint,
  p_usage_start_value numeric default null,
  p_usage_end_value numeric default null,
  p_technical_result text default null,
  p_repair_started_at timestamptz default null,
  p_repair_completed_at timestamptz default null,
  p_available_at timestamptz default null,
  p_repairer text default null,
  p_manufacturer text default null,
  p_source_document text default null,
  p_confirmation_reason text default null,
  p_operation_id uuid default null,
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
  v_interval public.equipment_operational_intervals%rowtype;
  v_existing public.equipment_reliability_cycle_confirmations%rowtype;
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_result text := nullif(upper(btrim(coalesce(p_technical_result,''))), '');
  v_repairer text := nullif(btrim(coalesce(p_repairer,'')), '');
  v_manufacturer text := nullif(btrim(coalesce(p_manufacturer,'')), '');
  v_document text := nullif(btrim(coalesce(p_source_document,'')), '');
  v_reason text := btrim(coalesce(p_confirmation_reason,''));
  v_usage_start numeric := p_usage_start_value;
  v_usage_end numeric := p_usage_end_value;
  v_usage_delta numeric;
  v_usage_unit text;
  v_usage_source text;
  v_id bigint;
begin
  if v_role not in ('admin','dono') then raise exception 'A3: somente Admin/Dono pode confirmar ciclo de confiabilidade.'; end if;
  if v_email = '' then raise exception 'A3: ator autenticado obrigatório.'; end if;
  if p_operation_id is null then raise exception 'A3: operation_id obrigatório.'; end if;
  if length(v_reason) < 5 then raise exception 'A3: motivo/evidência da confirmação é obrigatório.'; end if;
  if v_result is not null and v_result not in ('REPAIRED','NFF','IRREPARABLE') then
    raise exception 'A3: resultado técnico deve ser REPAIRED, NFF ou IRREPARABLE.';
  end if;

  select * into v_existing
    from public.equipment_reliability_cycle_confirmations
   where operation_id = p_operation_id;
  if found then
    return jsonb_build_object('idempotent', true, 'confirmation', to_jsonb(v_existing));
  end if;

  select * into v_interval
    from public.equipment_operational_intervals
   where id = p_interval_id
   for share;
  if not found then raise exception 'A3: intervalo A2 não encontrado.'; end if;
  if v_interval.removed_at is null then raise exception 'A3: somente intervalo A2 encerrado pode entrar no motor de confiabilidade.'; end if;

  if v_interval.usage_counter = 'CALENDARIO' then
    v_usage_start := 0;
    v_usage_delta := extract(epoch from (v_interval.removed_at - v_interval.installed_at)) / 86400.0;
    v_usage_end := v_usage_delta;
    v_usage_unit := 'CALENDAR_DAYS';
    v_usage_source := 'A2_TIMESTAMPS';
  elsif p_usage_start_value is null and p_usage_end_value is null then
    v_usage_start := null;
    v_usage_end := null;
    v_usage_delta := null;
    v_usage_unit := null;
    v_usage_source := null;
  else
    if p_usage_start_value is null or p_usage_end_value is null then
      raise exception 'A3: informe leitura inicial e final juntas ou deixe ambas vazias.';
    end if;
    if p_usage_start_value < 0 or p_usage_end_value < p_usage_start_value then
      raise exception 'A3: leituras de utilização inválidas; a final não pode ser menor que a inicial.';
    end if;
    v_usage_delta := p_usage_end_value - p_usage_start_value;
    v_usage_unit := case when v_interval.usage_counter in ('HORAS_DE_VOO','MOTOR_1','MOTOR_2') then 'HOURS' else 'CYCLES' end;
    v_usage_source := 'ADMIN_CONFIRMED';
  end if;

  if (p_repair_started_at is null) <> (p_repair_completed_at is null) then
    raise exception 'A3: início e conclusão do reparo técnico devem ser informados juntos.';
  end if;
  if p_repair_started_at is not null and p_repair_started_at < v_interval.removed_at then
    raise exception 'A3: reparo técnico não pode começar antes da remoção da aeronave.';
  end if;
  if p_repair_completed_at is not null and p_repair_completed_at < p_repair_started_at then
    raise exception 'A3: conclusão do reparo não pode anteceder o início.';
  end if;
  if p_available_at is not null and p_available_at < v_interval.removed_at then
    raise exception 'A3: disponibilidade não pode anteceder a remoção.';
  end if;
  if p_available_at is not null and p_repair_completed_at is not null and p_available_at < p_repair_completed_at then
    raise exception 'A3: equipamento não pode ficar disponível antes da conclusão do reparo técnico.';
  end if;

  insert into public.equipment_reliability_cycle_confirmations(
    interval_id, equipment_id, pn, sn, aircraft_code, position_code,
    usage_counter, usage_metric, installed_at, removed_at, removal_reason, failure_status, test_result,
    usage_start_value, usage_end_value, usage_delta, usage_unit, usage_source,
    technical_result, repair_started_at, repair_completed_at, available_at,
    repairer, manufacturer, source_document, confirmation_reason,
    confirmed_by, confirmed_role, request_id, operation_id
  ) values (
    v_interval.id, v_interval.equipment_id, v_interval.pn, v_interval.sn, v_interval.aircraft_code, v_interval.position_code,
    v_interval.usage_counter, v_interval.usage_metric, v_interval.installed_at, v_interval.removed_at, v_interval.removal_reason, v_interval.failure_status, v_interval.test_result,
    v_usage_start, v_usage_end, v_usage_delta, v_usage_unit, v_usage_source,
    v_result, p_repair_started_at, p_repair_completed_at, p_available_at,
    v_repairer, v_manufacturer, v_document, v_reason,
    v_email, v_role, nullif(btrim(coalesce(p_request_id,'')),''), p_operation_id
  ) returning id into v_id;

  insert into public.system_audit_logs(actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility)
  values(
    v_email, v_role, 'A3_CONFIRM_RELIABILITY_CYCLE', 'EQUIPMENT_RELIABILITY_CYCLE', v_id::text,
    format('A3: ciclo do PN %s / SN %s na aeronave %s confirmado para análise de confiabilidade.', v_interval.pn, v_interval.sn, v_interval.aircraft_code),
    jsonb_build_object(
      'confirmation_id', v_id,
      'interval_id', v_interval.id,
      'equipment_id', v_interval.equipment_id,
      'pn', v_interval.pn,
      'sn', v_interval.sn,
      'aircraft_code', v_interval.aircraft_code,
      'usage_counter', v_interval.usage_counter,
      'usage_metric', v_interval.usage_metric,
      'usage_delta', v_usage_delta,
      'usage_unit', v_usage_unit,
      'technical_result', v_result,
      'repair_started_at', p_repair_started_at,
      'repair_completed_at', p_repair_completed_at,
      'available_at', p_available_at,
      'repairer', v_repairer,
      'manufacturer', v_manufacturer,
      'source_document', v_document,
      'confirmation_reason', v_reason,
      'operation_id', p_operation_id,
      'request_id', p_request_id
    ),
    'INFO', 'GOD'
  );

  select * into v_existing
    from public.equipment_reliability_cycle_confirmations
   where id = v_id;

  return jsonb_build_object('idempotent', false, 'confirmation', to_jsonb(v_existing));
end;
$function$;

revoke all on table public.equipment_reliability_cycle_confirmations from public, anon, authenticated;
grant select, insert on table public.equipment_reliability_cycle_confirmations to service_role;
revoke all on sequence public.equipment_reliability_cycle_confirmations_id_seq from public, anon, authenticated;
grant usage, select on sequence public.equipment_reliability_cycle_confirmations_id_seq to service_role;
revoke all on table public.v_sisha_a3_current_cycle_confirmations from public, anon, authenticated;
grant select on table public.v_sisha_a3_current_cycle_confirmations to service_role;

revoke all on function public.sisha_a3_confirm_reliability_cycle_atomic(bigint,numeric,numeric,text,timestamptz,timestamptz,timestamptz,text,text,text,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.sisha_a3_confirm_reliability_cycle_atomic(bigint,numeric,numeric,text,timestamptz,timestamptz,timestamptz,text,text,text,text,uuid,text,text,text) to service_role;

insert into public.sisha_schema_migrations(version,description)
values('20260815_A3_001','A3: motor de confiabilidade MTBF/MTBUR/MTTR/TAT/NFF/repeat removal com confirmação append-only e sem previsão A4.')
on conflict(version) do update set description=excluded.description;

commit;
